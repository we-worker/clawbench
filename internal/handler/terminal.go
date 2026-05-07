package handler

import (
	"log/slog"
	"net/http"

	"clawbench/internal/middleware"
	"clawbench/internal/model"
	"clawbench/internal/terminal"
)

// terminalMgr is set via SetTerminalManager during startup.
var terminalMgr *terminal.Manager

// SetTerminalManager sets the terminal manager for handlers.
func SetTerminalManager(m *terminal.Manager) {
	terminalMgr = m
}

// TerminalWebSocket handles WebSocket connections for the interactive terminal.
func TerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	if terminalMgr == nil || !terminalMgr.IsEnabled() {
		writeLocalizedErrorf(w, r, http.StatusServiceUnavailable, "TerminalDisabled")
		return
	}

	// Get project path from cookie
	projectPath := middleware.GetProjectFromCookie(r)
	if projectPath == "" {
		writeLocalizedError(w, r, model.Forbidden(nil, "NoProjectSelected"))
		return
	}

	// Get cwd from query parameter (relative path within project)
	cwd := projectPath
	if relCwd := r.URL.Query().Get("cwd"); relCwd != "" {
		absCwd, ok := model.ValidatePath(projectPath, relCwd)
		if ok {
			cwd = absCwd
		}
		// If validation fails, fall back to projectPath
	}

	if err := terminalMgr.HandleWebSocket(w, r, projectPath, cwd); err != nil {
		slog.Error("terminal: websocket handler error", slog.String("error", err.Error()))
		writeLocalizedErrorf(w, r, http.StatusInternalServerError, "TerminalError")
	}
}

// TerminalStatus returns the current terminal session status.
func TerminalStatus(w http.ResponseWriter, r *http.Request) {
	if terminalMgr == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
		})
		return
	}

	hasSession, cwd, running := terminalMgr.Status()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":    terminalMgr.IsEnabled(),
		"hasSession": hasSession,
		"cwd":        cwd,
		"running":    running,
	})
}

// TerminalClose closes the current terminal session.
func TerminalClose(w http.ResponseWriter, r *http.Request) {
	if terminalMgr == nil || !terminalMgr.IsEnabled() {
		writeLocalizedErrorf(w, r, http.StatusServiceUnavailable, "TerminalDisabled")
		return
	}

	terminalMgr.CloseSession()
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
	})
}

// TerminalConfigHandler returns the terminal configuration for the frontend.
func TerminalConfigHandler(w http.ResponseWriter, r *http.Request) {
	if terminalMgr == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":        false,
			"quick_commands": []any{},
		})
		return
	}

	cfg := terminalMgr.Config()
	commands := make([]map[string]string, len(cfg.QuickCommands))
	for i, qc := range cfg.QuickCommands {
		commands[i] = map[string]string{
			"label":   qc.Label,
			"command": qc.Command,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":        cfg.Enabled,
		"quick_commands": commands,
	})
}
