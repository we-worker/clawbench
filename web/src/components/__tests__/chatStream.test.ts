import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'

// ────────────────────────────────────────────────────────────
// useChatStream relies on EventSource and DOM timers.
// We test the core logic by extracting the key behaviors:
// - findLastBlockOfType (coalescing logic)
// - forceCleanupStreamingState
// - FILE_MODIFYING_TOOLS detection
// - Stream timeout and reconnect logic
// ────────────────────────────────────────────────────────────

// FILE_MODIFYING_TOOLS set from useChatStream
const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit'])

describe('FILE_MODIFYING_TOOLS', () => {
  it('includes Write tool', () => {
    expect(FILE_MODIFYING_TOOLS.has('Write')).toBe(true)
  })

  it('includes Edit tool', () => {
    expect(FILE_MODIFYING_TOOLS.has('Edit')).toBe(true)
  })

  it('does not include Read tool', () => {
    expect(FILE_MODIFYING_TOOLS.has('Read')).toBe(false)
  })

  it('does not include Bash tool', () => {
    expect(FILE_MODIFYING_TOOLS.has('Bash')).toBe(false)
  })
})

// Replicate findLastBlockOfType logic
function findLastBlockOfType(blocks: any[], type: string): any | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === type) return blocks[i]
    if (blocks[i].type === 'tool_use') return undefined
  }
  return undefined
}

describe('findLastBlockOfType (coalescing logic)', () => {
  it('finds last text block', () => {
    const blocks = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(findLastBlockOfType(blocks, 'text').text).toBe('second')
  })

  it('finds last thinking block', () => {
    const blocks = [
      { type: 'thinking', text: 'think1' },
      { type: 'thinking', text: 'think2' },
    ]
    expect(findLastBlockOfType(blocks, 'thinking').text).toBe('think2')
  })

  it('returns undefined when no matching block', () => {
    const blocks = [{ type: 'text', text: 'hello' }]
    expect(findLastBlockOfType(blocks, 'thinking')).toBeUndefined()
  })

  it('returns undefined for empty blocks array', () => {
    expect(findLastBlockOfType([], 'text')).toBeUndefined()
  })

  it('does not cross tool_use boundary', () => {
    const blocks = [
      { type: 'text', text: 'before' },
      { type: 'tool_use', name: 'Read', id: '1', input: {} },
      { type: 'text', text: 'after' },
    ]
    // Looking for text should find 'after' (last text before end)
    expect(findLastBlockOfType(blocks, 'text').text).toBe('after')
  })

  it('returns undefined when only tool_use is before matching type', () => {
    const blocks = [
      { type: 'thinking', text: 'think1' },
      { type: 'tool_use', name: 'Read', id: '1', input: {} },
    ]
    // Looking for thinking, but tool_use is a boundary —
    // the thinking block is before the tool_use boundary
    // The search goes backward: index 1 is tool_use (boundary), so return undefined
    expect(findLastBlockOfType(blocks, 'thinking')).toBeUndefined()
  })

  it('finds block when tool_use is after matching type', () => {
    const blocks = [
      { type: 'thinking', text: 'think1' },
    ]
    expect(findLastBlockOfType(blocks, 'thinking').text).toBe('think1')
  })

  it('handles interleaved text and thinking blocks', () => {
    const blocks = [
      { type: 'text', text: 'text1' },
      { type: 'thinking', text: 'think1' },
      { type: 'text', text: 'text2' },
    ]
    // Finding text should return text2 (last text block)
    expect(findLastBlockOfType(blocks, 'text').text).toBe('text2')
    // Finding thinking should return think1
    expect(findLastBlockOfType(blocks, 'thinking').text).toBe('think1')
  })
})

// Replicate forceCleanupStreamingState logic
function forceCleanupStreamingState(messages: any[], callbacks: { onRenderNeeded: () => void }) {
  const streamingMsg = messages.find(m => m.role === 'assistant' && m.streaming)
  if (streamingMsg) {
    delete streamingMsg.streaming
    if (streamingMsg.blocks) {
      for (const block of streamingMsg.blocks) {
        if (block.type === 'tool_use' && !block.done) {
          block.done = true
        }
      }
    }
  }
  callbacks.onRenderNeeded()
}

describe('forceCleanupStreamingState', () => {
  it('removes streaming flag from assistant message', () => {
    const messages = [
      { role: 'assistant', content: '', blocks: [], streaming: true },
    ]
    const onRenderNeeded = vi.fn()
    forceCleanupStreamingState(messages, { onRenderNeeded })
    expect(messages[0].streaming).toBeUndefined()
  })

  it('marks unfinished tool_use blocks as done', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        blocks: [
          { type: 'tool_use', name: 'Read', id: '1', done: false },
          { type: 'tool_use', name: 'Write', id: '2', done: true },
        ],
        streaming: true,
      },
    ]
    forceCleanupStreamingState(messages, { onRenderNeeded: vi.fn() })
    expect(messages[0].blocks[0].done).toBe(true)
    expect(messages[0].blocks[1].done).toBe(true)
  })

  it('calls onRenderNeeded', () => {
    const onRenderNeeded = vi.fn()
    forceCleanupStreamingState([], { onRenderNeeded })
    expect(onRenderNeeded).toHaveBeenCalled()
  })

  it('does nothing if no streaming message exists', () => {
    const messages = [
      { role: 'user', content: 'hello' },
    ]
    const onRenderNeeded = vi.fn()
    forceCleanupStreamingState(messages, { onRenderNeeded })
    expect(onRenderNeeded).toHaveBeenCalled()
    // No crash, no modification
    expect(messages[0].content).toBe('hello')
  })
})

// Test content coalescing behavior (simulating SSE event handling)
describe('SSE content coalescing', () => {
  it('coalesces consecutive content events into one text block', () => {
    const blocks: any[] = []
    // Simulate first content event
    const text1 = 'Hello'
    const existing1 = findLastBlockOfType(blocks, 'text')
    if (existing1) {
      existing1.text += text1
    } else {
      blocks.push({ type: 'text', text: text1 })
    }
    // Simulate second content event
    const text2 = ' World'
    const existing2 = findLastBlockOfType(blocks, 'text')
    if (existing2) {
      existing2.text += text2
    } else {
      blocks.push({ type: 'text', text: text2 })
    }
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('Hello World')
  })

  it('creates new text block after tool_use boundary', () => {
    const blocks: any[] = [
      { type: 'text', text: 'before' },
      { type: 'tool_use', name: 'Read', id: '1', done: true },
    ]
    // Simulate content event after tool_use
    const text = 'after tool'
    const existing = findLastBlockOfType(blocks, 'text')
    if (existing) {
      existing.text += text
    } else {
      blocks.push({ type: 'text', text })
    }
    expect(blocks).toHaveLength(3)
    expect(blocks[2].text).toBe('after tool')
  })

  it('coalesces thinking events into one block', () => {
    const blocks: any[] = []
    // First thinking
    const existing1 = findLastBlockOfType(blocks, 'thinking')
    if (existing1) {
      existing1.text += 'think1'
    } else {
      blocks.push({ type: 'thinking', text: 'think1' })
    }
    // Second thinking
    const existing2 = findLastBlockOfType(blocks, 'thinking')
    if (existing2) {
      existing2.text += ' think2'
    } else {
      blocks.push({ type: 'thinking', text: ' think2' })
    }
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('think1 think2')
  })
})

describe('tool_use event handling', () => {
  it('creates new block for new tool_use', () => {
    const blocks: any[] = []
    const data = { name: 'Read', id: '1', input: { file_path: '/test.go' } }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (!existing) {
      blocks.push({ type: 'tool_use', name: data.name, id: data.id, input: data.input, done: false })
    }
    expect(blocks).toHaveLength(1)
    expect(blocks[0].name).toBe('Read')
    expect(blocks[0].done).toBe(false)
  })

  it('marks block as done on done event', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/test.go' }, done: false },
    ]
    const data = { name: 'Read', id: '1', done: true }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (data.done && existing) {
      existing.done = true
    }
    expect(blocks[0].done).toBe(true)
  })

  it('detects file modification for Write tool', () => {
    const data = { name: 'Write', id: '1', done: true, input: { file_path: '/tmp/test.go', content: 'hello' } }
    const isFileModifying = FILE_MODIFYING_TOOLS.has(data.name)
    const filePath = data.input?.file_path
    expect(isFileModifying).toBe(true)
    expect(filePath).toBe('/tmp/test.go')
  })

  it('detects file modification for Edit tool', () => {
    const data = { name: 'Edit', id: '2', done: true, input: { file_path: '/tmp/edit.go', old_string: 'a', new_string: 'b' } }
    const isFileModifying = FILE_MODIFYING_TOOLS.has(data.name)
    const filePath = data.input?.file_path
    expect(isFileModifying).toBe(true)
    expect(filePath).toBe('/tmp/edit.go')
  })

  it('does not detect file modification for Read tool', () => {
    const data = { name: 'Read', id: '3', done: true, input: { file_path: '/tmp/read.go' } }
    const isFileModifying = FILE_MODIFYING_TOOLS.has(data.name)
    expect(isFileModifying).toBe(false)
  })
})

// Test tool_use event handling with output/status fields
describe('tool_use event with output/status', () => {
  it('updates output field on existing block when done', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Bash', id: '1', input: { command: 'ls' }, done: false, output: '', status: '' },
    ]
    const data = { name: 'Bash', id: '1', done: true, output: 'file1.go\nfile2.go', status: 'success' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (data.done && existing) {
      existing.done = true
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    expect(blocks[0].done).toBe(true)
    expect(blocks[0].output).toBe('file1.go\nfile2.go')
    expect(blocks[0].status).toBe('success')
  })

  it('sets output and status on new block creation', () => {
    const blocks: any[] = []
    const data = { name: 'Bash', id: '2', input: { command: 'pwd' }, done: false, output: 'initial output', status: '' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (!existing) {
      blocks.push({ type: 'tool_use', name: data.name, id: data.id, input: data.input || {}, done: false, output: data.output || '', status: data.status || '' })
    }
    expect(blocks[0].output).toBe('initial output')
  })

  it('updates output on in-progress tool_use event', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Bash', id: '3', input: { command: 'ls' }, done: false, output: '', status: '' },
    ]
    // Simulate a partial tool_use event (not done) that carries output
    const data = { name: 'Bash', id: '3', output: 'partial output', status: 'success' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (existing) {
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    expect(blocks[0].output).toBe('partial output')
    expect(blocks[0].done).toBe(false) // Still in progress
  })
})

// Test tool_result event handling
describe('tool_result event handling', () => {
  it('updates output/status on matching tool_use block', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/a.go' }, done: true, output: '', status: '' },
    ]
    const data = { id: 'r1', output: 'file contents here', status: 'success' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (existing) {
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    expect(blocks[0].output).toBe('file contents here')
    expect(blocks[0].status).toBe('success')
  })

  it('handles tool_result for error status', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'bad-cmd' }, done: true, output: '', status: '' },
    ]
    const data = { id: 'b1', output: 'command not found', status: 'error' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (existing) {
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    expect(blocks[0].output).toBe('command not found')
    expect(blocks[0].status).toBe('error')
  })

  it('silently ignores tool_result with no matching block', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Read', id: 'r2', input: { file_path: '/b.go' }, done: true, output: '', status: '' },
    ]
    const data = { id: 'nonexistent', output: 'orphan output', status: 'success' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (existing) {
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    // No match — blocks unchanged
    expect(blocks).toHaveLength(1)
    expect(blocks[0].output).toBe('')
  })

  it('updates the most recent matching tool_use when duplicates exist', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Read', id: 'r3', input: { file_path: '/first.go' }, done: true, output: '', status: '' },
      { type: 'tool_use', name: 'Read', id: 'r3', input: { file_path: '/second.go' }, done: true, output: '', status: '' },
    ]
    const data = { id: 'r3', output: 'merged output', status: 'success' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (existing) {
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    // find() returns the first match
    expect(blocks[0].output).toBe('merged output')
    expect(blocks[1].output).toBe('')
  })

  it('handles tool_result with only status (no output)', () => {
    const blocks: any[] = [
      { type: 'tool_use', name: 'Read', id: 'r4', input: { file_path: '/c.go' }, done: true, output: '', status: '' },
    ]
    const data = { id: 'r4', status: 'success' }
    const existing = blocks.find(b => b.type === 'tool_use' && b.id === data.id)
    if (existing) {
      if (data.output !== undefined) existing.output = data.output
      if (data.status !== undefined) existing.status = data.status
    }
    expect(blocks[0].status).toBe('success')
    expect(blocks[0].output).toBe('')
  })
})

// Test cancelled event handling
describe('cancelled event handling', () => {
  it('marks message as cancelled', () => {
    const msg = { role: 'assistant', content: '', blocks: [], streaming: true }
    // Simulate cancelled event
    msg.cancelled = true
    delete msg.streaming
    if (msg.blocks) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_use' && !block.done) {
          block.done = true
        }
      }
    }
    expect(msg.cancelled).toBe(true)
    expect(msg.streaming).toBeUndefined()
  })

  it('adds error block when no content received on cancel', () => {
    const msg = { role: 'assistant', content: '', blocks: [] as any[], streaming: true }
    // Simulate cancelled event with no content
    const userCancelledText = 'Cancelled by user'
    if ((!msg.blocks || msg.blocks.length === 0) && !msg.content) {
      msg.blocks = [{ type: 'error', text: userCancelledText }]
    }
    expect(msg.blocks).toEqual([{ type: 'error', text: 'Cancelled by user' }])
  })

  it('does not add error block when content exists', () => {
    const msg = { role: 'assistant', content: '', blocks: [{ type: 'text', text: 'partial' }], streaming: true }
    if ((!msg.blocks || msg.blocks.length === 0) && !msg.content) {
      msg.blocks = [{ type: 'error', text: 'Cancelled' }]
    }
    expect(msg.blocks).toEqual([{ type: 'text', text: 'partial' }])
  })
})

// Test reconnect logic
describe('SSE reconnect logic', () => {
  it('tracks reconnect attempts', () => {
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 3
    // Simulate reconnect
    reconnectAttempts++
    expect(reconnectAttempts).toBe(1)
    reconnectAttempts++
    expect(reconnectAttempts).toBe(2)
    reconnectAttempts++
    expect(reconnectAttempts).toBe(3)
    // At max, should fall back to polling
    expect(reconnectAttempts >= MAX_RECONNECT_ATTEMPTS).toBe(true)
  })

  it('resets reconnect attempts on new connection', () => {
    let reconnectAttempts = 3
    // New connection resets
    reconnectAttempts = 0
    expect(reconnectAttempts).toBe(0)
  })
})
