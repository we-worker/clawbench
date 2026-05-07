package terminal

// ClientMessage represents a message sent from the frontend to the server.
type ClientMessage struct {
	Type  string `json:"type"`           // "input", "resize", "close"
	Data  string `json:"data,omitempty"` // For "input": the keystroke data
	Cols  uint16 `json:"cols,omitempty"` // For "resize": terminal columns
	Rows  uint16 `json:"rows,omitempty"` // For "resize": terminal rows
}

// ServerMessage represents a message sent from the server to the frontend.
type ServerMessage struct {
	Type    string `json:"type"`              // "output", "replay", "status", "exit", "error"
	Data    string `json:"data,omitempty"`    // For "output"/"replay": the terminal data
	Cwd     string `json:"cwd,omitempty"`     // For "status": current working directory
	Running bool   `json:"running,omitempty"` // For "status": whether PTY is running
	Code    int    `json:"code,omitempty"`    // For "exit": exit code
	Message string `json:"message,omitempty"` // For "error": error description
	ErrCode string `json:"errcode,omitempty"` // For "error": machine-readable error code
}

// Error codes for WebSocket error messages
const (
	ErrCodeSessionInUse = "session_in_use"
	ErrCodeDisabled     = "terminal_disabled"
	ErrCodeShellFailed  = "shell_start_failed"
	ErrCodeCwdInvalid   = "cwd_invalid"
)
