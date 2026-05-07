package terminal

import (
	"testing"
	"time"

	"clawbench/internal/model"
)

func TestResolveShell(t *testing.T) {
	shell := resolveShell()
	if shell == "" {
		t.Error("resolveShell() returned empty string")
	}
	t.Logf("resolved shell: %s", shell)
}

func TestNewSessionAndClose(t *testing.T) {
	// PTY fork may be restricted in sandboxed environments
	cfg := TerminalConfig{
		IdleTimeout:   "5s",
		BufferLines:   100,
		MaxLineBytes:  65536,
		MaxBufferMB:   4,
	}

	session, err := NewSession("/tmp", "/tmp", cfg)
	if err != nil {
		t.Skipf("PTY not available in this environment: %v", err)
	}
	defer session.Close()

	if session.ProjectPath() != "/tmp" {
		t.Errorf("expected projectPath /tmp, got %s", session.ProjectPath())
	}
	if session.Cwd() != "/tmp" {
		t.Errorf("expected cwd /tmp, got %s", session.Cwd())
	}
}

func TestSessionIdleTimeout(t *testing.T) {
	cfg := TerminalConfig{
		IdleTimeout:   "1s", // Very short timeout for testing
		BufferLines:   100,
		MaxLineBytes:  65536,
		MaxBufferMB:   4,
	}

	session, err := NewSession("/tmp", "/tmp", cfg)
	if err != nil {
		t.Skipf("PTY not available in this environment: %v", err)
	}
	// Don't defer Close — the idle timer will close it

	// Wait for idle timeout to fire
	time.Sleep(2 * time.Second)

	// Session should be closed now
	session.mu.Lock()
	closed := session.closed
	session.mu.Unlock()

	if !closed {
		t.Error("expected session to be closed after idle timeout")
	}
}

func TestManagerCloseSession(t *testing.T) {
	cfg := model.TerminalConfig{
		Enabled:      true,
		IdleTimeout:  "10m",
		BufferLines:  100,
		MaxLineBytes: 65536,
		MaxBufferMB:  4,
	}

	mgr := NewManager(cfg, 20000)
	defer mgr.Close()

	// Close with no active session should not panic
	mgr.CloseSession()

	// Status should show no session
	hasSession, cwd, running := mgr.Status()
	if hasSession {
		t.Error("expected no session after CloseSession")
	}
	if cwd != "" {
		t.Errorf("expected empty cwd, got %s", cwd)
	}
	if running {
		t.Error("expected not running")
	}
}

func TestManagerIsEnabled(t *testing.T) {
	cfg := model.TerminalConfig{
		Enabled:      true,
		IdleTimeout:  "10m",
		BufferLines:  100,
		MaxLineBytes: 65536,
		MaxBufferMB:  4,
	}

	mgr := NewManager(cfg, 20000)
	defer mgr.Close()

	if !mgr.IsEnabled() {
		t.Error("expected terminal to be enabled")
	}

	disabledCfg := model.TerminalConfig{
		Enabled:      false,
		IdleTimeout:  "10m",
		BufferLines:  100,
		MaxLineBytes: 65536,
		MaxBufferMB:  4,
	}

	disabledMgr := NewManager(disabledCfg, 20000)
	defer disabledMgr.Close()

	if disabledMgr.IsEnabled() {
		t.Error("expected terminal to be disabled")
	}
}

func TestManagerConfig(t *testing.T) {
	cfg := model.TerminalConfig{
		Enabled:      true,
		IdleTimeout:  "10m",
		BufferLines:  2000,
		MaxLineBytes: 65536,
		MaxBufferMB:  4,
		QuickCommands: []model.QuickCommand{
			{Label: "Test", Command: "echo test"},
		},
	}

	mgr := NewManager(cfg, 20000)
	defer mgr.Close()

	tc := mgr.Config()
	if !tc.Enabled {
		t.Error("expected enabled")
	}
	if tc.BufferLines != 2000 {
		t.Errorf("expected 2000 buffer lines, got %d", tc.BufferLines)
	}
	if len(tc.QuickCommands) != 1 {
		t.Fatalf("expected 1 quick command, got %d", len(tc.QuickCommands))
	}
	if tc.QuickCommands[0].Label != "Test" {
		t.Errorf("expected label 'Test', got %s", tc.QuickCommands[0].Label)
	}
}
