package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

// re-export killProcessGroupSig as killProcessGroup for use in session.go
func killProcessGroup(cmd *exec.Cmd, sig syscall.Signal) {
	killProcessGroupSig(cmd, sig)
}

// Session represents a single PTY terminal session.
type Session struct {
	mu          sync.Mutex
	projectPath string
	cwd         string
	cmd         *exec.Cmd
	ptmx        *os.File
	buffer      *RingBuffer
	wsConn      *websocket.Conn
	wsMu        sync.Mutex // protects wsConn writes
	idleTimer   *time.Timer
	idleTimeout time.Duration
	cancelRead  context.CancelFunc
	done        chan struct{}
	closed      bool
}

// NewSession creates a new terminal session by starting a PTY in the given directory.
func NewSession(projectPath, cwd string, cfg TerminalConfig) (*Session, error) {
	idleTimeout, err := time.ParseDuration(cfg.IdleTimeout)
	if err != nil {
		idleTimeout = 10 * time.Minute
	}

	ptmx, cmd, err := startPTY(cwd)
	if err != nil {
		return nil, err
	}

	s := &Session{
		projectPath: projectPath,
		cwd:         cwd,
		cmd:         cmd,
		ptmx:        ptmx,
		buffer:      NewRingBuffer(cfg.BufferLines, cfg.MaxLineBytes, cfg.MaxBufferMB*1024*1024),
		idleTimeout: idleTimeout,
		done:        make(chan struct{}),
	}

	// Start idle timer (will be stopped when a client connects)
	s.idleTimer = time.AfterFunc(s.idleTimeout, func() {
		slog.Info("terminal: session idle timeout", slog.String("project", s.projectPath))
		s.Close()
	})

	// Start reading PTY output
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelRead = cancel
	go s.readPTY(ctx)

	// Monitor process exit
	go s.waitProcess()

	return s, nil
}

// readPTY reads output from the PTY and broadcasts it to the WebSocket client
// while writing to the ring buffer.
func (s *Session) readPTY(ctx context.Context) {
	buf := make([]byte, 4096)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, err := s.ptmx.Read(buf)
		if n > 0 {
			data := buf[:n]

			// Write to ring buffer (for replay)
			s.buffer.Write(data)

			// Send to WebSocket client if connected
			msg := ServerMessage{
				Type: "output",
				Data: string(data),
			}
			s.sendToClient(msg)
		}
		if err != nil {
			if err != io.EOF {
				slog.Debug("terminal: PTY read error", slog.String("error", err.Error()))
			}
			return
		}
	}
}

// waitProcess waits for the PTY process to exit and notifies the client.
func (s *Session) waitProcess() {
	err := s.cmd.Wait()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}

	s.sendToClient(ServerMessage{
		Type: "exit",
		Code: exitCode,
	})

	slog.Info("terminal: process exited",
		slog.String("project", s.projectPath),
		slog.Int("exit_code", exitCode),
	)
}

// Connect attaches a WebSocket client to this session.
// Returns an error if a client is already connected.
func (s *Session) Connect(conn *websocket.Conn) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session is closed")
	}

	if s.wsConn != nil {
		// Reject — session already has an active connection
		return fmt.Errorf("session already has active connection")
	}

	// Stop idle timer — we have a client now
	s.idleTimer.Stop()

	s.wsConn = conn

	// Send replay buffer
	if replayData := s.buffer.Replay(); replayData != nil {
		s.sendToClientUnlocked(ServerMessage{
			Type: "replay",
			Data: string(replayData),
		})
	}

	// Send current status
	s.sendToClientUnlocked(ServerMessage{
		Type:    "status",
		Cwd:     s.cwd,
		Running: true,
	})

	return nil
}

// Disconnect removes the WebSocket client and starts the idle timer.
func (s *Session) Disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.wsConn != nil {
		s.wsConn.Close(websocket.StatusNormalClosure, "client disconnected")
		s.wsConn = nil
	}

	// Start idle timer — no clients connected
	if !s.closed {
		s.idleTimer.Stop()
		s.idleTimer.Reset(s.idleTimeout)
	}
}

// HandleInput processes an input message from the WebSocket client.
func (s *Session) HandleInput(data string) error {
	s.mu.Lock()
	ptmx := s.ptmx
	s.mu.Unlock()

	if ptmx == nil {
		return fmt.Errorf("PTY not available")
	}

	_, err := ptmx.Write([]byte(data))
	return err
}

// HandleResize processes a resize message from the WebSocket client.
func (s *Session) HandleResize(cols, rows uint16) error {
	s.mu.Lock()
	ptmx := s.ptmx
	s.mu.Unlock()

	if ptmx == nil {
		return fmt.Errorf("PTY not available")
	}

	return pty.Setsize(ptmx, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
}

// Close terminates the PTY process, closes the WebSocket, and cleans up resources.
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}
	s.closed = true

	slog.Info("terminal: closing session", slog.String("project", s.projectPath))

	// Stop idle timer
	s.idleTimer.Stop()

	// Cancel PTY reader
	if s.cancelRead != nil {
		s.cancelRead()
	}

	// Signal the PTY process group
	if s.cmd != nil && s.cmd.Process != nil {
		killProcessGroup(s.cmd, syscall.SIGTERM)

		// Wait briefly for graceful exit
		done := make(chan error, 1)
		go func() { done <- s.cmd.Wait() }()

		select {
		case <-done:
			// Process exited cleanly
		case <-time.After(3 * time.Second):
			// Force kill
			killProcessGroup(s.cmd, syscall.SIGKILL)
		}
	}

	// Close PTY
	if s.ptmx != nil {
		s.ptmx.Close()
	}

	// Close WebSocket
	if s.wsConn != nil {
		s.wsConn.Close(websocket.StatusNormalClosure, "session closed")
		s.wsConn = nil
	}

	// Clear buffer
	s.buffer.Reset()
}

// sendToClient sends a message to the WebSocket client (thread-safe).
func (s *Session) sendToClient(msg ServerMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sendToClientUnlocked(msg)
}

// sendToClientUnlocked sends a message without acquiring the mutex (caller must hold lock).
func (s *Session) sendToClientUnlocked(msg ServerMessage) {
	if s.wsConn == nil {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("terminal: failed to marshal message", slog.String("error", err.Error()))
		return
	}

	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.wsConn.Write(ctx, websocket.MessageText, data); err != nil {
		slog.Debug("terminal: failed to send to client", slog.String("error", err.Error()))
	}
}

// ProjectPath returns the project path this session belongs to.
func (s *Session) ProjectPath() string {
	return s.projectPath
}

// Cwd returns the current working directory of the session.
func (s *Session) Cwd() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cwd
}
