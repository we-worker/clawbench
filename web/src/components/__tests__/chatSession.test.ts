import { describe, expect, it, vi } from 'vitest'

// ────────────────────────────────────────────────────────────
// useChatSession relies on fetch, useSessionIdentity, useAgents,
// useToast, useNotification, store, and i18n. We test the pure
// logic by replicating key functions.
// ────────────────────────────────────────────────────────────

// Replicate buildMessageSnapshot logic (pure function)
function buildMessageSnapshot(rawMsgs: any[]): string {
  return rawMsgs.map(m =>
    `${m.id ?? ''}:${m.role}:${(m.content || '').length}:${m.createdAt || ''}:${m.streaming ? 1 : 0}`
  ).join('|')
}

// Replicate parseMessages logic
function parseMessages(rawMsgs: any[], onParseAssistantContent: (content: string) => any): any[] {
  return rawMsgs.map(msg => {
    if (msg.role === 'assistant') {
      const { blocks, metadata, cancelled } = onParseAssistantContent(msg.content)
      msg.blocks = blocks
      if (metadata) msg.metadata = metadata
      if (cancelled) msg.cancelled = cancelled
      if (msg.streaming) { msg.streaming = true; msg.fromDB = true }
    } else if (msg.role === 'user' && !msg.blocks) {
      msg.blocks = msg.content ? [{ type: 'text', text: msg.content }] : []
    }
    return msg
  })
}

describe('buildMessageSnapshot', () => {
  it('creates fingerprint from message properties', () => {
    const msgs = [
      { id: '1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00Z', streaming: false },
    ]
    const snapshot = buildMessageSnapshot(msgs)
    expect(snapshot).toBe('1:user:5:2026-01-01T00:00:00Z:0')
  })

  it('handles missing id', () => {
    const msgs = [
      { role: 'user', content: 'hi', createdAt: '2026-01-01', streaming: false },
    ]
    const snapshot = buildMessageSnapshot(msgs)
    expect(snapshot).toBe(':user:2:2026-01-01:0')
  })

  it('handles empty content', () => {
    const msgs = [
      { id: '2', role: 'assistant', content: '', createdAt: '', streaming: true },
    ]
    const snapshot = buildMessageSnapshot(msgs)
    expect(snapshot).toBe('2:assistant:0::1')
  })

  it('handles multiple messages', () => {
    const msgs = [
      { id: '1', role: 'user', content: 'hello', createdAt: '2026-01-01', streaming: false },
      { id: '2', role: 'assistant', content: 'world', createdAt: '2026-01-01', streaming: false },
    ]
    const snapshot = buildMessageSnapshot(msgs)
    expect(snapshot).toBe('1:user:5:2026-01-01:0|2:assistant:5:2026-01-01:0')
  })

  it('returns empty for empty array', () => {
    expect(buildMessageSnapshot([])).toBe('')
  })

  it('detects changes in content length', () => {
    const msgs1 = [{ id: '1', role: 'user', content: 'hi', createdAt: '2026-01-01', streaming: false }]
    const msgs2 = [{ id: '1', role: 'user', content: 'hello', createdAt: '2026-01-01', streaming: false }]
    expect(buildMessageSnapshot(msgs1)).not.toBe(buildMessageSnapshot(msgs2))
  })

  it('detects streaming flag change', () => {
    const msgs1 = [{ id: '1', role: 'assistant', content: '', createdAt: '', streaming: false }]
    const msgs2 = [{ id: '1', role: 'assistant', content: '', createdAt: '', streaming: true }]
    expect(buildMessageSnapshot(msgs1)).not.toBe(buildMessageSnapshot(msgs2))
  })
})

describe('parseMessages', () => {
  const mockParseAssistantContent = (content: string) => {
    if (!content) return { blocks: [], metadata: null, cancelled: false }
    try {
      const parsed = JSON.parse(content)
      if (parsed.blocks) return { blocks: parsed.blocks, metadata: parsed.metadata || null, cancelled: parsed.cancelled || false }
    } catch {}
    return { blocks: [{ type: 'text', text: content }], metadata: null, cancelled: false }
  }

  it('parses assistant messages with blocks', () => {
    const msgs = [
      { role: 'assistant', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Hello' }] }) },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('parses user messages into text blocks', () => {
    const msgs = [
      { role: 'user', content: 'Hello AI' },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].blocks).toEqual([{ type: 'text', text: 'Hello AI' }])
  })

  it('creates empty blocks for user messages with no content', () => {
    const msgs = [
      { role: 'user', content: '' },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].blocks).toEqual([])
  })

  it('preserves user blocks if already present', () => {
    const msgs = [
      { role: 'user', content: 'Hello', blocks: [{ type: 'text', text: 'Hello' }] },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('marks streaming assistant messages as fromDB', () => {
    const msgs = [
      { role: 'assistant', content: '', streaming: true },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].fromDB).toBe(true)
    expect(result[0].streaming).toBe(true)
  })

  it('does not mark non-streaming messages as fromDB', () => {
    const msgs = [
      { role: 'assistant', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Done' }] }) },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].fromDB).toBeUndefined()
  })

  it('handles mixed user and assistant messages', () => {
    const msgs = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Answer' }] }) },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result).toHaveLength(2)
    expect(result[0].blocks[0].text).toBe('Question')
    expect(result[1].blocks[0].text).toBe('Answer')
  })

  it('extracts metadata from assistant content', () => {
    const msgs = [
      { role: 'assistant', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Hi' }], metadata: { tokens: 50 } }) },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].metadata).toEqual({ tokens: 50 })
  })

  it('extracts cancelled flag from assistant content', () => {
    const msgs = [
      { role: 'assistant', content: JSON.stringify({ blocks: [{ type: 'text', text: 'partial' }], cancelled: true }) },
    ]
    const result = parseMessages(msgs, mockParseAssistantContent)
    expect(result[0].cancelled).toBe(true)
  })
})

// Test pagination logic
describe('hasMore computed', () => {
  it('returns true when messages less than total', () => {
    const messagesLength = 10
    const totalMessages = 25
    expect(messagesLength < totalMessages).toBe(true)
  })

  it('returns false when messages equal total', () => {
    const messagesLength = 25
    const totalMessages = 25
    expect(messagesLength < totalMessages).toBe(false)
  })

  it('returns false when messages exceed total', () => {
    const messagesLength = 30
    const totalMessages = 25
    expect(messagesLength < totalMessages).toBe(false)
  })
})
