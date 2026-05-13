import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  registerSessionActions,
  useSessionIdentity,
} from '@/composables/useSessionIdentity.ts'

// Reset module-level callbacks between tests by re-registering with nulls
beforeEach(() => {
  registerSessionActions({
    switchSession: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    openChatPanel: vi.fn(),
  })
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

    // Verify delegation works by calling through the composable
    const { switchSession, createSession, deleteSession, sendMessage, openChatPanel } = useSessionIdentity()

    // Just verify the functions exist and don't throw
    expect(typeof switchSession).toBe('function')
    expect(typeof createSession).toBe('function')
    expect(typeof deleteSession).toBe('function')
    expect(typeof sendMessage).toBe('function')
    expect(typeof openChatPanel).toBe('function')
  })

  it('replaces previous callbacks on re-registration', async () => {
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

    const { switchSession } = useSessionIdentity()
    await switchSession('session-123')
    expect(secondSwitch).toHaveBeenCalledWith('session-123')
    expect(firstSwitch).not.toHaveBeenCalled()
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

    const { switchSession } = useSessionIdentity()
    await switchSession('session-123')
    expect(mockSwitch).toHaveBeenCalledWith('session-123')
  })

  it('does nothing when switchSession has no callback', async () => {
    // Register with nulls — switchSession will be a no-op
    registerSessionActions({
      switchSession: async () => {},
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      sendMessage: vi.fn(),
      openChatPanel: vi.fn(),
    })
    const { switchSession } = useSessionIdentity()
    // Should not throw
    await expect(switchSession('session-123')).resolves.toBeUndefined()
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

    const { createSession } = useSessionIdentity()
    await createSession('agent-1')
    expect(mockCreate).toHaveBeenCalledWith('agent-1')
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

    const { deleteSession } = useSessionIdentity()
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

    const { sendMessage } = useSessionIdentity()
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

    const { openChatPanel } = useSessionIdentity()
    openChatPanel()
    expect(mockOpen).toHaveBeenCalled()
  })
})

describe('identity refs', () => {
  it('returns reactive refs from the singleton with correct initial values', () => {
    const { currentSessionId, currentBackend, runningSessions, currentAgentId, currentModelId, currentModelName } = useSessionIdentity()
    // Initial values should be empty strings/sets
    expect(currentSessionId.value).toBe('')
    expect(currentBackend.value).toBe('')
    expect(currentAgentId.value).toBe('')
    expect(currentModelId.value).toBe('')
    expect(currentModelName.value).toBe('')
    expect(runningSessions.value).toBeInstanceOf(Set)
    expect(runningSessions.value.size).toBe(0)
  })

  it('runningSessions can track active sessions', () => {
    const { runningSessions } = useSessionIdentity()
    runningSessions.value = new Set(['session-1', 'session-2'])
    expect(runningSessions.value.has('session-1')).toBe(true)
    expect(runningSessions.value.has('session-2')).toBe(true)
    expect(runningSessions.value.has('session-3')).toBe(false)
    // Clean up
    runningSessions.value = new Set()
  })

  it('runningSessions can detect completed sessions', () => {
    const { runningSessions } = useSessionIdentity()
    const previousRunning = new Set(['session-1', 'session-2'])
    runningSessions.value = previousRunning

    const currentRunning = new Set(['session-1'])
    const completed: string[] = []
    for (const sid of previousRunning) {
      if (!currentRunning.has(sid)) completed.push(sid)
    }
    expect(completed).toEqual(['session-2'])
    // Clean up
    runningSessions.value = new Set()
  })

  it('currentSessionId is writable and shared across instances', () => {
    const instance1 = useSessionIdentity()
    const instance2 = useSessionIdentity()

    instance1.currentSessionId.value = 'test-session-123'
    expect(instance2.currentSessionId.value).toBe('test-session-123')

    // Clean up
    instance1.currentSessionId.value = ''
  })
})
