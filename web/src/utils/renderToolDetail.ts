// Custom rendering for tool_use block details in chat messages.
// All backends normalize tool names and input field names in their parsers,
// so we can assume canonical field names here: file_path, command, old_string, etc.

import { hljs } from './globals.ts'
import { escapeHtml } from './html.ts'
import { detectLang, highlightLine } from './diff.ts'
import { resolveFilePath, fileOpenButtonHtml } from '@/composables/useFilePathAnnotation.ts'
import { store } from '@/stores/app.ts'

// ────────────────────────────────────────────────────────────
// Tool renderer functions
// ────────────────────────────────────────────────────────────

/**
 * Render Edit tool input as a diff view.
 * Shows old_string lines in red, new_string lines in green.
 * No line numbers, no +/- prefix — color-only distinction.
 * File path is clickable to open the file.
 */
function renderEditDiff(input: Record<string, any>): string {
  const filePath = input.file_path || ''
  const oldStr = input.old_string || ''
  const newStr = input.new_string || ''
  const replaceAll = input.replace_all

  // Resolve file path for click-to-open
  const projectRoot = store.state.projectRoot || ''
  const resolvedPath = resolveFilePath(filePath, projectRoot)
  const displayPath = resolvedPath || filePath.replace(/^\.\//, '')

  // Detect language for syntax highlighting
  const lang = detectLang(filePath)

  // Build header
  let header = '<div class="tool-file-header">'
  header += `<span class="tool-file-path">${escapeHtml(displayPath)}</span>`
  if (resolvedPath) {
    header += fileOpenButtonHtml(resolvedPath)
  }
  if (replaceAll) {
    header += '<span class="edit-diff-replace-all" title="Replace all occurrences">replaceAll</span>'
  }
  header += '</div>'

  // Build diff body (scroll wrapper + inner content)
  let body = '<div class="edit-diff-scroll"><div class="edit-diff-body">'

  // Old lines (red)
  if (oldStr) {
    const oldLines = oldStr.split('\n')
    for (const line of oldLines) {
      body += `<div class="edit-diff-del">${highlightLine(line, lang)}</div>`
    }
  }

  // New lines (green)
  if (newStr) {
    const newLines = newStr.split('\n')
    for (const line of newLines) {
      body += `<div class="edit-diff-add">${highlightLine(line, lang)}</div>`
    }
  }

  body += '</div></div>'

  return `<div class="edit-diff-view">${header}${body}</div>`
}

/**
 * Render Bash tool input as a terminal-style view.
 * Shows description (if any) and command with $ prefix.
 */
function renderBashTerminal(input: Record<string, any>): string {
  const command = input.command || ''
  const description = input.description || ''

  let html = '<div class="bash-terminal-view">'

  if (description) {
    html += `<div class="bash-terminal-desc">${escapeHtml(description)}</div>`
  }

  html += '<div class="bash-terminal-body">'
  html += '<span class="bash-prompt">$</span>'

  // Highlight command as bash
  if (command) {
    try {
      html += hljs.highlight(command, { language: 'bash', ignoreIllegals: true }).value
    } catch {
      html += escapeHtml(command)
    }
  }

  html += '</div></div>'

  return html
}

/**
 * Build a clickable file path header used by Read/Write/Edit views.
 */
function filePathHeader(input: Record<string, any>, extraBadge = ''): string {
  const filePath = input.file_path || ''
  const projectRoot = store.state.projectRoot || ''
  const resolvedPath = resolveFilePath(filePath, projectRoot)
  const displayPath = resolvedPath || filePath.replace(/^\.\//, '')

  let html = '<div class="tool-file-header">'
  html += `<span class="tool-file-path">${escapeHtml(displayPath)}</span>`
  if (resolvedPath) {
    html += fileOpenButtonHtml(resolvedPath)
  }
  if (extraBadge) html += extraBadge
  html += '</div>'
  return html
}

/**
 * Render Read tool input as a file preview view.
 * Shows clickable file path + syntax-highlighted content preview.
 */
function renderReadPreview(input: Record<string, any>): string {
  const filePath = input.file_path || ''
  const lang = detectLang(filePath)

  let html = '<div class="file-preview-view">'
  html += filePathHeader(input)

  // Content preview body
  html += '<div class="file-preview-body">'
  const content = input.content || ''
  if (content) {
    const lines = content.split('\n')
    for (const line of lines) {
      html += `<div class="file-preview-line">${highlightLine(line, lang)}</div>`
    }
  } else {
    // No content field — show offset/limit info if present
    const parts: string[] = []
    if (input.offset) parts.push(`从第 ${input.offset} 行`)
    if (input.limit) parts.push(`读取 ${input.limit} 行`)
    if (parts.length > 0) {
      html += `<div class="file-preview-meta">${parts.join('，')}</div>`
    }
  }
  html += '</div></div>'

  return html
}

/**
 * Render Write tool input as a file write view.
 * Shows clickable file path + syntax-highlighted content to write.
 */
function renderWritePreview(input: Record<string, any>): string {
  const filePath = input.file_path || ''
  const lang = detectLang(filePath)

  let html = '<div class="file-write-view">'
  html += filePathHeader(input, '<span class="file-write-badge">写入</span>')

  html += '<div class="file-write-body">'
  const content = input.content || ''
  if (content) {
    const lines = content.split('\n')
    for (const line of lines) {
      html += `<div class="file-write-line">${highlightLine(line, lang)}</div>`
    }
  }
  html += '</div></div>'

  return html
}

/**
 * Render AskUserQuestion tool input as an interactive question card.
 * Shows question header, question text, and selectable option buttons.
 * Clicking an option is handled by the AskUserQuestion action handler
 * registered at the bottom of this file.
 */
function renderAskUserQuestion(input: Record<string, any>): string {
  const questions = input.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    return '<div class="ask-question-view"><div class="ask-question-empty">（无问题）</div></div>'
  }

  let html = '<div class="ask-question-view">'

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    const header = q.header || ''
    const question = q.question || ''
    const multiSelect = !!q.multiSelect
    const options = Array.isArray(q.options) ? q.options : []

    html += `<div class="ask-question-item" data-multi="${multiSelect}">`

    if (header) {
      html += `<div class="ask-question-header">${escapeHtml(header)}</div>`
    }
    if (question) {
      html += `<div class="ask-question-text">${escapeHtml(question)}</div>`
    }

    if (options.length > 0) {
      html += '<div class="ask-question-options">'
      for (let oi = 0; oi < options.length; oi++) {
        const opt = options[oi]
        const label = typeof opt === 'string' ? opt : (opt.label || '')
        const desc = typeof opt === 'object' ? (opt.description || '') : ''
        html += `<div class="ask-question-option" data-qi="${qi}" data-oi="${oi}" data-label="${escapeHtml(label)}">`
        html += `<span class="ask-option-indicator">${multiSelect ? '☐' : '◯'}</span>`
        html += '<div class="ask-option-content">'
        html += `<span class="ask-option-label">${escapeHtml(label)}</span>`
        if (desc) {
          html += `<span class="ask-option-desc">${escapeHtml(desc)}</span>`
        }
        html += '</div>'
        html += '</div>'
      }
      html += '</div>'
    }

    html += '</div>'
  }

  html += '<button class="ask-question-submit" disabled>提交</button>'
  html += '</div>'

  return html
}

/**
 * Render input as JSON (the fallback for unregistered tools).
 */
function renderJsonFallback(input: any): string {
  if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
    try {
      const highlighted = hljs.highlight('{}', { language: 'json' }).value
      return `<div class="tool-json-body"><code>${highlighted}</code></div>`
    } catch {
      return '<div class="tool-json-body"><code>{}</code></div>'
    }
  }
  try {
    const json = JSON.stringify(input, null, 2)
    const highlighted = hljs.highlight(json, { language: 'json' }).value
    return `<div class="tool-json-body"><code>${highlighted}</code></div>`
  } catch {
    return `<div class="tool-json-body"><code>${escapeHtml(JSON.stringify(input, null, 2))}</code></div>`
  }
}

// ────────────────────────────────────────────────────────────
// Tool registries (renderer + action handler + auto-expand)
// ────────────────────────────────────────────────────────────
// Three parallel registries for tool customization:
//   TOOL_RENDERERS       — specialized HTML rendering for tool detail area
//   TOOL_ACTION_HANDLERS — interactive click handling inside v-html content
//   TOOL_AUTO_EXPAND     — tools whose detail area should auto-expand
//
// All lookups are case-insensitive. New tools register once;
// no changes needed in generic components (ContentBlocks, ChatPanel).

export type ToolRenderer = (input: Record<string, any>) => string

export type ToolActionHandler = (
  event: Event,
  emit: (type: string, payload?: any) => void
) => boolean

const TOOL_RENDERERS: Record<string, ToolRenderer> = {}
const TOOL_ACTION_HANDLERS: Record<string, ToolActionHandler> = {}
const TOOL_AUTO_EXPAND: Set<string> = new Set()

/**
 * Register a renderer for a tool type.
 * Tool names are matched case-insensitively.
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer) {
  TOOL_RENDERERS[toolName.toLowerCase()] = renderer
}

/**
 * Register an action handler for a tool type.
 * Tool names are matched case-insensitively.
 */
export function registerToolActionHandler(toolName: string, handler: ToolActionHandler) {
  TOOL_ACTION_HANDLERS[toolName.toLowerCase()] = handler
}

/**
 * Dispatch a click event to the registered tool action handler.
 * Returns true if a handler consumed the event, false otherwise.
 */
export function handleToolAction(toolName: string, event: Event, emit: (type: string, payload?: any) => void): boolean {
  const handler = TOOL_ACTION_HANDLERS[toolName.toLowerCase()]
  if (!handler) return false
  return handler(event, emit)
}

/**
 * Check if a tool type should auto-expand its detail area
 * (bypass the normal click-to-expand toggle).
 */
export function shouldAutoExpandTool(toolName: string): boolean {
  return TOOL_AUTO_EXPAND.has(toolName.toLowerCase())
}

/**
 * Format tool_use input for display in the expanded tool detail area.
 * Looks up the tool name in the renderer registry; falls back to JSON.
 */
export function formatToolInput(input: any, toolName?: string): string {
  if (toolName) {
    const renderer = TOOL_RENDERERS[toolName.toLowerCase()]
    if (renderer && input && typeof input === 'object') {
      return renderer(input)
    }
  }
  return renderJsonFallback(input)
}

// ── Tool registrations ──

registerToolRenderer('Edit', renderEditDiff)
registerToolRenderer('Bash', renderBashTerminal)
registerToolRenderer('Read', renderReadPreview)
registerToolRenderer('Write', renderWritePreview)
registerToolRenderer('AskUserQuestion', renderAskUserQuestion)

TOOL_AUTO_EXPAND.add('askuserquestion')

// ── AskUserQuestion action handler ──

function updateAskSubmitState(view: Element) {
  const items = view.querySelectorAll('.ask-question-item')
  let allAnswered = true
  for (const item of items) {
    if (!item.querySelector('.ask-question-option.selected')) {
      allAnswered = false
      break
    }
  }
  const submitBtn = view.querySelector('.ask-question-submit') as HTMLButtonElement | null
  if (submitBtn) {
    submitBtn.disabled = !allAnswered
  }
}

registerToolActionHandler('AskUserQuestion', (event, emit) => {
  const target = event.target as HTMLElement

  // Option click
  const optionEl = target.closest('.ask-question-option') as HTMLElement | null
  if (optionEl) {
    event.stopPropagation()
    event.preventDefault()
    const view = optionEl.closest('.ask-question-view')
    if (view && !view.classList.contains('ask-submitted')) {
      const multiSelect = optionEl.closest('.ask-question-item')?.dataset.multi === 'true'

      if (multiSelect) {
        optionEl.classList.toggle('selected')
        const indicator = optionEl.querySelector('.ask-option-indicator')
        if (indicator) indicator.textContent = optionEl.classList.contains('selected') ? '☑' : '☐'
      } else {
        const siblings = optionEl.parentElement!.querySelectorAll('.ask-question-option')
        for (const s of siblings) {
          s.classList.remove('selected')
          const ind = s.querySelector('.ask-option-indicator')
          if (ind) ind.textContent = '◯'
        }
        optionEl.classList.add('selected')
        const indicator = optionEl.querySelector('.ask-option-indicator')
        if (indicator) indicator.textContent = '◉'
      }

      updateAskSubmitState(view)
    }
    return true
  }

  // Submit click
  const submitBtn = target.closest('.ask-question-submit') as HTMLElement | null
  if (submitBtn) {
    event.stopPropagation()
    event.preventDefault()
    const view = submitBtn.closest('.ask-question-view')
    if (view && !view.classList.contains('ask-submitted')) {
      const answers: string[] = []
      const items = view.querySelectorAll('.ask-question-item')
      for (const item of items) {
        const selected = item.querySelectorAll('.ask-question-option.selected')
        const labels = [...selected].map(el => (el as HTMLElement).dataset.label)
        if (labels.length > 0) {
          answers.push(labels.join(', '))
        }
      }
      if (answers.length === 0) return true

      // Mark as submitted
      view.classList.add('ask-submitted')
      const allOptions = view.querySelectorAll('.ask-question-option')
      for (const opt of allOptions) {
        ;(opt as HTMLElement).style.pointerEvents = 'none'
        if (!opt.classList.contains('selected')) {
          ;(opt as HTMLElement).style.opacity = '0.4'
        }
      }
      submitBtn.textContent = '已提交'
      ;(submitBtn as HTMLButtonElement).disabled = true

      emit('send-message', answers.join('\n'))
    }
    return true
  }

  // Not an AskUserQuestion-specific click — fall through
  return false
})
