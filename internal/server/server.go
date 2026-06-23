// Package server is the HTTP + SSE surface of Carrier (Requirement 17).
//
// It lets clients create sessions, send input mid-run, and stream a session's
// events over Server-Sent Events. The server stays decoupled from how a Flight
// is built: the caller supplies a [Factory] that closes over the engine, store,
// tool registry, and executor. The server only knows how to launch a Flight on
// the Tower, fan its events out to many subscribers (the hub), replay history
// from the Store on reconnect, and isolate sessions per tenant.
//
// The transport is stdlib net/http only; there is no web framework. SSE is
// decoupled from the core by reading the Flight's event queue through the hub.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/wickedev/carrier/internal/agent"
	"github.com/wickedev/carrier/internal/flight"
	"github.com/wickedev/carrier/internal/hitl"
	"github.com/wickedev/carrier/internal/sq"
	"github.com/wickedev/carrier/internal/store"
	"github.com/wickedev/carrier/internal/tower"
)

// Factory builds a Flight for a new session from the per-session [SessionOptions]
// parsed off the create request. The caller supplies it (closing over the
// engine, store, tool registry, and executor) so the server stays decoupled from
// Flight construction. The returned Flight's ID must equal sessionID and its
// Store must be the same Store passed to [New] so history replay sees the
// session's records. The returned cleanup func (may be nil) is invoked once when
// the session's Flight ends, to release per-session resources such as MCP
// subprocesses.
type Factory func(sessionID, tenant string, opts SessionOptions) (*flight.Flight, func())

// SessionOptions is the per-session configuration parsed from the POST
// /v1/sessions body and handed to the [Factory]. It is plain data so the server
// stays decoupled from how a Flight is built; the Factory interprets it.
type SessionOptions struct {
	Cwd           string
	System        string
	Context       string // AGENTS.md-like instructions injected as durable memory
	PlanMode      bool
	Model         string
	Effort        string
	MaxSteps      int
	ContextBudget int
	Env           map[string]string
	MCPServers    []MCPServerSpec
	Skills        []SkillSpec
	Subagents     []SubagentSpec
	Hooks         []HookSpec
	Permissions   []PermissionSpec
	Plugins       []PluginRef
}

// PluginRef references an active (WASM) plugin the session should load. The
// runtime resolves the artifact by digest, verifies it, and registers its seams.
type PluginRef struct {
	Name             string
	Version          string
	ManifestDigest   string
	WasmDigest       string
	GrantedCaps      []string
	AllowPermissions bool
}

// MCPServerSpec is a per-session MCP (stdio) server registration.
type MCPServerSpec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
}

// SkillSpec is a per-session skill (name + description shown to the model, body
// loaded on demand).
type SkillSpec struct {
	Name         string
	Description  string
	Body         string
	Agent        string
	AllowedTools []string
}

// SubagentSpec is a per-session named sub-agent definition.
type SubagentSpec struct {
	Name        string
	Description string
	Prompt      string
	Model       string
}

// HookSpec is a per-session command hook bound to a lifecycle event.
type HookSpec struct {
	Name    string
	Event   string
	Command string
	Matcher string
}

// PermissionSpec is a per-session permission rule {action, pattern, effect}.
type PermissionSpec struct {
	Action  string
	Pattern string
	Effect  string
}

// Server is the HTTP + SSE surface over a Tower of Flights.
//
// It launches sessions on the Tower, records each session's owning tenant for
// isolation, and runs one fan-out hub per session that drains the Flight's
// single event channel and broadcasts to any number of SSE subscribers.
type Server struct {
	tower   *tower.Tower
	factory Factory
	store   store.Store
	tokens  map[string]string // bearer token → tenant

	// baseCtx is the parent context every launched Flight runs under; cancel it
	// (via Shutdown) to bring the Fleet to a stop for graceful teardown.
	baseCtx    context.Context
	baseCancel context.CancelFunc

	mu        sync.RWMutex
	owners    map[string]string                // session ID → owning tenant
	hubs      map[string]*hub                  // session ID → fan-out hub
	approvers map[string]*hitl.ChannelApprover // session ID → HITL approver
}

// New builds a Server. tokens maps each accepted bearer token to its tenant;
// requests with an unknown token are rejected with 401.
func New(tw *tower.Tower, factory Factory, st store.Store, tokens map[string]string) *Server {
	cp := make(map[string]string, len(tokens))
	for k, v := range tokens {
		cp[k] = v
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{
		tower:      tw,
		factory:    factory,
		store:      st,
		tokens:     cp,
		baseCtx:    ctx,
		baseCancel: cancel,
		owners:     make(map[string]string),
		hubs:       make(map[string]*hub),
		approvers:  make(map[string]*hitl.ChannelApprover),
	}
}

// Shutdown cancels every in-flight Flight and waits for the Fleet to settle, so
// no session goroutine outlives the server. It is safe to call once.
func (s *Server) Shutdown() {
	s.baseCancel()
	s.tower.Wait()
}

// Handler returns the HTTP routes for the server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions", s.handleCreate)
	mux.HandleFunc("POST /v1/sessions/{id}/input", s.handleInput)
	mux.HandleFunc("POST /v1/sessions/{id}/interrupt", s.handleInterrupt)
	mux.HandleFunc("GET /v1/sessions/{id}/events", s.handleEvents)
	mux.HandleFunc("POST /v1/sessions/{id}/approvals/{reqId}", s.handleApproval)
	return mux
}

// createResponse is the body of POST /v1/sessions.
type createResponse struct {
	SessionID string `json:"session_id"`
}

// createRequest is the (optional) body of POST /v1/sessions: the per-session
// configuration, snake-cased on the wire. An empty body yields zero options.
type createRequest struct {
	Cwd           string            `json:"cwd"`
	System        string            `json:"system"`
	PlanMode      bool              `json:"plan_mode"`
	Context       string            `json:"context"`
	Model         string            `json:"model"`
	Effort        string            `json:"effort"`
	MaxSteps      int               `json:"max_steps"`
	ContextBudget int               `json:"context_budget"`
	Env           map[string]string `json:"env"`
	MCPServers    []struct {
		Name    string            `json:"name"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	} `json:"mcp_servers"`
	Skills []struct {
		Name         string   `json:"name"`
		Description  string   `json:"description"`
		Body         string   `json:"body"`
		Agent        string   `json:"agent"`
		AllowedTools []string `json:"allowed_tools"`
	} `json:"skills"`
	Subagents []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Prompt      string `json:"prompt"`
		Model       string `json:"model"`
	} `json:"subagents"`
	Hooks []struct {
		Name    string `json:"name"`
		Event   string `json:"event"`
		Command string `json:"command"`
		Matcher string `json:"matcher"`
	} `json:"hooks"`
	Permissions []struct {
		Action  string `json:"action"`
		Pattern string `json:"pattern"`
		Effect  string `json:"effect"`
	} `json:"permissions"`
	Plugins []struct {
		Name             string   `json:"name"`
		Version          string   `json:"version"`
		ManifestDigest   string   `json:"manifest_digest"`
		WasmDigest       string   `json:"wasm_digest"`
		GrantedCaps      []string `json:"granted_caps"`
		AllowPermissions bool     `json:"allow_permissions"`
	} `json:"plugins"`
}

// toOptions projects the wire request onto the decoupled SessionOptions.
func (r *createRequest) toOptions() SessionOptions {
	opts := SessionOptions{
		Cwd:           r.Cwd,
		System:        r.System,
		Context:       r.Context,
		PlanMode:      r.PlanMode,
		Model:         r.Model,
		Effort:        r.Effort,
		MaxSteps:      r.MaxSteps,
		ContextBudget: r.ContextBudget,
		Env:           r.Env,
	}
	for _, m := range r.MCPServers {
		opts.MCPServers = append(opts.MCPServers, MCPServerSpec{
			Name: m.Name, Command: m.Command, Args: m.Args, Env: m.Env,
		})
	}
	for _, s := range r.Skills {
		opts.Skills = append(opts.Skills, SkillSpec{
			Name: s.Name, Description: s.Description, Body: s.Body,
			Agent: s.Agent, AllowedTools: s.AllowedTools,
		})
	}
	for _, a := range r.Subagents {
		opts.Subagents = append(opts.Subagents, SubagentSpec{
			Name: a.Name, Description: a.Description, Prompt: a.Prompt, Model: a.Model,
		})
	}
	for _, h := range r.Hooks {
		opts.Hooks = append(opts.Hooks, HookSpec{
			Name: h.Name, Event: h.Event, Command: h.Command, Matcher: h.Matcher,
		})
	}
	for _, p := range r.Permissions {
		opts.Permissions = append(opts.Permissions, PermissionSpec{
			Action: p.Action, Pattern: p.Pattern, Effect: p.Effect,
		})
	}
	for _, p := range r.Plugins {
		opts.Plugins = append(opts.Plugins, PluginRef{
			Name: p.Name, Version: p.Version, ManifestDigest: p.ManifestDigest,
			WasmDigest: p.WasmDigest, GrantedCaps: p.GrantedCaps,
			AllowPermissions: p.AllowPermissions,
		})
	}
	return opts
}

// inputRequest is the body of POST /v1/sessions/{id}/input.
type inputRequest struct {
	Text  string `json:"text"`
	Steer bool   `json:"steer"`
}

// eventDTO is one SSE line: a small, JSON-able projection of a StreamEvent.
type eventDTO struct {
	Seq  int    `json:"seq"`
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
	// ToolCallID and Name describe a tool call/result event.
	ToolCallID string `json:"tool_call_id,omitempty"`
	Name       string `json:"name,omitempty"`
	IsError    bool   `json:"is_error,omitempty"`
	// Approval fields (approval_request events).
	ReqID    string `json:"req_id,omitempty"`
	Tool     string `json:"tool,omitempty"`
	Resource string `json:"resource,omitempty"`
	Reason   string `json:"reason,omitempty"`
	// Usage fields (usage / step_finish events).
	InputTokens      int `json:"input_tokens,omitempty"`
	OutputTokens     int `json:"output_tokens,omitempty"`
	CacheReadTokens  int `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int `json:"cache_write_tokens,omitempty"`
	// Title is the auto-generated session title (title_suggested events).
	Title string `json:"title,omitempty"`
}

// handleCreate authenticates the caller, builds and launches a Flight, starts
// its fan-out hub, records the owning tenant, and returns the session ID.
func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	tenant, ok := s.authTenant(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unknown token")
		return
	}

	// Parse the optional per-session config. An empty body (EOF) is fine — it
	// yields zero options (a default session). A malformed body is a 400.
	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}

	sid := newSessionID()
	f, cleanup := s.factory(sid, tenant, req.toOptions())

	// Wire a human-in-the-loop approver: when an Ask-effect tool fires, surface an
	// approval_request event on the stream and block until the client answers via
	// POST /v1/sessions/{id}/approvals/{reqId}.
	approver := hitl.New(func(req hitl.Request) {
		_ = f.Queues().Emit(s.baseCtx, agent.StreamEvent{
			Kind: agent.EvApprovalRequest,
			Approval: &agent.ApprovalRequest{
				ReqID: req.ID, Tool: req.Tool, Resource: req.Resource, Reason: req.Reason,
			},
		})
	}, 10*time.Minute)
	f.SetApprover(approver)

	// Launch on the Tower under the server's base context; the Flight runs on its
	// own goroutine until the context ends (request lifetime / Shutdown).
	if err := s.tower.Launch(s.baseCtx, f); err != nil {
		writeError(w, http.StatusServiceUnavailable, "launch failed: "+err.Error())
		return
	}

	h := newHub()
	s.mu.Lock()
	s.owners[sid] = tenant
	s.hubs[sid] = h
	s.approvers[sid] = approver
	s.mu.Unlock()

	// Drain the Flight's single event channel into the hub; clean up the per-session
	// registries when the Flight ends.
	go func() {
		h.run(f.Queues().Events())
		s.mu.Lock()
		delete(s.owners, sid)
		delete(s.hubs, sid)
		delete(s.approvers, sid)
		s.mu.Unlock()
		// Release per-session resources (e.g. MCP subprocesses) once the Flight
		// has ended and its events are fully drained.
		if cleanup != nil {
			cleanup()
		}
	}()

	writeJSON(w, http.StatusOK, createResponse{SessionID: sid})
}

// handleInput authenticates and tenant-checks the caller, then submits input to
// the session's Flight (Steer when requested, otherwise Queue).
func (s *Server) handleInput(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("id")
	if _, ok := s.authorize(w, r, sid); !ok {
		return
	}

	var req inputRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}

	f, ok := s.tower.Get(sid)
	if !ok {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}

	delivery := sq.Queue
	if req.Steer {
		delivery = sq.Steer
	}
	in := sq.Input{
		Msg:      agent.Message{Role: agent.RoleUser, Text: req.Text},
		Delivery: delivery,
	}
	if err := f.Queues().Submit(r.Context(), in); err != nil {
		writeError(w, http.StatusServiceUnavailable, "submit failed: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// handleInterrupt steers the session's active turn to a stop (Req 7 interrupt).
func (s *Server) handleInterrupt(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("id")
	if _, ok := s.authorize(w, r, sid); !ok {
		return
	}
	f, ok := s.tower.Get(sid)
	if !ok {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	in := sq.Input{Msg: agent.Message{Role: agent.RoleUser, Text: "(interrupted)"}, Delivery: sq.Steer}
	if err := f.Queues().Submit(r.Context(), in); err != nil {
		writeError(w, http.StatusServiceUnavailable, "interrupt failed: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// approvalRequest is the body of POST /v1/sessions/{id}/approvals/{reqId}.
type approvalRequest struct {
	Allow bool `json:"allow"`
}

// handleApproval delivers a human approve/deny decision to the blocked
// Ask-effect tool, correlated by request ID (Req 11 / web-client task 17).
func (s *Server) handleApproval(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("id")
	if _, ok := s.authorize(w, r, sid); !ok {
		return
	}
	reqID := r.PathValue("reqId")
	var body approvalRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	s.mu.RLock()
	approver := s.approvers[sid]
	s.mu.RUnlock()
	if approver == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if !approver.Resolve(reqID, body.Allow) {
		writeError(w, http.StatusNotFound, "no pending approval for that request id")
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// handleEvents streams a session's events as SSE. It first replays the Store
// history so a (re)connecting client catches up, then streams live hub events
// until the client disconnects.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("id")
	if _, ok := s.authorize(w, r, sid); !ok {
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	s.mu.RLock()
	h := s.hubs[sid]
	s.mu.RUnlock()
	if h == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Subscribe before reading history so no live event is missed between the
	// history read and the live stream (at-least-once; the client dedupes by seq).
	sub := h.subscribe()
	defer h.unsubscribe(sub)

	// Replay history first so a reconnecting client catches up (Req 17.4).
	if recs, err := s.store.History(r.Context(), store.SessionID(sid)); err == nil {
		for _, rec := range recs {
			if !writeSSE(w, flusher, recordToDTO(rec)) {
				return
			}
		}
	}

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.ch:
			if !ok {
				return // hub closed (Flight ended)
			}
			if !writeSSE(w, flusher, eventToDTO(ev)) {
				return
			}
		}
	}
}

// authorize authenticates the request and checks tenant ownership of sid. On
// failure it writes the appropriate status (401 unknown token, 403 cross-tenant)
// and returns ok=false.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, sid string) (string, bool) {
	tenant, ok := s.authTenant(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unknown token")
		return "", false
	}
	s.mu.RLock()
	owner, known := s.owners[sid]
	s.mu.RUnlock()
	if !known {
		writeError(w, http.StatusNotFound, "session not found")
		return "", false
	}
	if owner != tenant {
		writeError(w, http.StatusForbidden, "session belongs to another tenant")
		return "", false
	}
	return tenant, true
}

// authTenant resolves the bearer token to a tenant, or ok=false if unknown.
func (s *Server) authTenant(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) <= len(prefix) || h[:len(prefix)] != prefix {
		return "", false
	}
	tenant, ok := s.tokens[h[len(prefix):]]
	return tenant, ok
}

// newSessionID returns a random, URL-safe session identifier.
func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeSSE writes one DTO as an SSE `data:` line and flushes. It returns false
// if the write failed (client gone).
func writeSSE(w http.ResponseWriter, flusher http.Flusher, dto eventDTO) bool {
	payload, err := json.Marshal(dto)
	if err != nil {
		return true // skip an unencodable event rather than tearing down the stream
	}
	if _, err := w.Write([]byte("data: ")); err != nil {
		return false
	}
	if _, err := w.Write(payload); err != nil {
		return false
	}
	if _, err := w.Write([]byte("\n\n")); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

// eventToDTO projects a live StreamEvent into the SSE DTO. Live events have no
// store seq, so Seq is left zero.
func eventToDTO(ev agent.StreamEvent) eventDTO {
	dto := eventDTO{Kind: ev.Kind.String(), Text: ev.Text}
	switch {
	case ev.ToolCall != nil:
		dto.ToolCallID = ev.ToolCall.ID
		dto.Name = ev.ToolCall.Name
	case ev.Result != nil:
		dto.ToolCallID = ev.Result.ToolCallID
		dto.IsError = ev.Result.IsError
		if dto.Text == "" {
			dto.Text = ev.Result.Content
		}
	case ev.Approval != nil:
		dto.ReqID = ev.Approval.ReqID
		dto.Tool = ev.Approval.Tool
		dto.Resource = ev.Approval.Resource
		dto.Reason = ev.Approval.Reason
	case ev.Usage != nil:
		dto.InputTokens = ev.Usage.InputTokens
		dto.OutputTokens = ev.Usage.OutputTokens
		dto.CacheReadTokens = ev.Usage.CacheReadTokens
		dto.CacheWriteTokens = ev.Usage.CacheWriteTokens
	case ev.Kind == agent.EvTitleSuggested:
		dto.Title = ev.Title
	}
	return dto
}

// recordToDTO projects a persisted Record into the SSE DTO for history replay.
// The record's Seq lets a reconnecting client dedupe against live events.
func recordToDTO(rec store.Record) eventDTO {
	dto := eventDTO{Seq: rec.Seq, Kind: string(rec.Kind), Text: rec.Text}
	if rec.ToolResult != nil {
		dto.ToolCallID = rec.ToolResult.ToolCallID
		dto.IsError = rec.ToolResult.IsError
		if dto.Text == "" {
			dto.Text = rec.ToolResult.Content
		}
	}
	return dto
}
