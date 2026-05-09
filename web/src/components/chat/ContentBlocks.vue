<template>
  <div class="content-blocks">
    <template v-for="(block, bi) in blocks" :key="bi">
      <!-- Thinking block -->
      <div v-if="block.type === 'thinking'" class="chat-thinking" :class="{ expanded: thinkingExpanded[key(bi)] }" @click.stop="toggleThinking(key(bi))">
        <div class="thinking-header">
          <CircleHelp :size="12" />
          <span class="thinking-label">{{ t('chat.message.deepThinking') }}</span>
          <ChevronDown :size="12" class="thinking-chevron" />
        </div>
        <pre v-if="thinkingExpanded[key(bi)]" class="thinking-text">{{ block.text }}</pre>
      </div>
      <!-- Tool use block -->
      <template v-else-if="block.type === 'tool_use'">
        <div class="chat-tool-call" :class="{ done: block.done, incomplete: block.done && !hasToolResult(block), 'tool-error': block.status === 'error' }" :data-category="getToolIcon(block.name).category" @click.stop="$emit('toggle-tool', key(bi))">
          <component :is="getToolIcon(block.name).icon" :size="12" class="tool-icon" />
          <span class="tool-name">{{ block.name }}</span>
          <span v-if="toolCallSummary(block)" class="tool-summary">{{ toolCallSummary(block) }}</span>
          <!-- Loading: spinner -->
          <span v-if="!block.done" class="tool-spinner"></span>
          <!-- Done with error: red X -->
          <XCircle v-else-if="block.status === 'error'" :size="14" color="#ef4444" class="tool-error-icon" />
          <!-- Done with result: green check -->
          <CheckCircle2 v-else-if="hasToolResult(block)" :size="14" color="#22c55e" class="tool-check" />
          <!-- Done without result: yellow warning -->
          <AlertCircle v-else :size="14" color="#f59e0b" class="tool-warn" />
        </div>
        <div v-if="expandedTools[key(bi)] || shouldAutoExpand(block)" class="tool-detail" :data-tool-name="block.name" @click="handleToolDetailClick">
          <div v-html="formatToolInput(block.input, block.name)"></div>
          <!-- Tool output section -->
          <div v-if="block.output" class="tool-output-section">
            <div class="tool-output-header">
              <span class="tool-output-label">output</span>
              <span v-if="block.status === 'error'" class="tool-output-status tool-output-error">error</span>
              <span v-else class="tool-output-status tool-output-success">ok</span>
            </div>
            <div class="tool-output-body" v-html="formatToolOutput(block.output, block.name)"></div>
          </div>
        </div>
      </template>
      <!-- Error block -->
      <div v-else-if="block.type === 'error'" class="chat-error-card">
        <AlertTriangle :size="14" class="error-icon" />
        <span class="error-text">{{ getWarningText(block) }}</span>
      </div>
      <!-- Warning block: severe (disconnect/timeout/restart) renders as error-level red -->
      <div v-else-if="block.type === 'warning' && isSevereWarning(block)" class="chat-error-card">
        <AlertTriangle :size="14" class="error-icon" />
        <span class="error-text">{{ getWarningText(block) }}</span>
      </div>
      <!-- Warning block: normal (parse errors, stderr) renders as amber -->
      <div v-else-if="block.type === 'warning'" class="chat-warning-card">
        <AlertCircle :size="14" class="warning-icon" />
        <span class="warning-text">{{ getWarningText(block) }}</span>
      </div>
      <!-- Scheduled task card(s) (inline in message) — must come before generic text block -->
      <template v-else-if="block.type === 'text' && hasScheduledTasks(bi)">
        <div v-if="getBlockHtml(bi, block)" v-html="getBlockHtml(bi, block)"></div>
        <div v-for="(sKey, sIdx) in scheduledTaskKeys(bi)" :key="sIdx" class="scheduled-task-card" :class="{ deleted: blockTasks[sKey].deleted }">
          <div class="stask-header" @click="!blockTasks[sKey].deleted && !blockTasks[sKey].loading && blockTasks[sKey].task && $emit('edit-task', blockTasks[sKey].taskId)">
            <span v-if="blockTasks[sKey].deleted" class="stask-icon">🗑️</span>
            <span v-else class="stask-icon">⏰</span>
            <template v-if="blockTasks[sKey].deleted">{{ t('chat.contentBlocks.taskDeleted') }}</template>
            <template v-else-if="blockTasks[sKey].loading">{{ t('chat.contentBlocks.loading') }}</template>
            <template v-else>{{ blockTasks[sKey].task?.name || t('chat.contentBlocks.scheduledTaskCreated') }}</template>
            <button v-if="!blockTasks[sKey].deleted && !blockTasks[sKey].loading && blockTasks[sKey].task"
                    class="stask-history-btn" @click.stop="$emit('view-history', blockTasks[sKey].taskId)" :title="t('task.exec.title')">
              <History :size="14" />
            </button>
            <button v-if="!blockTasks[sKey].deleted && !blockTasks[sKey].loading && blockTasks[sKey].task"
                    class="stask-delete-btn" @click.stop="$emit('task-action', blockTasks[sKey].taskId, 'delete')" :title="t('chat.contentBlocks.delete')">
              <Trash2 :size="13" />
            </button>
          </div>
          <div v-if="!blockTasks[sKey].deleted && !blockTasks[sKey].loading && blockTasks[sKey].task" class="stask-body" @click="$emit('edit-task', blockTasks[sKey].taskId)">
            <div class="stask-row"><strong>{{ t('chat.contentBlocks.frequency') }}</strong>{{ humanizeCron(blockTasks[sKey].task.cronExpr) }}</div>
            <div class="stask-row"><strong>{{ t('chat.contentBlocks.executor') }}</strong>{{ getAgentIcon(blockTasks[sKey].task.agentId) }} {{ getAgentName(blockTasks[sKey].task.agentId) }}</div>
            <div class="stask-row"><strong>{{ t('chat.contentBlocks.repeat') }}</strong>{{ repeatLabel(blockTasks[sKey].task.repeatMode, blockTasks[sKey].task.maxRuns) }}</div>
            <div class="stask-row"><strong>{{ t('chat.contentBlocks.status') }}</strong><span class="stask-status-dot" :class="statusClass(blockTasks[sKey].task)"></span>{{ statusLabel(blockTasks[sKey].task) }}</div>
            <div v-if="blockTasks[sKey].task.lastRunAt" class="stask-row"><strong>{{ t('chat.contentBlocks.lastRun') }}</strong>{{ formatTime(blockTasks[sKey].task.lastRunAt) }}</div>
            <div v-if="blockTasks[sKey].task.nextRunAt" class="stask-row"><strong>{{ t('chat.contentBlocks.nextRun') }}</strong>{{ formatTime(blockTasks[sKey].task.nextRunAt) }}</div>
            <div class="stask-actions">
              <button v-if="blockTasks[sKey].task.status === 'active'" class="stask-action-btn" @click.stop="$emit('task-action', blockTasks[sKey].taskId, 'pause')">{{ t('chat.contentBlocks.pause') }}</button>
              <button v-if="blockTasks[sKey].task.status === 'paused'" class="stask-action-btn" @click.stop="$emit('task-action', blockTasks[sKey].taskId, 'resume')">{{ t('chat.contentBlocks.resume') }}</button>
              <button v-if="blockTasks[sKey].task.status === 'active' || blockTasks[sKey].task.status === 'paused'" class="stask-action-btn" @click.stop="$emit('task-action', blockTasks[sKey].taskId, 'trigger')">{{ t('chat.contentBlocks.trigger') }}</button>
            </div>
          </div>
        </div>
      </template>
      <!-- Ask question card (from <ask-question> XML tag in text) — must come before generic text block -->
      <template v-else-if="block.type === 'text' && blockAskQuestions[blockTaskKey(bi)]">
        <!-- Surrounding text (with ask-question tag stripped) -->
        <div v-if="getBlockHtml(bi, block)" v-html="getBlockHtml(bi, block)"></div>
        <div class="chat-tool-call done" data-category="ask" @click.stop="$emit('toggle-tool', key(bi))">
          <component :is="getToolIcon('AskUserQuestion').icon" :size="12" class="tool-icon" />
          <span class="tool-name">{{ t('tool.askUser.name') }}</span>
          <span class="tool-summary">{{ askQuestionSummary(blockAskQuestions[blockTaskKey(bi)]) }}</span>
          <CheckCircle2 :size="14" color="#f59e0b" class="tool-warn" />
        </div>
        <div v-if="expandedTools[key(bi)] || true" class="tool-detail" data-tool-name="AskUserQuestion" @click="handleToolDetailClick" v-html="formatToolInput(blockAskQuestions[blockTaskKey(bi)], 'AskUserQuestion')"></div>
      </template>
      <!-- Text block: streaming uses throttled render to avoid UI freeze -->
      <div v-else-if="block.type === 'text'" v-html="getBlockHtml(bi, block)"></div>
    </template>
    <!-- Loading dots while AI is still streaming (not when cancelled) -->
    <div v-if="streaming && !cancelled" class="placeholder-dots"><span></span><span></span><span></span></div>
    <!-- Cancelled marker -->
    <div v-if="cancelled" class="chat-cancelled-mark">{{ t('chat.contentBlocks.cancelled') }}</div>
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { handleToolAction, shouldAutoExpandTool, formatToolOutput } from '@/utils/renderToolDetail.ts'
import { getToolIcon } from '@/utils/icons'
import { CircleHelp, ChevronDown, CheckCircle2, AlertCircle, AlertTriangle, XCircle, Pencil, History, Trash2 } from 'lucide-vue-next'

const { t } = useI18n()

// Reasons that indicate a severe issue (red error-level styling)
const SEVERE_REASONS = new Set(['disconnect', 'timeout', 'restart', 'panic'])

function isSevereWarning(block) {
  return SEVERE_REASONS.has(block.reason)
}

/** Get localized warning/error text. Uses i18n key from block.reason if available, falls back to block.text for backward compat. */
function getWarningText(block) {
  if (block.reason) {
    const key = `chat.contentBlocks.warningReasons.${block.reason}`
    const translated = t(key)
    // t() returns the key itself when not found — fall back to block.text
    if (translated !== key) {
      // For parse_error: append detail after ": " from block.text
      // For backend_exit: append stderr after "\n" from block.text
      if ((block.reason === 'parse_error' || block.reason === 'backend_exit') && block.text) {
        const newlineIdx = block.text.indexOf('\n')
        if (newlineIdx >= 0) {
          return translated + block.text.substring(newlineIdx)
        }
        const colonIdx = block.text.indexOf(': ')
        if (colonIdx >= 0) {
          return translated + ': ' + block.text.substring(colonIdx + 2)
        }
      }
      return translated
    }
  }
  // Fallback: no reason code or no matching i18n key (handles old DB records)
  return block.text || ''
}

function hasToolResult(block) {
  if (!block.done) return false
  if (!block.name) return false
  // New: explicit output from tool_result event
  if (block.output !== undefined && block.output !== '') return true
  // Legacy: blocks without output field (old DB records) — treat as having result
  if (block.output === undefined) {
    if (block.input === null || block.input === undefined) return false
    return true
  }
  // Explicit empty output means the tool ran but produced nothing
  return false
}

function shouldAutoExpand(block) {
  return shouldAutoExpandTool(block.name || '')
}

const props = defineProps({
  blocks: { type: Array, default: () => [] },
  msgId: { type: [String, Number], default: '' },
  msgIndex: { type: Number, default: 0 },
  expandedTools: { type: Object, default: () => ({}) },
  blockTasks: { type: Object, default: () => ({}) },
  blockAskQuestions: { type: Object, default: () => ({}) },
  streaming: { type: Boolean, default: false },
  cancelled: { type: Boolean, default: false },
  // Render functions
  renderTextBlock: { type: Function, required: true },
  formatToolInput: { type: Function, required: true },
  toolCallSummary: { type: Function, required: true },
  humanizeCron: { type: Function, default: () => '' },
  repeatLabel: { type: Function, default: () => '' },
  truncate: { type: Function, default: (s) => s },
  getAgentIcon: { type: Function, default: () => '' },
  getAgentName: { type: Function, default: () => '' },
})

const emit = defineEmits(['toggle-tool', 'edit-task', 'view-history', 'task-action', 'send-message', 'render-flush'])

// Key helper: use msgId if available, otherwise msgIndex
function key(bi) {
  return props.msgId ? `db-${props.msgId}-${bi}` : `local-${props.msgIndex}-${bi}`
}

// Key for blockTasks/blockAskQuestions lookup — prefix format used in useChatRender.ts
function blockTaskKey(bi) {
  return `${props.msgId}-${bi}`
}

// Pre-computed index: block index → sorted array of scheduled task keys.
// Built once when blockTasks keys change, avoiding O(n) scan per block per render.
const taskKeyIndex = computed(() => {
  const msgIdVal = props.msgId
  if (!msgIdVal) return {}
  const index = {}
  const prefix = `${msgIdVal}-`
  for (const k of Object.keys(props.blockTasks)) {
    if (!k.startsWith(prefix)) continue
    // Key format: "msgId-blockIdx-tagIdx" — extract blockIdx
    const rest = k.slice(prefix.length)
    const dashIdx = rest.indexOf('-')
    if (dashIdx === -1) continue
    const bi = rest.slice(0, dashIdx)
    ;(index[bi] || (index[bi] = [])).push(k)
  }
  // Sort each group by key (tag index is already part of the key string)
  for (const bi of Object.keys(index)) index[bi].sort()
  return index
})

// Check if a block has any scheduled tasks
function hasScheduledTasks(bi) {
  return !!(taskKeyIndex.value[bi]?.length)
}

// Return all scheduled task keys for a block, sorted by tag index
function scheduledTaskKeys(bi) {
  return taskKeyIndex.value[bi] || []
}

function statusClass(task) {
  if (task.status === 'active') return 'status-active'
  if (task.status === 'paused') return 'status-paused'
  if (task.status === 'completed') return 'status-completed'
  return ''
}

function statusLabel(task) {
  if (task.status === 'active') {
    const execLabel = t('chat.contentBlocks.statusExecutions', { count: task.runCount })
    if (task.runningCount > 0) return `${t('chat.contentBlocks.statusRunning')} (${execLabel})`
    return `${t('chat.contentBlocks.statusActive')} (${execLabel})`
  }
  if (task.status === 'paused') return t('chat.contentBlocks.statusPaused')
  if (task.status === 'completed') return t('chat.contentBlocks.statusCompleted')
  return task.status
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  const absDiff = Math.abs(diff)
  if (absDiff < 60000) return t('chat.contentBlocks.justNow')
  if (absDiff < 3600000) return `${Math.round(absDiff / 60000)}m ${diff > 0 ? t('chat.contentBlocks.fromNow') : t('chat.contentBlocks.ago')}`
  if (absDiff < 86400000) return `${Math.round(absDiff / 3600000)}h ${diff > 0 ? t('chat.contentBlocks.fromNow') : t('chat.contentBlocks.ago')}`
  return d.toLocaleDateString()
}

const thinkingExpanded = ref({})

function toggleThinking(k) {
  thinkingExpanded.value = { ...thinkingExpanded.value, [k]: !thinkingExpanded.value[k] }
}

/** Generate a short summary for an ask-question block (from <ask-question> tag). */
function askQuestionSummary(input) {
  if (!input || !Array.isArray(input.questions) || input.questions.length === 0) return ''
  const q = input.questions[0]
  const header = q.header || ''
  const question = q.question || ''
  if (header) return header
  if (question) return question.length > 60 ? question.slice(0, 57) + '...' : question
  return ''
}

/** Click inside expanded tool-detail: dispatch to tool action handlers first, then fall through to generic behavior. */
function handleToolDetailClick(event) {
  // Try tool-specific action handler first (via data-tool-name on the .tool-detail container)
  const toolName = event.currentTarget.dataset?.toolName
  if (toolName && handleToolAction(toolName, event, emit)) return
  // Allow file-open buttons to bubble
  if (event.target.closest('.chat-file-open-btn')) {
    return
  }
  event.stopPropagation()
}

// ── Throttled streaming render ──
const blockHtmlCache = ref({})
let _throttleTimer = null
let _throttlePending = false
const THROTTLE_MS = 300

function flushBlockHtml() {
  _throttleTimer = null
  if (!_throttlePending) return
  _throttlePending = false
  const newCache = {}
  for (let i = 0; i < (props.blocks?.length || 0); i++) {
    const block = props.blocks[i]
    if (block.type === 'text') {
      newCache[i] = props.renderTextBlock(block.text, props.msgId, i)
    }
  }
  blockHtmlCache.value = newCache
  // Throttled render flush can change content height (paragraph wrapping, code blocks, etc.)
  // without a corresponding onScrollBottom call from the stream handler. Notify the parent
  // so it can re-sync the scroll position if the user is at the bottom.
  emit('render-flush')
}

function getBlockHtml(bi, block) {
  if (!props.streaming) {
    return props.renderTextBlock(block.text, props.msgId, bi)
  }
  if (blockHtmlCache.value[bi] !== undefined) {
    if (!_throttleTimer) {
      const newCache = { ...blockHtmlCache.value }
      newCache[bi] = props.renderTextBlock(block.text, props.msgId, bi)
      blockHtmlCache.value = newCache
      _throttleTimer = setTimeout(flushBlockHtml, THROTTLE_MS)
    } else {
      _throttlePending = true
    }
    return blockHtmlCache.value[bi]
  }
  const html = props.renderTextBlock(block.text, props.msgId, bi)
  blockHtmlCache.value = { ...blockHtmlCache.value, [bi]: html }
  return html
}

watch(() => props.streaming, (streaming, wasStreaming) => {
  if (wasStreaming && !streaming) {
    if (_throttleTimer) { clearTimeout(_throttleTimer); _throttleTimer = null }
    _throttlePending = false
    blockHtmlCache.value = {}
  }
})

onUnmounted(() => {
  if (_throttleTimer) { clearTimeout(_throttleTimer); _throttleTimer = null }
})
</script>

<style scoped>
.placeholder-dots {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 8px 0 4px;
}
.placeholder-dots span {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-muted, #999);
  animation: dot-bounce 1.2s infinite ease-in-out;
}
.placeholder-dots span:nth-child(1) { animation-delay: 0s; }
.placeholder-dots span:nth-child(2) { animation-delay: 0.2s; }
.placeholder-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

.chat-cancelled-mark {
  display: inline-block;
  font-size: 11px;
  color: var(--text-muted, #999);
  background: var(--bg-tertiary, #f0f0f0);
  padding: 2px 8px;
  border-radius: 4px;
  margin-top: 4px;
}

.chat-error-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin: 2px 0;
  border-left: 3px solid #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.chat-error-card .error-icon {
  flex-shrink: 0;
  color: #ef4444;
}

.chat-error-card .error-text {
  font-size: 12px;
  font-weight: 500;
  color: #dc2626;
}

:root[data-theme="dark"] .chat-error-card {
  border-left-color: #f87171;
  background: rgba(248, 113, 113, 0.1);
}

:root[data-theme="dark"] .chat-error-card .error-icon {
  color: #f87171;
}

:root[data-theme="dark"] .chat-error-card .error-text {
  color: #fca5a5;
}

.chat-warning-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin: 2px 0;
  border-left: 3px solid #f59e0b;
  background: rgba(245, 158, 11, 0.08);
}

.chat-warning-card .warning-icon {
  flex-shrink: 0;
  color: #f59e0b;
}

.chat-warning-card .warning-text {
  font-size: 12px;
  font-weight: 500;
  color: #d97706;
  white-space: pre-wrap;
  word-break: break-word;
}

:root[data-theme="dark"] .chat-warning-card {
  border-left-color: #fbbf24;
  background: rgba(251, 191, 36, 0.1);
}

:root[data-theme="dark"] .chat-warning-card .warning-icon {
  color: #fbbf24;
}

:root[data-theme="dark"] .chat-warning-card .warning-text {
  color: #fcd34d;
}

/* Thinking block */
.chat-thinking {
  background: color-mix(in srgb, var(--accent-color, #0066cc) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-color, #0066cc) 15%, transparent);
  border-radius: 6px;
  margin: 4px 0;
  cursor: pointer;
  overflow: hidden;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.thinking-label {
  font-weight: 500;
}

.thinking-chevron {
  margin-left: auto;
  transition: transform 0.2s;
}

.chat-thinking.expanded .thinking-chevron {
  transform: rotate(180deg);
}

.chat-thinking .thinking-text {
  margin: 0;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid color-mix(in srgb, var(--accent-color, #0066cc) 10%, transparent);
  max-height: 200px;
  overflow-y: auto;
  font-family: inherit;
}

/* Tool calls display */
.chat-tool-call {
  --tool-accent: var(--text-muted);
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--tool-accent) 6%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--tool-accent) 15%, var(--border-color));
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  width: 100%;
  margin-top: 4px;
  overflow: hidden;
}

.chat-tool-call[data-category="file"]     { --tool-accent: var(--accent-color); }
.chat-tool-call[data-category="bash"]     { --tool-accent: #10b981; }
.chat-tool-call[data-category="search"]   { --tool-accent: #8b5cf6; }
.chat-tool-call[data-category="task"]     { --tool-accent: #f59e0b; }
.chat-tool-call[data-category="plan"]     { --tool-accent: var(--accent-color); }
.chat-tool-call[data-category="agent"]    { --tool-accent: #ec4899; }
.chat-tool-call[data-category="skill"]    { --tool-accent: #06b6d4; }
.chat-tool-call[data-category="ask"]      { --tool-accent: #f97316; }
.chat-tool-call[data-category="fallback"] { --tool-accent: var(--text-muted); }

.chat-tool-call:hover {
  background: color-mix(in srgb, var(--tool-accent) 12%, var(--bg-secondary));
}

.chat-tool-call .tool-icon {
    color: color-mix(in srgb, var(--tool-accent) 80%, transparent);
    flex-shrink: 0;
}

.chat-tool-call .tool-name {
  font-weight: 600;
  color: var(--tool-accent);
  font-size: 11px;
}

.chat-tool-call .tool-summary {
  color: var(--text-tertiary, #888);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-tool-call .tool-check {
  flex-shrink: 0;
  margin-left: auto;
}

.chat-tool-call .tool-warn {
  flex-shrink: 0;
  margin-left: auto;
}

.chat-tool-call.incomplete {
  --tool-accent: #f59e0b;
}

.chat-tool-call.tool-error {
  --tool-accent: #ef4444;
}

.chat-tool-call .tool-error-icon {
  flex-shrink: 0;
  margin-left: auto;
}

.tool-detail {
  margin: 2px 0 4px 0;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.4;
  background: var(--bg-primary);
  border-radius: 4px;
  border: 1px solid var(--border-color);
  white-space: normal;
  overflow-x: hidden;
  overflow-y: auto;
  max-height: 150px;
  cursor: default;
}

.tool-detail[data-tool-name="AskUserQuestion"] {
  max-height: 500px;
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-color);
  border-top-color: var(--tool-accent);
  border-radius: 50%;
  animation: tool-spin 0.6s linear infinite;
  flex-shrink: 0;
  margin-left: auto;
}

@keyframes tool-spin {
  to { transform: rotate(360deg); }
}

.scheduled-task-card {
  margin: 8px 0;
  border: 1px solid color-mix(in srgb, var(--accent-color, #4a90d9) 30%, var(--border-color, #dee2e6));
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--accent-color, #4a90d9) 6%, var(--bg-primary, #fff));
}

.scheduled-task-card.deleted {
  opacity: 0.5;
  border-color: var(--border-color, #dee2e6);
  background: var(--bg-secondary);
}

.scheduled-task-card.deleted .stask-header {
  background: var(--bg-tertiary);
  color: var(--text-muted, #999);
  border-bottom-color: var(--border-color, #dee2e6);
}

.stask-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: color-mix(in srgb, var(--accent-color, #4a90d9) 12%, transparent);
  color: var(--accent-color, #4a90d9);
  font-weight: 600;
  font-size: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-color, #4a90d9) 15%, var(--border-color, #dee2e6));
  cursor: pointer;
}

.stask-icon {
  margin-right: 4px;
}

.stask-history-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--accent-color, #4a90d9);
  cursor: pointer;
  transition: background 0.15s;
}

.stask-history-btn:hover {
  background: color-mix(in srgb, var(--accent-color, #4a90d9) 20%, transparent);
}

.stask-history-btn svg {
  flex-shrink: 0;
  opacity: 0.8;
}

.stask-delete-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--accent-color, #4a90d9);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.stask-delete-btn:hover {
  background: rgba(211, 47, 47, 0.1);
  color: #d32f2f;
}

.stask-delete-btn svg {
  flex-shrink: 0;
  opacity: 0.8;
}

.stask-delete-btn:hover svg {
  opacity: 1;
}

.stask-body {
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}

.stask-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.stask-row strong {
  min-width: 70px;
  color: var(--text-secondary, #495057);
}

.stask-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
  align-self: center;
}

.stask-status-dot.status-active {
  background: #4caf50;
}

.stask-status-dot.status-paused {
  background: #ff9800;
}

.stask-status-dot.status-completed {
  background: #9e9e9e;
}

.stask-actions {
  display: flex;
  gap: 6px;
  padding-top: 6px;
  flex-wrap: wrap;
}

.stask-action-btn {
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--accent-color, #4a90d9) 25%, var(--border-color, #ddd));
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent-color, #4a90d9) 6%, var(--bg-secondary, #f5f5f5));
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.85em;
}

.stask-action-btn:hover {
  background: color-mix(in srgb, var(--accent-color, #4a90d9) 12%, var(--bg-hover, #e0e0e0));
}
</style>

<style>
/* Non-scoped styles for v-html penetration — tool detail rendering */
:root[data-theme="dark"] .content-blocks .chat-tool-call[data-category="bash"]   { --tool-accent: #34d399; }
:root[data-theme="dark"] .content-blocks .chat-tool-call[data-category="search"] { --tool-accent: #a78bfa; }
:root[data-theme="dark"] .content-blocks .chat-tool-call[data-category="task"]   { --tool-accent: #fbbf24; }
:root[data-theme="dark"] .content-blocks .chat-tool-call[data-category="agent"]  { --tool-accent: #f472b6; }
:root[data-theme="dark"] .content-blocks .chat-tool-call[data-category="skill"]  { --tool-accent: #22d3ee; }
:root[data-theme="dark"] .content-blocks .chat-tool-call.tool-error              { --tool-accent: #f87171; }

/* Tool output section */
.content-blocks .tool-detail .tool-output-section {
  margin-top: 6px;
  border-top: 1px solid var(--border-color);
  padding-top: 6px;
}

.content-blocks .tool-detail .tool-output-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.content-blocks .tool-detail .tool-output-label {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
  font-weight: 600;
}

:root[data-theme="dark"] .content-blocks .tool-detail .tool-output-label {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}

.content-blocks .tool-detail .tool-output-status {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 600;
}

.content-blocks .tool-detail .tool-output-success {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}

:root[data-theme="dark"] .content-blocks .tool-detail .tool-output-success {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}

.content-blocks .tool-detail .tool-output-error {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

:root[data-theme="dark"] .content-blocks .tool-detail .tool-output-error {
  background: rgba(248, 113, 113, 0.15);
  color: #fca5a5;
}

.content-blocks .tool-detail .tool-output-body {
  max-height: 200px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .tool-output-body pre {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.content-blocks .tool-detail .tool-output-default pre {
  background: var(--bg-tertiary);
  border-radius: 4px;
  padding: 6px 8px;
}

.content-blocks .tool-detail .tool-file-header {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 4px;
  padding-bottom: 4px;
  padding-right: 22px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.content-blocks .tool-detail .tool-file-header .chat-file-open-btn {
  position: absolute;
  top: 0;
  right: 0;
  flex-shrink: 0;
}

.content-blocks .tool-detail .tool-file-path {
  font-family: 'SF Mono', 'Fira Code', Menlo, monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-color);
  word-break: break-all;
  flex: 1;
  min-width: 0;
}

.content-blocks .tool-detail .edit-diff-view {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .edit-diff-replace-all {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
  font-weight: 600;
  white-space: nowrap;
}

.content-blocks .tool-detail .edit-diff-scroll {
  overflow-x: auto;
}

.content-blocks .tool-detail .edit-diff-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  min-width: max-content;
}

.content-blocks .tool-detail .edit-diff-del {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  white-space: pre;
}

.content-blocks .tool-detail .edit-diff-add {
  background: rgba(34, 197, 94, 0.08);
  color: #16a34a;
  white-space: pre;
}

:root[data-theme="dark"] .content-blocks .tool-detail .edit-diff-del {
  background: rgba(248, 113, 113, 0.1);
  color: #fca5a5;
}

:root[data-theme="dark"] .content-blocks .tool-detail .edit-diff-add {
  background: rgba(74, 222, 128, 0.1);
  color: #86efac;
}

:root[data-theme="dark"] .content-blocks .tool-detail .edit-diff-replace-all {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
}

.content-blocks .tool-detail .file-preview-view {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .file-preview-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
}

.content-blocks .tool-detail .file-preview-line {
  white-space: pre;
  color: var(--text-primary);
}

.content-blocks .tool-detail .file-preview-meta {
  white-space: normal;
  color: var(--text-muted, #999);
  font-style: italic;
  padding: 4px 0;
}

.content-blocks .tool-detail .file-write-view {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .file-write-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
  font-weight: 600;
  white-space: nowrap;
}

:root[data-theme="dark"] .content-blocks .tool-detail .file-write-badge {
  background: rgba(96, 165, 250, 0.15);
  color: #93c5fd;
}

.content-blocks .tool-detail .file-write-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
}

.content-blocks .tool-detail .file-write-line {
  white-space: pre;
  color: var(--text-primary);
}

.content-blocks .tool-detail .tool-json-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
}

.content-blocks .tool-detail .tool-json-body code {
  font-family: inherit;
}

.content-blocks .tool-detail .bash-terminal-view {
  white-space: normal;
}

.content-blocks .tool-detail .bash-terminal-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

.content-blocks .tool-detail .bash-terminal-body {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  background: var(--bg-tertiary);
  border-radius: 4px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.content-blocks .tool-detail .bash-prompt {
  color: #16a34a;
  font-weight: 700;
  margin-right: 4px;
}

:root[data-theme="dark"] .content-blocks .tool-detail .bash-prompt {
  color: #4ade80;
}

.content-blocks .tool-detail .bash-command {
  color: var(--text-primary);
}

/* ── AskUserQuestion card ── */
:root[data-theme="dark"] .content-blocks .chat-tool-call[data-category="ask"] { --tool-accent: #fb923c; }

.content-blocks .tool-detail .ask-question-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.content-blocks .tool-detail .ask-question-empty {
  color: var(--text-muted, #999);
  font-style: italic;
  font-size: 11px;
}

.content-blocks .tool-detail .ask-question-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.content-blocks .tool-detail .ask-question-header {
  font-size: 12px;
  font-weight: 600;
  color: #f97316;
}

:root[data-theme="dark"] .content-blocks .tool-detail .ask-question-header {
  color: #fb923c;
}

.content-blocks .tool-detail .ask-question-text {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.content-blocks .tool-detail .ask-question-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.content-blocks .tool-detail .ask-question-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  user-select: none;
  -webkit-user-select: none;
}

.content-blocks .tool-detail .ask-question-option:hover {
  background: color-mix(in srgb, #f97316 6%, var(--bg-secondary));
  border-color: color-mix(in srgb, #f97316 30%, var(--border-color));
}

.content-blocks .tool-detail .ask-question-option.selected {
  background: color-mix(in srgb, #f97316 10%, var(--bg-secondary));
  border-color: #f97316;
}

:root[data-theme="dark"] .content-blocks .tool-detail .ask-question-option.selected {
  background: color-mix(in srgb, #fb923c 12%, var(--bg-secondary));
  border-color: #fb923c;
}

.content-blocks .tool-detail .ask-option-indicator {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1.3;
  color: var(--text-muted, #999);
}

.content-blocks .tool-detail .ask-question-option.selected .ask-option-indicator {
  color: #f97316;
}

:root[data-theme="dark"] .content-blocks .tool-detail .ask-question-option.selected .ask-option-indicator {
  color: #fb923c;
}

.content-blocks .tool-detail .ask-option-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.content-blocks .tool-detail .ask-option-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.content-blocks .tool-detail .ask-option-desc {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.content-blocks .tool-detail .ask-question-submit {
  align-self: flex-end;
  padding: 5px 16px;
  border: none;
  border-radius: 6px;
  background: #f97316;
  color: white;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
}

.content-blocks .tool-detail .ask-question-submit:hover:not(:disabled) {
  background: #ea580c;
}

.content-blocks .tool-detail .ask-question-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.content-blocks .tool-detail .ask-question-view.ask-submitted .ask-question-submit {
  background: #16a34a;
  cursor: default;
  opacity: 1;
}

:root[data-theme="dark"] .content-blocks .tool-detail .ask-question-submit {
  background: #fb923c;
}

:root[data-theme="dark"] .content-blocks .tool-detail .ask-question-submit:hover:not(:disabled) {
  background: #f97316;
}

:root[data-theme="dark"] .content-blocks .tool-detail .ask-question-view.ask-submitted .ask-question-submit {
  background: #22c55e;
}

/* ── Grep search view ── */
.content-blocks .tool-detail .grep-search-view {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .grep-pattern-row,
.content-blocks .tool-detail .grep-path-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.content-blocks .tool-detail .grep-label {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.12);
  color: #7c3aed;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.5;
}

:root[data-theme="dark"] .content-blocks .tool-detail .grep-label {
  background: rgba(167, 139, 250, 0.15);
  color: #a78bfa;
}

.content-blocks .tool-detail .grep-pattern-text,
.content-blocks .tool-detail .grep-path-text {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.content-blocks .tool-detail .grep-mode-tag {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.08);
  color: #8b5cf6;
  font-weight: 500;
  align-self: flex-start;
}

:root[data-theme="dark"] .content-blocks .tool-detail .grep-mode-tag {
  background: rgba(167, 139, 250, 0.12);
  color: #a78bfa;
}

/* ── Glob pattern view ── */
.content-blocks .tool-detail .glob-pattern-view {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .glob-pattern-row,
.content-blocks .tool-detail .glob-path-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.content-blocks .tool-detail .glob-label {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.12);
  color: #7c3aed;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.5;
}

:root[data-theme="dark"] .content-blocks .tool-detail .glob-label {
  background: rgba(167, 139, 250, 0.15);
  color: #a78bfa;
}

.content-blocks .tool-detail .glob-pattern-text,
.content-blocks .tool-detail .glob-path-text {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

/* ── WebSearch view ── */
.content-blocks .tool-detail .web-search-view {
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .web-search-query {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--text-primary);
}

.content-blocks .tool-detail .web-search-icon {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1.4;
}

.content-blocks .tool-detail .web-search-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── WebFetch view ── */
.content-blocks .tool-detail .web-fetch-view {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .web-fetch-url-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.content-blocks .tool-detail .web-fetch-label {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.12);
  color: #7c3aed;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.5;
}

:root[data-theme="dark"] .content-blocks .tool-detail .web-fetch-label {
  background: rgba(167, 139, 250, 0.15);
  color: #a78bfa;
}

.content-blocks .tool-detail .web-fetch-link {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  color: var(--accent-color);
  text-decoration: none;
  word-break: break-all;
}

.content-blocks .tool-detail .web-fetch-link:hover {
  text-decoration: underline;
}

.content-blocks .tool-detail .web-fetch-text {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.content-blocks .tool-detail .web-fetch-prompt {
  color: var(--text-secondary);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Agent call view ── */
.content-blocks .tool-detail .agent-call-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .agent-call-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.content-blocks .tool-detail .agent-type-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(236, 72, 153, 0.12);
  color: #db2777;
  font-weight: 600;
  white-space: nowrap;
}

:root[data-theme="dark"] .content-blocks .tool-detail .agent-type-badge {
  background: rgba(244, 114, 182, 0.15);
  color: #f472b6;
}

.content-blocks .tool-detail .agent-call-desc {
  color: var(--text-primary);
  font-weight: 500;
}

.content-blocks .tool-detail .agent-call-prompt {
  color: var(--text-secondary);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  font-family: inherit;
  line-height: 1.5;
  max-height: 80px;
  overflow-y: auto;
}

/* ── Skill call view ── */
.content-blocks .tool-detail .skill-call-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
}

.content-blocks .tool-detail .skill-call-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.content-blocks .tool-detail .skill-call-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.content-blocks .tool-detail .skill-call-name {
  font-weight: 600;
  color: #0891b2;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 11px;
}

:root[data-theme="dark"] .content-blocks .tool-detail .skill-call-name {
  color: #22d3ee;
}

.content-blocks .tool-detail .skill-call-args {
  color: var(--text-secondary);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  line-height: 1.5;
  max-height: 80px;
  overflow-y: auto;
}
</style>
