package terminal

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"runtime"

	"github.com/creack/pty"
)

// resolveShell finds the appropriate shell binary for the current platform.
// Linux/macOS: $SHELL → /bin/sh
// Windows: pwsh → powershell → cmd.exe
func resolveShell() string {
	switch runtime.GOOS {
	case "windows":
		// Try PowerShell Core first, then Windows PowerShell, then cmd
		for _, cmd := range []string{"pwsh", "powershell", "cmd.exe"} {
			if path, err := exec.LookPath(cmd); err == nil {
				return path
			}
		}
		return "cmd.exe"
	default:
		// Linux/macOS: use $SHELL, fallback to /bin/sh
		if shell := os.Getenv("SHELL"); shell != "" {
			return shell
		}
		return "/bin/sh"
	}
}

// startPTY starts a new PTY session with the given working directory.
// Returns the PTY file, the command, and any error.
// The shell process is started in its own process group for clean cleanup.
func startPTY(cwd string) (*os.File, *exec.Cmd, error) {
	shell := resolveShell()
	slog.Info("terminal: starting PTY",
		slog.String("shell", shell),
		slog.String("cwd", cwd),
	)

	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = os.Environ()

	// Platform-specific process group setup
	setupProcessGroup(cmd)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to start PTY: %w", err)
	}

	return ptmx, cmd, nil
}
