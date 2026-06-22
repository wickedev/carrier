// Package mcp is a minimal, stdlib-only Model Context Protocol (MCP) client.
//
// It speaks JSON-RPC 2.0 over a pluggable Transport and adapts the MCP tools a
// server advertises into Carrier tool.Tool values, namespaced as
// mcp__<server>__<tool>. The implementation deliberately avoids any third-party
// SDK: only the Go standard library is used.
//
// Two transports ship today:
//
//   - StdioTransport spawns an MCP server subprocess and frames newline-delimited
//     JSON-RPC messages over its stdin/stdout.
//   - InProcessTransport links a pair of channels to an in-process Handler, used
//     for first-party servers and tests.
//
// TODO(http): a streamable-HTTP transport (Req 11.1) is not yet implemented.
// It would satisfy the same Transport interface, POSTing requests and reading
// the SSE/streamable response body, and slot in transparently below Client.
package mcp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
)

// Transport is the byte-level carrier for JSON-RPC frames. Each Send transmits
// one complete JSON-RPC message; each Recv returns the next complete message.
// Framing (e.g. newline-delimited JSON) is the Transport's concern.
type Transport interface {
	// Send transmits one JSON-RPC frame. req must be a single complete message
	// without a trailing newline; the Transport adds whatever framing it needs.
	Send(req []byte) error
	// Recv blocks until the next complete JSON-RPC frame is available, returning
	// it without framing bytes. It returns io.EOF when the peer closes.
	Recv() ([]byte, error)
	// Close releases the transport's resources and unblocks any pending Recv.
	Close() error
}

// ErrClosed is returned by a Transport once it has been closed.
var ErrClosed = errors.New("mcp: transport closed")

// StdioTransport runs an MCP server as a subprocess and exchanges
// newline-delimited JSON-RPC messages over its stdin/stdout. The subprocess's
// stderr is left attached to the caller's choice (see StdioConfig).
type StdioTransport struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	stdoutC io.Closer

	mu     sync.Mutex
	closed bool
}

// StdioConfig configures a subprocess MCP server.
type StdioConfig struct {
	Command string    // executable to run
	Args    []string  // arguments
	Env     []string  // extra environment (appended to the current env); nil → inherit
	Stderr  io.Writer // where the subprocess's stderr goes; nil → discarded
}

// NewStdioTransport spawns the configured subprocess and returns a Transport
// framed over its stdio. The caller must Close the transport to reap the child.
func NewStdioTransport(ctx context.Context, cfg StdioConfig) (*StdioTransport, error) {
	if cfg.Command == "" {
		return nil, errors.New("mcp: stdio transport requires a command")
	}
	cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
	if cfg.Env != nil {
		cmd.Env = append(cmd.Environ(), cfg.Env...)
	}
	cmd.Stderr = cfg.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	return &StdioTransport{
		cmd:     cmd,
		stdin:   stdin,
		stdout:  bufio.NewReader(stdout),
		stdoutC: stdout,
	}, nil
}

// Send writes one newline-delimited JSON-RPC frame to the subprocess stdin.
func (t *StdioTransport) Send(req []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return ErrClosed
	}
	if _, err := t.stdin.Write(req); err != nil {
		return err
	}
	_, err := t.stdin.Write([]byte{'\n'})
	return err
}

// Recv reads the next newline-delimited JSON-RPC frame from the subprocess.
func (t *StdioTransport) Recv() ([]byte, error) {
	line, err := t.stdout.ReadBytes('\n')
	if len(line) > 0 {
		// Strip the trailing newline (and a possible CR) before returning.
		n := len(line)
		for n > 0 && (line[n-1] == '\n' || line[n-1] == '\r') {
			n--
		}
		return line[:n], nil
	}
	if err == nil {
		err = io.EOF
	}
	return nil, err
}

// Close terminates the subprocess and releases its pipes.
func (t *StdioTransport) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.mu.Unlock()

	_ = t.stdin.Close()
	_ = t.stdoutC.Close()
	if t.cmd.Process != nil {
		_ = t.cmd.Process.Kill()
	}
	_ = t.cmd.Wait()
	return nil
}

// Handler answers a single JSON-RPC request frame, returning the response frame
// to send back. Returning a nil response with a nil error means the request was
// a notification (no reply). It is the in-process analogue of a server.
type Handler func(req []byte) (resp []byte, err error)

// InProcessTransport links a Client to an in-process Handler over channels. No
// subprocess, no serialization beyond JSON — used for first-party servers and
// tests. It is safe for the Client's single-goroutine request/response loop.
type InProcessTransport struct {
	handler Handler

	mu     sync.Mutex
	inbox  chan []byte
	closed bool
	done   chan struct{}
}

// NewInProcessTransport returns a Transport that dispatches each sent frame to h
// and queues h's response for the next Recv.
func NewInProcessTransport(h Handler) *InProcessTransport {
	return &InProcessTransport{
		handler: h,
		inbox:   make(chan []byte, 16),
		done:    make(chan struct{}),
	}
}

// Send hands the frame to the handler and enqueues any response for Recv.
func (t *InProcessTransport) Send(req []byte) error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return ErrClosed
	}
	t.mu.Unlock()

	// Copy: the caller may reuse its buffer once Send returns.
	cp := make([]byte, len(req))
	copy(cp, req)

	resp, err := t.handler(cp)
	if err != nil {
		return err
	}
	if resp == nil {
		// Notification: no reply to enqueue.
		return nil
	}
	select {
	case t.inbox <- resp:
		return nil
	case <-t.done:
		return ErrClosed
	}
}

// Recv returns the next queued handler response.
func (t *InProcessTransport) Recv() ([]byte, error) {
	select {
	case b := <-t.inbox:
		return b, nil
	case <-t.done:
		// Drain any still-queued frame before reporting EOF.
		select {
		case b := <-t.inbox:
			return b, nil
		default:
			return nil, io.EOF
		}
	}
}

// Close unblocks any pending Recv and rejects further Sends.
func (t *InProcessTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	close(t.done)
	return nil
}
