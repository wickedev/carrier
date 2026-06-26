package lsp

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"time"
)

const (
	// diagnosticsWait bounds how long Diagnostics blocks for a server to publish
	// after a document is opened/changed.
	diagnosticsWait = 3 * time.Second
	// initTimeout bounds the initialize handshake so a hung/broken server can't
	// block a tool call forever (the manager's context is session-lived).
	initTimeout = 10 * time.Second
	// callTimeout bounds a single request (e.g. hover) against a slow server.
	callTimeout = 5 * time.Second
)

// serverSpec describes how to launch a language server for a set of file types.
type serverSpec struct {
	command    string
	args       []string
	languageID string
}

// serversByExt maps a file extension to its language server. Servers are looked
// up by command, so several extensions can share one server (e.g. TS/JS).
var serversByExt = map[string]serverSpec{
	".go":   {"gopls", nil, "go"},
	".ts":   {"typescript-language-server", []string{"--stdio"}, "typescript"},
	".tsx":  {"typescript-language-server", []string{"--stdio"}, "typescriptreact"},
	".js":   {"typescript-language-server", []string{"--stdio"}, "javascript"},
	".jsx":  {"typescript-language-server", []string{"--stdio"}, "javascriptreact"},
	".py":   {"pyright-langserver", []string{"--stdio"}, "python"},
	".rs":   {"rust-analyzer", nil, "rust"},
	".rb":   {"ruby-lsp", nil, "ruby"},
	".java": {"jdtls", nil, "java"},
}

// spawn is the language-server launcher; a package var so tests can substitute a
// mock-connected client.
var spawn = Spawn

// Manager lazily spawns and reuses one language server per language for a
// session's working directory, and reaps them all on Close. Safe for concurrent
// use.
type Manager struct {
	ctx     context.Context
	root    string
	rootURI string

	mu       sync.Mutex
	servers  map[string]*Client // command → initialized client
	failed   map[string]string  // command → why it couldn't start (cached)
	versions map[string]int     // uri → last document version sent
}

// NewManager returns a manager rooted at the session working directory. Its
// servers live until ctx is cancelled or Close is called.
func NewManager(ctx context.Context, root string) *Manager {
	return &Manager{
		ctx:      ctx,
		root:     root,
		rootURI:  PathToURI(root),
		servers:  make(map[string]*Client),
		failed:   make(map[string]string),
		versions: make(map[string]int),
	}
}

// Supported reports whether a language server is configured for path's type.
func Supported(path string) bool {
	_, ok := serversByExt[filepath.Ext(path)]
	return ok
}

// serverFor returns the (lazily started, initialized) client for path's type.
func (m *Manager) serverFor(path string) (*Client, serverSpec, error) {
	spec, ok := serversByExt[filepath.Ext(path)]
	if !ok {
		return nil, spec, fmt.Errorf("no language server configured for %q", filepath.Ext(path))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.servers[spec.command]; c != nil {
		return c, spec, nil
	}
	if why := m.failed[spec.command]; why != "" {
		return nil, spec, fmt.Errorf("%s", why)
	}
	c, err := spawn(m.ctx, spec.command, spec.args...)
	if err != nil {
		why := fmt.Sprintf("language server %q is not available: %v", spec.command, err)
		m.failed[spec.command] = why
		return nil, spec, fmt.Errorf("%s", why)
	}
	// Bound the handshake: the manager's context is session-lived, so a server
	// that never answers initialize must not hang the tool call indefinitely.
	ictx, cancel := context.WithTimeout(m.ctx, initTimeout)
	defer cancel()
	if err := c.Initialize(ictx, m.rootURI); err != nil {
		_ = c.Close()
		why := fmt.Sprintf("language server %q failed to initialize: %v", spec.command, err)
		m.failed[spec.command] = why
		return nil, spec, fmt.Errorf("%s", why)
	}
	m.servers[spec.command] = c
	return c, spec, nil
}

// syncDoc makes the server's view of uri match text: a first sight is a didOpen,
// a re-sight is a didChange with a bumped version. It clears cached diagnostics
// first, and returns the version it sent so the caller can require diagnostics at
// that version or newer (rejecting a stale publish for an earlier version).
func (m *Manager) syncDoc(c *Client, uri, languageID, text string) (int, error) {
	m.mu.Lock()
	v := m.versions[uri] + 1
	m.versions[uri] = v
	m.mu.Unlock()

	c.ResetDiagnostics(uri)
	if v == 1 {
		return v, c.DidOpen(uri, languageID, text, v)
	}
	return v, c.DidChange(uri, v, text)
}

// Diagnostics syncs absPath's current text to the right server and returns the
// diagnostics it publishes. received is false when no publish arrived within the
// wait (distinct from a clean file, which is received=true with no diagnostics).
func (m *Manager) Diagnostics(ctx context.Context, absPath, text string) (diags []Diagnostic, received bool, err error) {
	c, spec, err := m.serverFor(absPath)
	if err != nil {
		return nil, false, err
	}
	uri := PathToURI(absPath)
	version, err := m.syncDoc(c, uri, spec.languageID, text)
	if err != nil {
		return nil, false, err
	}
	d, ok := c.Diagnostics(ctx, uri, version, diagnosticsWait)
	return d, ok, nil
}

// Hover returns hover text at a 0-based line/character in absPath.
func (m *Manager) Hover(ctx context.Context, absPath, text string, line, char int) (string, error) {
	c, spec, err := m.serverFor(absPath)
	if err != nil {
		return "", err
	}
	uri := PathToURI(absPath)
	if _, err := m.syncDoc(c, uri, spec.languageID, text); err != nil {
		return "", err
	}
	// Bound the request so a slow server can't hang the tool call.
	hctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return c.Hover(hctx, uri, line, char)
}

// Close shuts down every running server.
func (m *Manager) Close() {
	m.mu.Lock()
	servers := make([]*Client, 0, len(m.servers))
	for _, c := range m.servers {
		servers = append(servers, c)
	}
	m.servers = make(map[string]*Client)
	m.mu.Unlock()
	for _, c := range servers {
		_ = c.Close()
	}
}

// PathToURI converts an absolute filesystem path to a file:// URI.
func PathToURI(path string) string {
	if path == "" {
		return ""
	}
	if !filepath.IsAbs(path) {
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
	}
	return "file://" + filepath.ToSlash(path)
}
