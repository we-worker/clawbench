import { describe, expect, it } from 'vitest'
import { escapeHtml } from '@/utils/html.ts'

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b')
  })

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#039;s")
  })

  it('escapes all special characters in one string', () => {
    expect(escapeHtml('<div class="test">&\'</div>')).toBe('&lt;div class=&quot;test&quot;&gt;&amp;&#039;&lt;/div&gt;')
  })

  it('returns safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('handles numbers by converting to string', () => {
    // String(42) = '42', no special chars
    expect(escapeHtml(String(42))).toBe('42')
  })
})
