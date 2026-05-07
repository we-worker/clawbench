//go:build windows

package terminal

import (
	"os/exec"
	"syscall"
)

// setupProcessGroup is a no-op on Windows — process groups are handled differently.
func setupProcessGroup(cmd *exec.Cmd) {
	// Windows doesn't support Setpgid. Process group cleanup
	// will use cmd.Process.Kill() as fallback.
}

// killProcessGroupSig kills the process on Windows.
// Windows doesn't have POSIX process groups, so we just kill the process.
func killProcessGroupSig(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	cmd.Process.Kill()
}
