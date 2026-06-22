package bay

import (
	"context"
	"errors"
	"os/exec"
	"time"
)

// NetworkPolicy controls outbound network for a confined exec.
type NetworkPolicy int

const (
	NetNone       NetworkPolicy = iota // no network
	NetRestricted                      // loopback / proxy only
	NetFull                            // unrestricted
)

// ExecSpec describes a single confined command execution. Argv is the command
// (already including any program + args); the Executor is responsible for any
// sandbox wrapping. ReadRoots/WriteRoots/Network are confinement hints honored
// by isolating executors and ignored by LocalExecutor.
type ExecSpec struct {
	Argv       []string
	Cwd        string
	Env        []string
	ReadRoots  []string
	WriteRoots []string
	Network    NetworkPolicy
	MaxOutput  int           // byte cap per stream (0 → default)
	Timeout    time.Duration // wall-clock cap (0 → default)
}

// ExecResult is the outcome of an ExecSpec. A timeout is reported as a result
// (TimedOut=true), not a Go error; a Go error is returned only for failures to
// run the command at all.
type ExecResult struct {
	Stdout          string
	Stderr          string
	ExitCode        int
	TimedOut        bool
	OutputTruncated bool
}

// Executor runs commands in some confinement. Implementations range from a bare
// LocalExecutor (no isolation) through OS-sandboxed (Seatbelt / bubblewrap) to
// remote (container / microVM) backends. Tools MUST route command execution
// through an Executor rather than calling os/exec directly, so confinement is a
// single swappable boundary.
type Executor interface {
	Exec(ctx context.Context, spec ExecSpec) (ExecResult, error)
	Close() error
}

const (
	defaultMaxOutput = 1 << 20 // 1 MiB per stream
	defaultTimeout   = 2 * time.Minute
	killGrace        = 200 * time.Millisecond
)

// LocalExecutor runs commands directly on the host with NO isolation, applying
// only an output cap, a timeout, and process-group termination. It is the
// baseline backend and the building block that OS-sandbox executors wrap (they
// prepend a sandbox prefix to Argv and reuse runConfined). Do not expose it to
// untrusted input in production — use an isolating Executor.
type LocalExecutor struct{}

// NewLocalExecutor returns a non-isolating host executor.
func NewLocalExecutor() *LocalExecutor { return &LocalExecutor{} }

// Close implements Executor.
func (e *LocalExecutor) Close() error { return nil }

// Exec implements Executor.
func (e *LocalExecutor) Exec(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	return runConfined(ctx, spec.Argv, spec)
}

// runConfined executes argv (already wrapped by any sandbox prefix) with output
// caps, a timeout, and process-group kill. Shared by every host-side executor.
func runConfined(ctx context.Context, argv []string, spec ExecSpec) (ExecResult, error) {
	if len(argv) == 0 {
		return ExecResult{}, errors.New("bay: empty argv")
	}
	maxOut := spec.MaxOutput
	if maxOut <= 0 {
		maxOut = defaultMaxOutput
	}
	timeout := spec.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = spec.Cwd
	cmd.Env = spec.Env
	setPgid(cmd) // OS-specific: place the child in its own process group

	out := &cappedBuffer{limit: maxOut}
	errb := &cappedBuffer{limit: maxOut}
	cmd.Stdout = out
	cmd.Stderr = errb

	if err := cmd.Start(); err != nil {
		return ExecResult{}, err
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var res ExecResult
	select {
	case <-runCtx.Done():
		killGroup(cmd) // OS-specific: SIGTERM the group, grace, then SIGKILL
		<-done
		res.Stdout = out.String()
		res.Stderr = errb.String()
		res.OutputTruncated = out.truncated || errb.truncated
		res.ExitCode = -1
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			res.TimedOut = true
			return res, nil // a timeout is a result, not an error
		}
		return res, runCtx.Err() // outer ctx cancelled
	case err := <-done:
		res.Stdout = out.String()
		res.Stderr = errb.String()
		res.OutputTruncated = out.truncated || errb.truncated
		res.ExitCode = exitCode(err)
		return res, nil
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// cappedBuffer accumulates output up to limit bytes, then drops the rest and
// flags truncation. It never errors the writing process.
type cappedBuffer struct {
	buf       []byte
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if len(c.buf) >= c.limit {
		c.truncated = true
		return len(p), nil
	}
	room := c.limit - len(c.buf)
	if len(p) > room {
		c.buf = append(c.buf, p[:room]...)
		c.truncated = true
	} else {
		c.buf = append(c.buf, p...)
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string { return string(c.buf) }
