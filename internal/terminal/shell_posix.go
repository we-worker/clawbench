//go:build !windows

package terminal

import (
	"os/exec"
	"syscall"
)

// setupProcessGroup sets the command to run in its own process group
// so the entire group can be killed on cleanup.
func setupProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
}

// killProcessGroupSig sends a signal to the process group of the given command.
func killProcessGroupSig(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd == nil || cmd.Process == nil {
		return
	}

	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		cmd.Process.Signal(sig)
		return
	}

	if err := syscall.Kill(-pgid, sig); err != nil {
		cmd.Process.Signal(sig)
	}
}
