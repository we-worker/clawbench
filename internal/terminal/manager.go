package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"clawbench/internal/model"
)

// Manager manages terminal sessions for the application.
// It is a standalone service (not integrated with session_runtime.go) because
// terminal sessions have a fundamentally different lifecycle from AI sessions.
type Manager struct {
	mu      sync.Mutex
	session *Session
	cfg     TerminalConfig
	port    int
}

// GlobalManager is the package-level singleton, set from main.go.
var GlobalManager *Manager

// TerminalConfig holds the terminal configuration.
// We define a local copy to avoid circular imports with the model package.
type TerminalConfig struct {
	Enabled       bool
	IdleTimeout   string
	BufferLines   int
	MaxLineBytes  int
	MaxBufferMB   int
	QuickCommands []QuickCommand
}

// QuickCommand mirrors model.QuickCommand for the terminal package.
type QuickCommand struct {
	Label   string
	Command string
}

// NewManager creates a new terminal manager.
func NewManager(cfg model.TerminalConfig, port int) *Manager {
	tc := TerminalConfig{
		Enabled:      cfg.Enabled,
		IdleTimeout:  cfg.IdleTimeout,
		BufferLines:  cfg.BufferLines,
		MaxLineBytes: cfg.MaxLineBytes,
		MaxBufferMB:  cfg.MaxBufferMB,
	}
	for _, qc := range cfg.QuickCommands {
		tc.QuickCommands = append(tc.QuickCommands, QuickCommand{Label: qc.Label, Command: qc.Command})
	}
	return &Manager{
		cfg:  tc,
		port: port,
	}
}

// Close shuts down the manager and all active sessions.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.session != nil {
		m.session.Close()
		m.session = nil
	}
	slog.Info("terminal: manager closed")
}

// HandleWebSocket handles a WebSocket connection request.
// It creates a new session if none exists, or connects to an existing one.
// If the project has changed, the old session is closed first.
func (m *Manager) HandleWebSocket(w http.ResponseWriter, r *http.Request, projectPath, cwd string) error {
	m.mu.Lock()

	// Check if terminal is disabled
	if !m.cfg.Enabled {
		m.mu.Unlock()
		return fmt.Errorf("terminal disabled")
	}

	// Check for project mismatch — close old session if project changed
	if m.session != nil && m.session.ProjectPath() != projectPath {
		slog.Info("terminal: project changed, closing old session",
			slog.String("old_project", m.session.ProjectPath()),
			slog.String("new_project", projectPath),
		)
		m.session.Close()
		m.session = nil
	}

	// Create new session if needed
	if m.session == nil {
		session, err := NewSession(projectPath, cwd, m.cfg)
		if err != nil {
			m.mu.Unlock()
			return fmt.Errorf("failed to start terminal: %w", err)
		}
		m.session = session
		slog.Info("terminal: new session created",
			slog.String("project", projectPath),
			slog.String("cwd", cwd),
		)
	}

	session := m.session
	m.mu.Unlock()

	// Upgrade to WebSocket
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return fmt.Errorf("websocket upgrade failed: %w", err)
	}

	// Try to connect to the session (rejects if already connected)
	if err := session.Connect(conn); err != nil {
		// Session already has a client — send error and close
		sendWSError(conn, ErrCodeSessionInUse, err.Error())
		conn.Close(websocket.StatusPolicyViolation, "session in use")
		return nil
	}

	// Handle WebSocket messages in a goroutine
	go m.handleClientMessages(session, conn)

	return nil
}

// handleClientMessages reads messages from the WebSocket and dispatches them.
func (m *Manager) handleClientMessages(session *Session, conn *websocket.Conn) {
	defer session.Disconnect()

	ctx := context.Background()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Client disconnected or error
			return
		}

		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			slog.Debug("terminal: invalid client message", slog.String("error", err.Error()))
			continue
		}

		switch msg.Type {
		case "input":
			if err := session.HandleInput(msg.Data); err != nil {
				slog.Debug("terminal: input error", slog.String("error", err.Error()))
			}
		case "resize":
			if err := session.HandleResize(msg.Cols, msg.Rows); err != nil {
				slog.Debug("terminal: resize error", slog.String("error", err.Error()))
			}
		case "close":
			session.Close()
			m.mu.Lock()
			if m.session == session {
				m.session = nil
			}
			m.mu.Unlock()
			return
		}
	}
}

// CloseSession closes the current terminal session.
func (m *Manager) CloseSession() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.session != nil {
		m.session.Close()
		m.session = nil
	}
}

// Status returns the current terminal session status.
func (m *Manager) Status() (hasSession bool, cwd string, running bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.session == nil {
		return false, "", false
	}
	return true, m.session.Cwd(), true
}

// Config returns the terminal configuration for the frontend.
func (m *Manager) Config() TerminalConfig {
	return m.cfg
}

// IsEnabled returns whether the terminal feature is enabled.
func (m *Manager) IsEnabled() bool {
	return m.cfg.Enabled
}

// sendWSError sends an error message over a WebSocket connection.
func sendWSError(conn *websocket.Conn, code, message string) {
	msg := ServerMessage{
		Type:    "error",
		ErrCode: code,
		Message: message,
	}
	data, _ := json.Marshal(msg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn.Write(ctx, websocket.MessageText, data)
}
