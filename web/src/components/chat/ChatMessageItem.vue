<template>
  <div class="chat-message" :class="[msg.role, { 'has-metadata': msg.role === 'assistant' && msg.metadata }]">

    <!-- Collapsible content wrapper -->
    <div ref="wrapperRef" class="msg-content-wrapper" :class="{ collapsed }" :style="collapsed ? { maxHeight: store.state.chatCollapsedHeight + 'px' } : {}">
      <div v-if="msg.role === 'user' && msg.files && msg.files.length > 0 && !hasImagesInContent(msg.content)" class="chat-files">
        <template v-for="(f, idx) in msg.files" :key="idx">
          <span v-if="isUploadPath(normalizeFileEntry(f).path)" class="chat-file-attachment attachment-upload" @click="$emit('file-tag-click', normalizeFileEntry(f).path)" title="打开文件">
            <svg v-if="isImageFile(normalizeFileEntry(f).path)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <circle cx="10" cy="13" r="2"/>
              <path d="m20 17-3.1-3.1a2 2 0 0 0-2.8 0L9 19"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="chat-file-name">{{ getFileName(normalizeFileEntry(f).path) }}</span>
          </span>
          <span v-else class="chat-file-attachment attachment-ref" @click="$emit('file-tag-click', normalizeFileEntry(f).path)" title="打开文件">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
            <span class="chat-file-name">{{ getFileName(normalizeFileEntry(f).path) }}</span>
          </span>
        </template>
      </div>

      <!-- Message content -->
      <template v-if="msg.role === 'assistant' && msg.blocks">
        <ContentBlocks
          :blocks="msg.blocks"
          :msgId="msg.id"
          :msgIndex="index"
          :expandedTools="expandedTools"
          :blockProposals="blockProposals"
          :streaming="msg.streaming"
          :cancelled="msg.cancelled"
          :renderTextBlock="renderTextBlock"
          :formatToolInput="formatToolInput"
          :toolCallSummary="toolCallSummary"
          :humanizeCron="humanizeCron"
          :repeatLabel="repeatLabel"
          :truncate="truncate"
          :getAgentIcon="getAgentIcon"
          :getAgentName="getAgentName"
          @toggle-tool="$emit('toggle-tool', $event)"
          @edit-task="$emit('edit-task', $event)"
          @send-message="$emit('send-message', $event)"
        />
      </template>
      <!-- User message or legacy plain text (NOT for assistant messages with blocks parsed) -->
      <div v-else-if="msg.role === 'user'" v-html="renderedContent"></div>
    </div>

    <!-- Collapse overlay + expand button -->
    <div v-if="collapsed" class="msg-collapse-overlay" @click="manuallyExpanded = true; $emit('expand', index)">
      <div class="msg-collapse-gradient"></div>
      <button class="msg-expand-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        展开全文
      </button>
    </div>

    <!-- Bottom bar for assistant messages -->
    <div v-if="msg.role === 'assistant' && !msg.streaming && (msgText || msg.blocks?.length)" class="chat-meta-bar">
      <span class="chat-meta-info">
        <span v-if="msg.backend">{{ msg.backend }}</span>
        <span v-if="msg.metadata?.model" class="chat-meta-sep">{{ msg.metadata.model }}</span>
        <span v-if="msg.createdAt" class="chat-meta-sep">{{ formatMessageTime(msg.createdAt) }}</span>
      </span>
      <div class="chat-meta-actions">
        <button v-if="msgText" ref="speakBtnRef" class="chat-info-btn chat-speak-btn" :class="{ active: autoSpeech.isActive(msg.id), loading: autoSpeech.isGeneratingText(msg.id) }" @click.stop="handleSpeak">
          <!-- Generating states: summarizing / synthesizing -->
          <template v-if="autoSpeech.isGeneratingText(msg.id)">
            <svg class="speak-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2"/>
            </svg>
            <span>{{ autoSpeech.getPhaseLabel(msg.id) }}</span>
          </template>
          <!-- Playing state -->
          <template v-else-if="autoSpeech.isPlayingAudio(msg.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
            </svg>
            <span>朗读中</span>
          </template>
          <!-- Default idle state -->
          <template v-else>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            <span>朗读</span>
          </template>
        </button>
        <button v-if="!msg.streaming" class="chat-info-btn" @click="$emit('show-metadata', msg)" title="查看详情">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </button>
      </div>
    </div>
    <!-- Bottom bar for user messages -->
    <div v-if="msg.role === 'user'" class="chat-meta-bar chat-meta-bar-user">
      <span class="chat-meta-info">
        <span v-if="msg.createdAt">{{ formatMessageTime(msg.createdAt) }}</span>
      </span>
      <button class="chat-info-btn chat-info-btn-user" @click="$emit('show-metadata', msg)" title="查看详情">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
      </button>
    </div>

  </div>
</template>

<script setup>
import { ref, inject, computed, watch, nextTick, onMounted } from 'vue'
import { baseName } from '@/utils/helpers.ts'
import { store } from '@/stores/app.ts'
import ContentBlocks from './ContentBlocks.vue'


const props = defineProps({
  msg: Object,
  index: Number,
  expandedTools: Object,
  blockProposals: Object,
  agents: Array,
  renderedContent: String,
  shouldCollapse: Boolean,
})

const emit = defineEmits(['toggle-tool', 'show-metadata', 'file-tag-click', 'expand', 'edit-task', 'send-message'])

const autoSpeech = inject('autoSpeech')
const layoutRefreshKey = inject('layoutRefreshKey', ref(0))
const wrapperRef = ref(null)
const overflows = ref(false)
const manuallyExpanded = ref(false)
const speakBtnRef = ref(null)

// Reset internal collapse state when the message identity changes
// (e.g. loadHistory replaces the messages array, giving same-index
// messages different ids). Without this, manuallyExpanded can survive
// across message replacements, causing stale collapse state.
watch(() => props.msg?.id, (newId, oldId) => {
  if (oldId !== undefined && newId !== oldId) {
    manuallyExpanded.value = false
    overflows.value = false  // Will be recalculated by checkOverflow watchers
  }
})

// Extract text content from message blocks for TTS
const msgText = computed(() => {
  if (props.msg?.role !== 'assistant') return ''
  const blocks = props.msg?.blocks || []
  return blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim()
})

// Handle speak button click: play or stop (no popover)
function handleSpeak() {
  if (autoSpeech.isActive(props.msg?.id)) {
    autoSpeech.stopAudio()
  } else if (msgText.value && props.msg?.id) {
    autoSpeech.speakText(props.msg.id, msgText.value)
  }
}

function checkOverflow() {
  if (!wrapperRef.value) return
  // When the chat panel is hidden (display:none via v-show), scrollHeight
  // returns 0 which makes overflows=false — causing stale collapse state.
  // Skip the check in that case; the next visible-frame check will fix it.
  if (!wrapperRef.value.offsetParent) return
  overflows.value = wrapperRef.value.scrollHeight > store.state.chatCollapsedHeight
}

// Check overflow after mount and when content changes.
// Use nextTick for content changes (need DOM update first), but do a
// synchronous re-check immediately after nextTick resolves to catch
// cases where Vue batches DOM updates across multiple ticks.
onMounted(() => nextTick(() => {
  checkOverflow()
  // Re-check after one more frame to catch async rendering (Mermaid, KaTeX)
  requestAnimationFrame(checkOverflow)
}))
watch(() => props.renderedContent, () => nextTick(() => {
  checkOverflow()
  requestAnimationFrame(checkOverflow)
}))
watch(() => props.msg?.blocks?.length, () => nextTick(() => {
  checkOverflow()
  requestAnimationFrame(checkOverflow)
}))
watch(() => props.msg?.streaming, () => nextTick(() => {
  checkOverflow()
  requestAnimationFrame(checkOverflow)
}))

// When the chat panel reopens after being hidden, layout measurements
// (scrollHeight) are now valid again — re-check overflow.
watch(layoutRefreshKey, () => {
  nextTick(() => {
    checkOverflow()
    requestAnimationFrame(checkOverflow)
  })
})

const collapsed = computed(() => {
  if (!props.shouldCollapse) return false
  if (props.msg?.streaming) return false
  if (manuallyExpanded.value) return false
  return overflows.value
})

const chatRender = inject('chatRender', {})
const chatSession = inject('chatSession', {})

const { renderTextBlock, formatMessageTime, toolCallSummary, formatToolInput, humanizeCron, repeatLabel, truncate, hasImagesInContent } = chatRender
const { getAgentIcon, getAgentName } = chatSession

function normalizeFileEntry(f) {
  if (typeof f === 'string') return { path: f }
  return { path: f.path || '' }
}

function isUploadPath(path) {
  return path.startsWith('.clawbench/uploads/') || path.startsWith('.clawbench\\uploads\\')
}

function isImageFile(path) {
  if (!path) return false
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif', '.avif']
  const lower = path.toLowerCase()
  return imageExts.some(ext => lower.endsWith(ext))
}

function getFileName(path) {
  return baseName(path)
}
</script>

<style scoped>
/* Audio player in chat */
.chat-audio-wrapper {
  margin: 8px 0;
}

.chat-audio-player {
  width: 100%;
  max-width: 280px;
  height: 36px;
  border-radius: var(--radius-sm);
  outline: none;
}

/* ── File attachment in messages ── */
.chat-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0;
}

/* Common file tag styles - shared by both current file and uploaded attachments */
.chat-file-tag,
.chat-file-attachment {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border-radius: 8px;
  padding: 1px 6px;
  margin-bottom: 4px;
  font-size: 11px;
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;
  max-width: 120px;
}

.chat-file-tag-icon,
.chat-file-attachment svg {
  flex-shrink: 0;
}

.chat-file-tag-path,
.chat-file-name {
  font-family: monospace;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.chat-file-tag-path::-webkit-scrollbar,
.chat-file-name::-webkit-scrollbar {
  display: none;
}

/* User message: common colors */
.chat-message.user .chat-file-tag,
.chat-message.user .chat-file-attachment {
  color: rgba(255, 255, 255, 0.95);
}

.chat-message.user .chat-file-tag-path,
.chat-message.user .chat-file-name {
  color: rgba(255, 255, 255, 0.95);
}

.chat-message.user .chat-file-tag-icon,
.chat-message.user .chat-file-attachment svg {
  stroke: rgba(255, 255, 255, 0.95);
}

/* User message: uploaded - solid border */
.chat-message.user .attachment-upload {
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.35);
}

/* User message: referenced - dashed border */
.chat-message.user .attachment-ref {
  background: rgba(255, 255, 255, 0.15);
  border: 1px dashed rgba(255, 255, 255, 0.6);
}

.chat-message.user .attachment-ref:hover,
.chat-message.user .chat-file-tag:hover {
  background: rgba(255, 255, 255, 0.25);
}

/* Assistant message: common colors */
.chat-message.assistant .chat-file-tag,
.chat-message.assistant .chat-file-attachment {
  color: var(--text-secondary);
}

.chat-message.assistant .chat-file-tag-path,
.chat-message.assistant .chat-file-name {
  color: var(--text-secondary);
}

.chat-message.assistant .chat-file-tag-icon,
.chat-message.assistant .chat-file-attachment svg {
  stroke: var(--text-secondary);
}

/* Assistant message: uploaded - solid border */
.chat-message.assistant .attachment-upload {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
}

/* Assistant message: referenced - dashed border */
.chat-message.assistant .attachment-ref {
  background: color-mix(in srgb, var(--text-muted, #999) 8%, transparent);
  border: 1px dashed var(--text-secondary);
}

.chat-message.assistant .attachment-ref:hover,
.chat-message.assistant .chat-file-tag:hover {
  background: var(--bg-secondary);
}

/* Image thumbnails in user messages */
.chat-image-thumb {
  max-width: 80px;
  max-height: 80px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
}

/* Image thumbnail style */
.chat-message .chat-img-thumbnail {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.chat-message .chat-img-thumbnail:hover {
  transform: scale(1.02);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

/* ── Collapse styles ── */
.msg-content-wrapper {
  position: relative;
}

.msg-content-wrapper.collapsed {
  overflow: hidden;
}

.msg-collapse-overlay {
  position: relative;
  margin-top: -40px;
  padding-top: 40px;
  cursor: pointer;
}

.msg-collapse-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, transparent 0%, var(--bg-tertiary) 80%);
  pointer-events: none;
}

.chat-message.user .msg-collapse-gradient {
  background: linear-gradient(to bottom, transparent 0%, var(--user-msg-color) 80%);
}

.msg-expand-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 6px 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.2s;
}

.msg-expand-btn:hover {
  color: var(--accent-color, #0066cc);
}

.msg-expand-btn svg {
  flex-shrink: 0;
}

/* Chat Meta Bar — contains model/duration info + detail button */
.chat-meta-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
    gap: 6px;
}

.chat-meta-info {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.7;
    min-width: 0;
    overflow: hidden;
}

.chat-meta-sep::before {
    content: '·';
    margin-right: 6px;
}

/* Chat Info Button */
.chat-info-btn {
    flex-shrink: 0;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    opacity: 0.5;
    transition: opacity 0.2s, background 0.2s;
    font-size: 11px;
}

.chat-info-btn:hover {
    opacity: 1;
    background: var(--bg-tertiary);
}

.chat-info-btn svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
}

.chat-info-btn span {
    white-space: nowrap;
}

/* Speak button specific styles */
.chat-speak-btn {
    min-width: auto;
    padding: 0 8px;
}

.chat-speak-btn.active {
    opacity: 1;
    color: var(--accent-color, #0066cc);
}

.chat-speak-btn.active:hover {
    background: color-mix(in srgb, var(--accent-color, #0066cc) 10%, transparent);
}

/* Meta bar action buttons container */
.chat-meta-actions {
    display: flex;
    align-items: center;
    gap: 2px;
}

/* Speak button loading spinner animation */
.chat-speak-btn.loading .speak-spinner {
    animation: speak-spin 1s linear infinite;
}

@keyframes speak-spin {
    to { transform: rotate(360deg); }
}

/* User message meta bar */
.chat-meta-bar-user {
    opacity: 0.6;
    transition: opacity 0.2s;
}

.chat-meta-bar-user:hover {
    opacity: 1;
}

.chat-info-btn-user {
    color: rgba(255, 255, 255, 0.7);
}

.chat-info-btn-user:hover {
    color: rgba(255, 255, 255, 0.9);
    background: rgba(255, 255, 255, 0.1);
}

.chat-meta-bar-user .chat-meta-info {
    color: rgba(255, 255, 255, 0.7);
}
</style>

<style>
/* Chat message - non-scoped for v-html penetration */
.chat-message {
    padding: 8px 12px;
    border-radius: var(--radius-md);
    font-size: 13px;
    line-height: 1.4;
    min-width: 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
    word-break: break-word;
    max-width: 100%;
    box-sizing: border-box;
}

.chat-message.user {
    background: var(--user-msg-color);
    color: white;
    align-self: flex-end;
    border-radius: 16px 16px 0 16px;
    overflow: hidden;
}

.chat-message.assistant {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    align-self: stretch;
    border-radius: 16px 16px 16px 0;
    position: relative;
    min-width: 0;
    overflow-wrap: break-word;
}

.chat-message.user pre {
    padding: 10px;
    margin: 6px 0;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-width: 100%;
    box-sizing: border-box;
    word-break: normal;
    word-wrap: normal;
    white-space: pre;
    background: rgba(0, 0, 0, 0.15);
}

.chat-message.user pre code {
    white-space: pre;
    word-break: normal;
}

.chat-message.user code {
    padding: 2px 6px;
    font-size: 13px;
    background: rgba(0, 0, 0, 0.15);
}

.chat-message.user h1,
.chat-message.user h2,
.chat-message.user h3 {
    margin: 6px 0 3px;
    font-weight: 600;
}

.chat-message.user h1 { font-size: 16px; }
.chat-message.user h2 { font-size: 14px; }
.chat-message.user h3 { font-size: 13px; }

.chat-message.user p {
    margin: 3px 0;
}

.chat-message.user ul,
.chat-message.user ol {
    margin: 6px 0;
}

.chat-message.user blockquote {
    margin: 6px 0;
    padding: 5px 10px;
    border-left-color: rgba(255, 255, 255, 0.35);
    background: rgba(0, 0, 0, 0.1);
}

.chat-message.user a {
    word-break: break-all;
    overflow-wrap: break-word;
    color: #b8daff;
}

.chat-message.user a:hover {
    color: #9dc5f0;
}

.chat-message.user img {
    margin: 6px 0;
}

.chat-message.user hr {
    margin: 8px 0;
    border-top-color: rgba(255, 255, 255, 0.25);
}

.chat-message.user .table-wrap {
    overflow-x: auto;
    border: none;
    border-radius: 6px;
    margin: 0.75em 0;
}

.chat-message.user table {
    display: block;
    margin: 0;
}

.chat-message.user th {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.95);
    background: rgba(0, 0, 0, 0.15);
    border-color: rgba(255, 255, 255, 0.2);
}

.chat-message.user td {
    white-space: nowrap;
    border-color: rgba(255, 255, 255, 0.15);
}

.chat-message.user tr:nth-child(odd) td {
    background: rgba(0, 0, 0, 0.08);
}

.chat-message.user tr:nth-child(even) td {
    background: rgba(0, 0, 0, 0.15);
}

.chat-message.user .chat-file-path {
    background: rgba(0, 0, 0, 0.15);
}

.chat-message.user .chat-file-open-btn {
    color: rgba(255, 255, 255, 0.7);
}

.chat-message.user .chat-file-open-btn:hover {
    color: white;
}

.chat-message.assistant pre {
    padding: 10px;
    margin: 6px 0;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-width: 100%;
    box-sizing: border-box;
    word-break: normal;
    word-wrap: normal;
    white-space: pre;
}

.chat-message.assistant pre code {
    white-space: pre;
    word-break: normal;
}

.chat-message.assistant code {
    padding: 2px 6px;
    font-size: 13px;
}

.chat-message.assistant h1,
.chat-message.assistant h2,
.chat-message.assistant h3 {
    margin: 6px 0 3px;
    font-weight: 600;
}

.chat-message.assistant h1 { font-size: 16px; }
.chat-message.assistant h2 { font-size: 14px; }
.chat-message.assistant h3 { font-size: 13px; }

.chat-message.assistant p {
    margin: 3px 0;
}

.chat-message.assistant ul,
.chat-message.assistant ol {
    margin: 6px 0;
}

.chat-message.assistant blockquote {
    margin: 6px 0;
    padding: 5px 10px;
}

.chat-message.assistant a {
    word-break: break-all;
    overflow-wrap: break-word;
}

.chat-message.assistant img {
    margin: 6px 0;
}

.chat-message.assistant hr {
    margin: 8px 0;
}

.chat-message.assistant .table-wrap {
    overflow-x: auto;
    border: none;
    border-radius: 6px;
    margin: 0.75em 0;
}

.chat-message.assistant table {
    display: block;
    margin: 0;
}

.chat-message.assistant th {
    font-size: 13px;
    color: var(--text-primary);
}

.chat-message.assistant td {
    white-space: nowrap;
}

/* Mermaid diagram thumbnail */
.chat-message .mermaid {
  max-width: 200px;
  max-height: 200px;
  overflow: hidden;
  border-radius: 6px;
  margin: 4px 0;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  background: var(--bg-secondary);
  padding: 8px;
}

.chat-message .mermaid:hover {
  transform: scale(1.02);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.chat-message .mermaid svg {
  max-width: 100%;
  max-height: 184px;
  height: auto;
}
</style>
