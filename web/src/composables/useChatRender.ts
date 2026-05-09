import { ref, reactive, nextTick, watch } from 'vue'
import { baseName } from '@/utils/path.ts'
import { marked, DOMPurify, mermaid } from '@/utils/globals.ts'
import { formatToolInput } from '@/utils/renderToolDetail.ts'
import { renderKatexInString, renderMermaidInElement } from '@/composables/useMarkdownRenderer.ts'
import { useFilePathAnnotation } from '@/composables/useFilePathAnnotation.ts'
import { gt } from '@/composables/useLocale'
import { store } from '@/stores/app.ts'

export function useChatRender(options) {
  const { messages, theme, currentSessionId } = options
  const { annotateFilePaths, verifyFilePaths } = useFilePathAnnotation()

  const blockTasks = reactive({})
  const blockAskQuestions = reactive({})
  const expandedTools = ref({})
  let lastRenderedCount = 0

  // Re-render when theme changes
  watch(theme, () => {
    updateRenderedContents(true)
  })

  // Sync blockTasks with latest task data from store (global polling updates store.state.tasks).
  // Use a tasks Map for O(1) lookup instead of .find() on every key, and avoid deep: true
  // which triggers expensive recursive comparison on the entire tasks array every 2s.
  watch(() => store.state.tasks, (tasks) => {
    if (!tasks || tasks.length === 0) return
    const keys = Object.keys(blockTasks)
    if (keys.length === 0) return
    // Build a Map for O(1) task lookup by ID
    const taskMap = new Map(tasks.map(t => [t.id, t]))
    let changed = false
    for (const key of keys) {
      const entry = blockTasks[key]
      if (entry.deleted || !entry.task) continue
      const updated = taskMap.get(entry.taskId)
      if (!updated) {
        entry.deleted = true
        changed = true
      } else if (updated !== entry.task) {
        entry.task = updated
        changed = true
      }
    }
    // If nothing changed, skip reactive notification to prevent unnecessary re-renders
    // (Vue's reactive() tracks mutations; only trigger if we actually changed something)
  })

  async function fetchTaskData(key, taskId) {
    if (blockTasks[key]?.task || blockTasks[key]?.loading) return
    blockTasks[key] = { taskId, task: null, loading: true, deleted: false }
    try {
      const resp = await fetch(`/api/tasks/${taskId}`)
      if (resp.status === 404) {
        blockTasks[key].deleted = true
        blockTasks[key].loading = false
        return
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      blockTasks[key].task = await resp.json()
    } catch {
      blockTasks[key].deleted = true
    } finally {
      blockTasks[key].loading = false
    }
  }

  async function refreshTaskData(taskId) {
    for (const key of Object.keys(blockTasks)) {
      if (blockTasks[key].taskId === taskId && !blockTasks[key].deleted) {
        try {
          const resp = await fetch(`/api/tasks/${taskId}`)
          if (resp.status === 404) {
            blockTasks[key].deleted = true
            blockTasks[key].task = null
          } else if (resp.ok) {
            blockTasks[key].task = await resp.json()
          }
        } catch { /* ignore */ }
      }
    }
  }

  function renderMarkdown(text) {
    let html = marked.parse((text || '').trim())
    html = renderKatexInString(html)
    html = DOMPurify.sanitize(html, { ADD_TAGS: ['math', 'button'], ADD_ATTR: ['data-file-path', 'title'] })
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')
    html = html.replace(/<img([^>]*)>/g, (match, attrs) => {
      let cleanAttrs = attrs.replace(/\s*style="[^"]*"/i, '').replace(/\s*class="[^"]*"/i, '')
      return `<img${cleanAttrs} style="max-width: 200px; max-height: 200px; object-fit: cover; border-radius: 6px; margin: 4px 0; cursor: pointer;" class="chat-img-thumbnail">`
    })
    const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.opus']
    html = html.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, (match, href, text) => {
      const lower = href.toLowerCase()
      if (audioExts.some(ext => lower.endsWith(ext))) {
        return `<div class="chat-audio-wrapper"><audio src="${href}" controls class="chat-audio-player"></audio></div>`
      }
      return match
    })
    const { html: annotatedHtml, detectedPaths } = annotateFilePaths(html, { projectRoot: store.state.projectRoot })
    html = annotatedHtml
    if (detectedPaths.length > 0) {
      const uniquePaths = [...new Set(detectedPaths)]
      nextTick(() => {
        const el = document.getElementById('aiChatMessages')
        if (el) verifyFilePaths(uniquePaths, el)
      })
    }
    return html
  }

  function renderTextBlock(text, msgId, blockIdx) {
    // Detect <scheduled-task id="..." /> tags — match optional "task-" prefix before UUID
    // to avoid false positives when AI mentions the tag format in prose
    // (e.g. `<scheduled-task id="..."/>` as documentation)
    const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    const scheduledTaskRegex = new RegExp(`<scheduled-task\\s+id="(task-)?(${UUID_RE})"\\s*/>`, 'gi')
    let tagIdx = 0
    let match

    while ((match = scheduledTaskRegex.exec(text)) !== null) {
      const taskId = match[1] ? match[0].match(/id="([^"]+)"/)[1] : match[2]
      const key = `${msgId}-${blockIdx}-${tagIdx}`
      fetchTaskData(key, taskId)
      tagIdx++
    }

    // Detect <ask-question> tags — strip from text and store for interactive rendering.
    // Two-pass strategy:
    //   1. Try the standard regex requiring a closing </ask-question> tag.
    //   2. If that fails, try a fallback regex that treats end-of-text as the
    //      implicit closing boundary — AI models sometimes omit the closing tag,
    //      especially when the JSON payload ends at the text block boundary.
    // The fallback iterates from the LAST <ask-question> occurrence backward,
    // because earlier ones may be prose references (e.g. "Forces structured
    // `<ask-question>` XML tags") rather than actual structured questions.
    // It also validates that the captured content starts with '{' or '['
    // (after stripping code fences) to avoid false positives.
    let askMatch = text.match(/<ask-question\b[^>]*>([\s\S]*?)<\/ask-question>/)
    let askFullTagRegex = /<ask-question\b[^>]*>[\s\S]*?<\/ask-question>/
    if (!askMatch) {
      // Fallback: unclosed <ask-question> — find the LAST occurrence and capture
      // everything from it to end-of-text. Earlier matches are likely prose references.
      const allOpenTags = [...text.matchAll(/<ask-question\b[^>]*>/g)]
      for (let j = allOpenTags.length - 1; j >= 0; j--) {
        const startIdx = allOpenTags[j].index
        const afterTag = text.slice(startIdx)
        const subMatch = afterTag.match(/<ask-question\b[^>]*>([\s\S]+)$/)
        if (!subMatch) continue
        let probe = subMatch[1].trim()
        if (probe.startsWith('```')) {
          const nlIdx = probe.indexOf('\n')
          if (nlIdx !== -1) probe = probe.slice(nlIdx + 1).trim()
        }
        if (!probe.startsWith('{') && !probe.startsWith('[')) {
          continue // Not a real payload, just prose mentioning the tag name
        }
        // Valid unclosed match found — record position and content
        askMatch = subMatch
        askMatch._startIdx = startIdx // custom property for cleanText extraction
        break
      }
    }
    if (askMatch) {
      const askKey = `${msgId}-${blockIdx}`
      if (!blockAskQuestions[askKey]) {
        try {
          let askContent = askMatch[1].trim()
          // Strip markdown code fences (```json ... ```) that some models wrap around the JSON
          if (askContent.startsWith('```')) {
            const nlIdx = askContent.indexOf('\n')
            if (nlIdx !== -1) askContent = askContent.slice(nlIdx + 1).trim()
            const lastFence = askContent.lastIndexOf('```')
            if (lastFence !== -1) askContent = askContent.slice(0, lastFence).trim()
          }
          const questions = JSON.parse(askContent)
          if (questions.questions && Array.isArray(questions.questions)) {
            blockAskQuestions[askKey] = questions
          }
        } catch (e) {
          console.error('Failed to parse ask-question:', e)
        }
      }
      // Remove the matched tag from the rendered text.
      // For standard matches (with closing tag), use regex replacement.
      // For unclosed fallback matches, truncate from the tag position to end-of-text.
      let cleanText
      if (askMatch._startIdx !== undefined) {
        cleanText = text.slice(0, askMatch._startIdx).trim()
      } else {
        cleanText = text.replace(askFullTagRegex, '').trim()
      }
      // Strip scheduled-task tags (with optional task- prefix) from the remaining text
      cleanText = cleanText.replace(/<scheduled-task\s+id="(task-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\s*\/>/gi, '').trim()
      return cleanText ? renderMarkdown(cleanText) : ''
    }
    // No ask-question: strip scheduled-task tags (with optional task- prefix) and render
    const cleanText = text.replace(/<scheduled-task\s+id="(task-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\s*\/>/gi, '').trim()
    return cleanText ? renderMarkdown(cleanText) : ''
  }

  function parseAssistantContent(content) {
    if (!content) return { blocks: [], metadata: null }
    try {
      const parsed = JSON.parse(content)
      if (parsed.blocks && Array.isArray(parsed.blocks)) {
        const mapped = parsed.blocks.map(b => {
          if (b.type === 'tool_use') {
            // DB-loaded blocks from finished sessions: if done is missing or false,
            // the session ended without receiving the tool result — mark as incomplete
            if (b.done === undefined || b.done === false) b.done = true
            // Backward compat: old Codex format had output in input.output
            if (!b.output && b.input && b.input.output) {
              b.output = b.input.output
              delete b.input.output
            }
          }
          return b
        })
        // Deduplicate tool_use blocks by ID — old scheduled-task data could have
        // two blocks with the same ID (one empty input from start event, one with
        // content from stop event). Merge by keeping the richer version.
        const result = []
        const toolIndex = new Map() // id -> index in result
        for (const b of mapped) {
          if (b.type === 'tool_use' && b.id) {
            const prevIdx = toolIndex.get(b.id)
            if (prevIdx !== undefined) {
              const prev = result[prevIdx]
              const prevEmpty = !prev.input || Object.keys(prev.input).length === 0
              const currEmpty = !b.input || Object.keys(b.input).length === 0
              if (currEmpty && !prevEmpty) continue          // keep previous (has data)
              if (!currEmpty && prevEmpty) {                  // replace with current
                prev.input = b.input
                prev.done = b.done
                prev.name = b.name || prev.name
                if (b.output) prev.output = b.output
                if (b.status) prev.status = b.status
                continue
              }
              // Both have data or both empty — merge: prefer done=true
              if (b.done) prev.done = true
              if (!currEmpty) prev.input = b.input
              if (b.output) prev.output = b.output
              if (b.status) prev.status = b.status
              continue
            }
            toolIndex.set(b.id, result.length)
          }
          result.push(b)
        }
        return {
          blocks: result,
          metadata: parsed.metadata || null,
          cancelled: parsed.cancelled || false
        }
      }
    } catch {}
    return { blocks: [{ type: 'text', text: content }], metadata: null }
  }

  function extractScheduledTasks(msgs) {
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.blocks && !msg.streaming) {
        for (let bi = 0; bi < msg.blocks.length; bi++) {
          const block = msg.blocks[bi]
          if (block.type === 'text') {
            // Extract <scheduled-task id="..." /> tags (with optional "task-" prefix before UUID).
            // <ask-question> parsing is handled lazily in renderTextBlock()
            // to avoid duplicating expensive regex work on every session load.
            const scheduledTaskRegex = /<scheduled-task\s+id="(task-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\s*\/>/gi
            let tagIdx = 0
            let match
            scheduledTaskRegex.lastIndex = 0
            while ((match = scheduledTaskRegex.exec(block.text || '')) !== null) {
              const taskId = match[1] ? match[0].match(/id="([^"]+)"/)[1] : match[2]
              const key = `${msg.id}-${bi}-${tagIdx}`
              fetchTaskData(key, taskId)
              tagIdx++
            }
          }
        }
      }
    }
  }

  function updateRenderedContents(forceFullRender = false) {
    // Defensive: if count diverged (e.g. loadHistory replaced messages),
    // force a full rebuild.
    if (!forceFullRender && lastRenderedCount > messages.value.length) {
      forceFullRender = true
    }
    if (forceFullRender) {
      lastRenderedCount = messages.value.length
      nextTick(() => {
        const el = document.getElementById('aiChatMessages')
        if (el) renderMermaidInElement(el, 'chat-mermaid')
      })
    } else {
      const startIdx = lastRenderedCount
      const newMsgCount = messages.value.length - startIdx

      if (newMsgCount <= 0) return

      lastRenderedCount = messages.value.length

      nextTick(() => {
        const el = document.getElementById('aiChatMessages')
        if (el) {
          const newBlocks = el.querySelectorAll(`.chat-message:nth-last-child(n+${startIdx + 1}) pre.mermaid:not([data-rendered])`)
          if (newBlocks.length > 0) {
            renderMermaidInElement(el, 'chat-mermaid', newBlocks)
          }
        }
      })
    }
  }

  function toggleToolDetail(key) {
    expandedTools.value[key] = !expandedTools.value[key]
  }

  function toolCallSummary(block) {
    if (!block.input) return ''
    const name = (block.name || '').toLowerCase()
    // AskUserQuestion: show first question header
    if (name === 'askuserquestion' && Array.isArray(block.input.questions) && block.input.questions.length > 0) {
      const q = block.input.questions[0]
      const header = q.header || ''
      const question = q.question || ''
      if (header) return header
      if (question) return question.length > 60 ? question.slice(0, 57) + '...' : question
    }
    // Prefer description (human-readable intent) over raw input values
    if (block.input.description) return block.input.description
    const obj = block.input
    if (obj.file_path) return baseName(obj.file_path)
    if (obj.command) return obj.command.length > 60 ? obj.command.slice(0, 57) + '...' : obj.command
    // Grep/Glob: show pattern
    if (obj.pattern) return obj.pattern.length > 60 ? obj.pattern.slice(0, 57) + '...' : obj.pattern
    // WebSearch: show query
    if (obj.query) return obj.query.length > 60 ? obj.query.slice(0, 57) + '...' : obj.query
    // WebFetch: show url
    if (obj.url) return obj.url.length > 60 ? obj.url.slice(0, 57) + '...' : obj.url
    // Skill: show skill name
    if (obj.skill) return obj.skill
    // Agent: show description or prompt summary (description already handled above)
    if (obj.prompt && name === 'agent') return obj.prompt.length > 60 ? obj.prompt.slice(0, 57) + '...' : obj.prompt
    if (obj.path) return baseName(obj.path)
    if (obj.src_path && obj.dst_path) return `${baseName(obj.src_path)} → ${baseName(obj.dst_path)}`
    const firstVal = Object.values(obj)[0]
    if (typeof firstVal === 'string' && firstVal.length < 80) return firstVal
    return ''
  }

  function hasImagesInContent(content) {
    return content && content.includes('![')
  }

  function formatMessageTime(createdAt) {
    const date = new Date(createdAt)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)

    if (diffMins < 1) return gt('time.justNow')
    if (diffMins < 60) return gt('time.minutesAgo', { count: diffMins })

    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return gt('time.hoursAgo', { count: diffHours })

    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return gt('time.daysAgo', { count: diffDays })

    const month = date.getMonth() + 1
    const day = date.getDate()
    const hour = date.getHours().toString().padStart(2, '0')
    const minute = date.getMinutes().toString().padStart(2, '0')
    return `${month}/${day} ${hour}:${minute}`
  }

  function formatDetailTime(createdAt) {
    const date = new Date(createdAt)
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hour = date.getHours().toString().padStart(2, '0')
    const minute = date.getMinutes().toString().padStart(2, '0')
    const second = date.getSeconds().toString().padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`
  }

  function humanizeCron(expr) {
    const parts = expr.split(' ')
    if (parts.length !== 5) return expr
    const [min, hour, day, month, weekday] = parts
    if (min.startsWith('*/') && hour === '*') return gt('cron.everyMinutes', { count: min.slice(2) })
    if (hour.startsWith('*/') && min === '0') return gt('cron.everyHours', { count: hour.slice(2) })
    if (min === '0' && !hour.includes('/') && day === '*' && month === '*' && weekday === '*') return gt('cron.daily', { time: `${hour}:00` })
    if (min === '0' && weekday === '1-5') return gt('cron.weekdays', { time: `${hour}:00` })
    return expr
  }

  function repeatLabel(mode, maxRuns) {
    if (mode === 'once') return gt('task.repeat.onceExecute')
    if (mode === 'limited') return gt('task.repeat.timesThenStop', { count: maxRuns })
    return gt('task.repeat.unlimitedTimes')
  }

  function truncate(str, len) {
    if (!str) return ''
    const runes = [...str]
    return runes.length > len ? runes.slice(0, len).join('') + '...' : str
  }

  return {
    blockTasks,
    blockAskQuestions,
    expandedTools,
    renderMarkdown,
    renderTextBlock,
    parseAssistantContent,
    extractScheduledTasks,
    refreshTaskData,
    updateRenderedContents,
    toggleToolDetail,
    formatToolInput,
    toolCallSummary,
    hasImagesInContent,
    formatMessageTime,
    formatDetailTime,
    humanizeCron,
    repeatLabel,
    truncate,
  }
}
