import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('TerminalPanel xterm selection defaults', () => {
  it('does not force xterm selection to line mode', () => {
    const source = readFileSync(resolve(__dirname, '../terminal/TerminalPanel.vue'), 'utf8')

    expect(source).not.toContain("selectionStyle: 'line'")
  })
})
