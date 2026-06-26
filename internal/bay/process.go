package bay

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
)

// Process is a handle to a long-running command started via Executor.Start (the
// backing of background shells). Unlike Exec it returns immediately: combined
// stdout+stderr stream into a backlog buffer the caller drains incrementally,
// stdin can be written, and the process group can be killed. Safe for concurrent
// use. Its lifetime is bounded by the context passed to Start — when that
// context is cancelled (the session ends) the process group is killed.
type Process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *streamBuffer

	mu       sync.Mutex
	finished bool
	exitCode int
	done     chan struct{}
}

// startConfined starts argv (already wrapped by any sandbox prefix) as a
// background process: own process group, combined output into a capped backlog
// buffer, an stdin pipe, and a watcher that kills the group when ctx is
// cancelled. Unlike runConfined it applies NO timeout — a background process
// runs until it exits or is killed.
func startConfined(ctx context.Context, argv []string, spec ExecSpec) (*Process, error) {
	if len(argv) == 0 {
		return nil, errors.New("bay: empty argv")
	}
	maxOut := spec.MaxOutput
	if maxOut <= 0 {
		maxOut = defaultMaxOutput
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = spec.Cwd
	cmd.Env = spec.Env
	setPgid(cmd) // own process group, so killGroup reaches children

	sb := &streamBuffer{limit: maxOut}
	cmd.Stdout = sb
	cmd.Stderr = sb

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	p := &Process{cmd: cmd, stdin: stdin, out: sb, done: make(chan struct{})}

	go func() {
		werr := cmd.Wait()
		p.mu.Lock()
		p.finished = true
		p.exitCode = exitCode(werr)
		p.mu.Unlock()
		close(p.done)
	}()

	// Reap on session end: cancelling ctx kills the group. The goroutine exits
	// either way (process finished or killed) so it never leaks.
	go func() {
		select {
		case <-ctx.Done():
			killGroup(cmd)
		case <-p.done:
		}
	}()

	return p, nil
}

// ReadNew drains and returns the output accumulated since the last ReadNew,
// whether the process is still running, and whether output was dropped to the
// backlog cap since the last read.
func (p *Process) ReadNew() (output string, running bool, truncated bool) {
	out, trunc := p.out.drain()
	p.mu.Lock()
	running = !p.finished
	p.mu.Unlock()
	return out, running, trunc
}

// WriteStdin writes s to the process's stdin. It errors if the process has
// already exited.
func (p *Process) WriteStdin(s string) error {
	p.mu.Lock()
	fin := p.finished
	p.mu.Unlock()
	if fin {
		return errors.New("process has exited")
	}
	_, err := io.WriteString(p.stdin, s)
	return err
}

// Kill terminates the process group (SIGTERM, grace, SIGKILL).
func (p *Process) Kill() { killGroup(p.cmd) }

// Status reports whether the process has exited and, if so, its exit code.
func (p *Process) Status() (finished bool, exitCode int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.finished, p.exitCode
}

// streamBuffer is a capped, drain-on-read sink for a process's combined output.
// The child's stdout+stderr append; a reader drains the backlog, so the cap
// bounds UNREAD output (a steadily-drained process never loses bytes).
type streamBuffer struct {
	mu        sync.Mutex
	buf       []byte
	limit     int
	truncated bool
}

func (s *streamBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.buf) >= s.limit {
		s.truncated = true
		return len(p), nil // never error the child
	}
	room := s.limit - len(s.buf)
	if len(p) > room {
		s.buf = append(s.buf, p[:room]...)
		s.truncated = true
	} else {
		s.buf = append(s.buf, p...)
	}
	return len(p), nil
}

// drain returns and clears the accumulated backlog, plus whether bytes were
// dropped to the cap since the last drain.
func (s *streamBuffer) drain() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := string(s.buf)
	trunc := s.truncated
	s.buf = nil
	s.truncated = false
	return out, trunc
}
