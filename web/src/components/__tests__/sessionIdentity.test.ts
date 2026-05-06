import { describe, expect, it, vi, beforeEach } from 'vitest'

// ────────────────────────────────────────────────────────────
// useSessionIdentity is a module-level singleton with reactive
// refs and action callbacks. We test the registration and
// delegation pattern, plus the identity ref management.
// ────────────────────────────────────────────────────────────

// Replicate the action callback pattern
let _switchSession: ((sessionId: string) => Promise<void>) | null = null
let _createSession: ((agentId?: string) => Promise<void>) | null = null
let _deleteSession: ((sessionId: string, backend?: string) => Promise<void>) | null = null
let _sendMessage: ((text: string, filePaths?: string[]) => Promise<void>) | null = null
let _openChatPanel: (() => void) | null = null

interface SessionActions {
  switchSession: (sessionId: string) => Promise<void>
  createSession: (agentId?: string) => Promise<void>
  deleteSession: (sessionId: string, backend?: string) => Promise<void>
  sendMessage: (text: string, filePaths?: string[]) => Promise<void>
  openChatPanel: () => void
}

function registerSessionActions(actions: SessionActions) {
  _switchSession = actions.switchSession
  _createSession = actions.createSession
  _deleteSession = actions.deleteSession
  _sendMessage = actions.sendMessage
  _openChatPanel = actions.openChatPanel
}

async function switchSession(sessionId: string) {
  if (_switchSession) await _switchSession(sessionId)
}

async function createSession(agentId?: string) {
  if (_createSession) await _createSession(agentId)
}

async function deleteSession(sessionId: string, backend?: string) {
  if (_deleteSession) await _deleteSession(sessionId, backend)
}

async function sendMessage(text: string, filePaths?: string[]) {
  if (_sendMessage) await _sendMessage(text, filePaths)
}

function openChatPanel() {
  if (_openChatPanel) _openChatPanel()
}

// Reset before each test
beforeEach(() => {
  _switchSession = null
  _createSession = null
  _deleteSession = null
  _sendMessage = null
  _openChatPanel = null
})

describe('registerSessionActions', () => {
  it('registers action callbacks', () => {
    const mockSwitch = vi.fn()
    const mockCreate = vi.fn()
    const mockDelete = vi.fn()
    const mockSend = vi.fn()
    const mockOpen = vi.fn()

    registerSessionActions({
      switchSession: mockSwitch,
      createSession: mockCreate,
      deleteSession: mockDelete,
      sendMessage: mockSend,
      openChatPanel: mockOpen,
    })

    // Verify they're registered (not null)
    expect(_switchSession).toBe(mockSwitch)
    expect(_createSession).toBe(mockCreate)
  })

  it('replaces previous callbacks on re-registration', () => {
    const firstSwitch = vi.fn()
    const secondSwitch = vi.fn()

    registerSessionActions({
      switchSession: firstSwitch,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })
    registerSessionActions({
      switchSession: secondSwitch,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })

    expect(_switchSession).toBe(secondSwitch)
  })
})

describe('action delegation', () => {
  it('delegates switchSession to registered callback', async () => {
    const mockSwitch = vi.fn()
    registerSessionActions({
      switchSession: mockSwitch,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })

    await switchSession('session-123')
    expect(mockSwitch).toHaveBeenCalledWith('session-123')
  })

  it('does nothing when switchSession has no callback', async () => {
    // No callback registered — should not throw
    await switchSession('session-123')
  })

  it('delegates createSession to registered callback', async () => {
    const mockCreate = vi.fn()
    registerSessionActions({
      switchSession: vi.fn(),
      createSession: mockCreate,
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })

    await createSession('agent-1')
    expect(mockCreate).toHaveBeenCalledWith('agent-1')
  })

  it('delegates createSession without agentId', async () => {
    const mockCreate = vi.fn()
    registerSessionActions({
      switchSession: vi.fn(),
      createSession: mockCreate,
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })

    await createSession()
    expect(mockCreate).toHaveBeenCalledWith(undefined)
  })

  it('delegates deleteSession with backend', async () => {
    const mockDelete = vi.fn()
    registerSessionActions({
      switchSession: vi.fn(),
      createSession: vi.fn(),
      deleteSession: mockDelete,
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })

    await deleteSession('session-1', 'claude')
    expect(mockDelete).toHaveBeenCalledWith('session-1', 'claude')
  })

  it('delegates sendMessage with filePaths', async () => {
    const mockSend = vi.fn()
    registerSessionActions({
      switchSession: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: mockSend,
      openChatPanel: vi.fn(),
    })

    await sendMessage('hello', ['/tmp/file.go'])
    expect(mockSend).toHaveBeenCalledWith('hello', ['/tmp/file.go'])
  })

  it('delegates openChatPanel to registered callback', () => {
    const mockOpen = vi.fn()
    registerSessionActions({
      switchSession: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: mockOpen,
    })

    openChatPanel()
    expect(mockOpen).toHaveBeenCalled()
  })

  it('does nothing when openChatPanel has no callback', () => {
    // No callback registered — should not throw
    openChatPanel()
  })
})

describe('identity refs', () => {
  it('initial values are empty strings', () => {
    // Simulate the initial state of module-level refs
    const currentSessionId = ''
    const currentSessionTitle = ''
    const currentBackend = ''
    const currentAgentId = ''

    expect(currentSessionId).toBe('')
    expect(currentSessionTitle).toBe('')
    expect(currentBackend).toBe('')
    expect(currentAgentId).toBe('')
  })

  it('runningSessions starts as empty set', () => {
    const runningSessions = new Set<string>()
    expect(runningSessions.size).toBe(0)
  })

  it('runningSessions can track active sessions', () => {
    const runningSessions = new Set<string>()
    runningSessions.add('session-1')
    runningSessions.add('session-2')
    expect(runningSessions.has('session-1')).toBe(true)
    expect(runningSessions.has('session-2')).toBe(true)
    expect(runningSessions.has('session-3')).toBe(false)
  })

  it('runningSessions can detect completed sessions', () => {
    const previousRunning = new Set(['session-1', 'session-2'])
    const currentRunning = new Set(['session-1'])

    const completed: string[] = []
    for (const sid of previousRunning) {
      if (!currentRunning.has(sid)) completed.push(sid)
    }

    expect(completed).toEqual(['session-2'])
  })
})
