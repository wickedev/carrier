//go:build unix

package bay

import (
	"os/exec"
	"syscall"
	"time"
)

// setPgid places the child in its own process group so the whole group can be
// signalled at once (children included).
func setPgid(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killGroup terminates the child's process group: SIGTERM, a short grace
// period, then SIGKILL. Signalling the negative PID targets the whole group.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid := cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	time.Sleep(killGrace)
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}
