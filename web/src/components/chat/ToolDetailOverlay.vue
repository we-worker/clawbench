<template>
  <Teleport to="body">
    <Transition name="tool-overlay">
      <div v-if="show" class="tool-detail-overlay-backdrop" @click.self="$emit('close')">
        <div class="tool-detail-overlay" @click.stop>
          <!-- Header -->
          <div class="tool-detail-overlay-header" :data-category="category">
            <div class="tool-detail-overlay-title">
              <component :is="headerIcon" :size="14" class="tool-detail-overlay-icon" />
              <span class="tool-detail-overlay-name">{{ toolName }}</span>
              <span v-if="toolSummary" class="tool-detail-overlay-summary">{{ toolSummary }}</span>
            </div>
            <div class="tool-detail-overlay-actions">
              <!-- Status indicator -->
              <span v-if="!toolDone" class="tool-spinner"></span>
              <XCircle v-else-if="toolStatus === 'error'" :size="16" color="#ef4444" class="tool-status-icon" />
              <CheckCircle2 v-else :size="16" color="#22c55e" class="tool-status-icon" />
              <button class="tool-detail-overlay-close" @click="$emit('close')" :title="t('chat.contentBlocks.close')">
                <X :size="16" />
              </button>
            </div>
          </div>
          <!-- Body -->
          <div class="tool-detail-overlay-body" @click="handleBodyClick">
            <div v-html="toolInputHtml"></div>
            <!-- Tool output section -->
            <div v-if="toolOutputHtml" class="tool-output-section">
              <div class="tool-output-header">
                <span class="tool-output-label">output</span>
                <span v-if="toolStatus === 'error'" class="tool-output-status tool-output-error">error</span>
                <span v-else class="tool-output-status tool-output-success">ok</span>
              </div>
              <div class="tool-output-body" v-html="toolOutputHtml"></div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, CheckCircle2, XCircle } from 'lucide-vue-next'
import { getToolIcon } from '@/utils/icons'
import { handleToolAction } from '@/utils/renderToolDetail.ts'

const { t } = useI18n()

const props = defineProps({
  show: { type: Boolean, default: false },
  toolName: { type: String, default: '' },
  toolSummary: { type: String, default: '' },
  toolInputHtml: { type: String, default: '' },
  toolOutputHtml: { type: String, default: '' },
  toolStatus: { type: String, default: '' },
  toolDone: { type: Boolean, default: true },
})

const emit = defineEmits(['close', 'file-open', 'send-message'])

const category = computed(() => getToolIcon(props.toolName).category)
const headerIcon = computed(() => getToolIcon(props.toolName).icon)

function handleBodyClick(event) {
  if (props.toolName && handleToolAction(props.toolName, event, emit)) return
  // Handle file-open buttons — since overlay is teleported to <body>,
  // ChatMessageList's handleChatClick won't see these clicks.
  const fileBtn = event.target.closest('.chat-file-open-btn')
  if (fileBtn) {
    const filePath = fileBtn.getAttribute('data-file-path')
    if (filePath) emit('file-open', filePath)
    return
  }
  event.stopPropagation()
}
</script>

<style scoped>
.tool-detail-overlay-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 2400;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12px;
}

.tool-detail-overlay {
  background: var(--bg-primary);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 94%;
  max-width: 640px;
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  contain: layout;
}

/* Header */
.tool-detail-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  --tool-accent: var(--text-muted);
  background: color-mix(in srgb, var(--tool-accent) 5%, var(--bg-secondary));
}

.tool-detail-overlay-header[data-category="file"]     { --tool-accent: var(--accent-color); }
.tool-detail-overlay-header[data-category="bash"]     { --tool-accent: #10b981; }
.tool-detail-overlay-header[data-category="search"]   { --tool-accent: #8b5cf6; }
.tool-detail-overlay-header[data-category="task"]     { --tool-accent: #f59e0b; }
.tool-detail-overlay-header[data-category="plan"]     { --tool-accent: var(--accent-color); }
.tool-detail-overlay-header[data-category="agent"]    { --tool-accent: #ec4899; }
.tool-detail-overlay-header[data-category="skill"]    { --tool-accent: #06b6d4; }
.tool-detail-overlay-header[data-category="ask"]      { --tool-accent: #f97316; }
.tool-detail-overlay-header[data-category="fallback"] { --tool-accent: var(--text-muted); }

:root[data-theme="dark"] .tool-detail-overlay-header[data-category="bash"]   { --tool-accent: #34d399; }
:root[data-theme="dark"] .tool-detail-overlay-header[data-category="search"] { --tool-accent: #a78bfa; }
:root[data-theme="dark"] .tool-detail-overlay-header[data-category="task"]   { --tool-accent: #fbbf24; }
:root[data-theme="dark"] .tool-detail-overlay-header[data-category="agent"]  { --tool-accent: #f472b6; }
:root[data-theme="dark"] .tool-detail-overlay-header[data-category="skill"]  { --tool-accent: #22d3ee; }
:root[data-theme="dark"] .tool-detail-overlay-header[data-category="ask"]    { --tool-accent: #fb923c; }

.tool-detail-overlay-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.tool-detail-overlay-icon {
  color: color-mix(in srgb, var(--tool-accent) 80%, transparent);
  flex-shrink: 0;
}

.tool-detail-overlay-name {
  font-weight: 600;
  color: var(--tool-accent);
  font-size: 13px;
  flex-shrink: 0;
}

.tool-detail-overlay-summary {
  color: var(--text-tertiary, #888);
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-detail-overlay-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.tool-status-icon {
  flex-shrink: 0;
}

.tool-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-color);
  border-top-color: var(--tool-accent);
  border-radius: 50%;
  animation: tool-spin 0.6s linear infinite;
  flex-shrink: 0;
}

@keyframes tool-spin {
  to { transform: rotate(360deg); }
}

.tool-detail-overlay-close {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.tool-detail-overlay-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Body */
.tool-detail-overlay-body {
  padding: 12px 14px;
  overflow-y: auto;
  overflow-x: hidden;
  font-size: 12px;
  line-height: 1.5;
  flex: 1;
  cursor: default;
}

/* Transition */
.tool-overlay-enter-active {
  transition: opacity 0.15s ease-out;
}
.tool-overlay-enter-active .tool-detail-overlay {
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease-out;
}
.tool-overlay-leave-active {
  transition: opacity 0.15s ease-in;
}
.tool-overlay-leave-active .tool-detail-overlay {
  transition: transform 0.12s ease-in, opacity 0.12s ease-in;
}
.tool-overlay-enter-from {
  opacity: 0;
}
.tool-overlay-enter-from .tool-detail-overlay {
  transform: translateY(-16px) scale(0.97);
  opacity: 0;
}
.tool-overlay-leave-to {
  opacity: 0;
}
.tool-overlay-leave-to .tool-detail-overlay {
  transform: translateY(-8px) scale(0.98);
  opacity: 0;
}
</style>

<style>
/* Non-scoped styles for v-html penetration — tool detail rendering in overlay */
.tool-detail-overlay-body .tool-output-section {
  margin-top: 8px;
  border-top: 1px solid var(--border-color);
  padding-top: 8px;
}

.tool-detail-overlay-body .tool-output-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.tool-detail-overlay-body .tool-output-label {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
  font-weight: 600;
}

:root[data-theme="dark"] .tool-detail-overlay-body .tool-output-label {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}

.tool-detail-overlay-body .tool-output-status {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 600;
}

.tool-detail-overlay-body .tool-output-success {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}

:root[data-theme="dark"] .tool-detail-overlay-body .tool-output-success {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}

.tool-detail-overlay-body .tool-output-error {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

:root[data-theme="dark"] .tool-detail-overlay-body .tool-output-error {
  background: rgba(248, 113, 113, 0.15);
  color: #fca5a5;
}

.tool-detail-overlay-body .tool-output-body {
  max-height: 40vh;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .tool-output-body pre {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-detail-overlay-body .tool-output-default pre {
  background: var(--bg-tertiary);
  border-radius: 4px;
  padding: 8px 10px;
}

/* File header */
.tool-detail-overlay-body .tool-file-header {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 6px;
  padding-bottom: 6px;
  padding-right: 22px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.tool-detail-overlay-body .tool-file-header .chat-file-open-btn {
  position: absolute;
  top: 0;
  right: 0;
  flex-shrink: 0;
}

.tool-detail-overlay-body .tool-file-path {
  font-family: 'SF Mono', 'Fira Code', Menlo, monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-color);
  word-break: break-all;
  flex: 1;
  min-width: 0;
}

/* Edit diff */
.tool-detail-overlay-body .edit-diff-view {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  line-height: 1.6;
}

.tool-detail-overlay-body .edit-diff-replace-all {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
  font-weight: 600;
  white-space: nowrap;
}

.tool-detail-overlay-body .edit-diff-scroll {
  overflow-x: auto;
}

.tool-detail-overlay-body .edit-diff-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
  min-width: max-content;
}

.tool-detail-overlay-body .edit-diff-del {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  white-space: pre;
}

.tool-detail-overlay-body .edit-diff-add {
  background: rgba(34, 197, 94, 0.08);
  color: #16a34a;
  white-space: pre;
}

:root[data-theme="dark"] .tool-detail-overlay-body .edit-diff-del {
  background: rgba(248, 113, 113, 0.1);
  color: #fca5a5;
}

:root[data-theme="dark"] .tool-detail-overlay-body .edit-diff-add {
  background: rgba(74, 222, 128, 0.1);
  color: #86efac;
}

:root[data-theme="dark"] .tool-detail-overlay-body .edit-diff-replace-all {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
}

/* File preview */
.tool-detail-overlay-body .file-preview-view {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  line-height: 1.6;
}

.tool-detail-overlay-body .file-preview-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}

.tool-detail-overlay-body .file-preview-line {
  white-space: pre;
  color: var(--text-primary);
}

.tool-detail-overlay-body .file-preview-meta {
  white-space: normal;
  color: var(--text-muted, #999);
  font-style: italic;
  padding: 4px 0;
}

/* File write */
.tool-detail-overlay-body .file-write-view {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  line-height: 1.6;
}

.tool-detail-overlay-body .file-write-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
  font-weight: 600;
  white-space: nowrap;
}

:root[data-theme="dark"] .tool-detail-overlay-body .file-write-badge {
  background: rgba(96, 165, 250, 0.15);
  color: #93c5fd;
}

.tool-detail-overlay-body .file-write-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}

.tool-detail-overlay-body .file-write-line {
  white-space: pre;
  color: var(--text-primary);
}

/* JSON fallback */
.tool-detail-overlay-body .tool-json-body {
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
}

.tool-detail-overlay-body .tool-json-body code {
  font-family: inherit;
}

/* Bash terminal */
.tool-detail-overlay-body .bash-terminal-view {
  white-space: normal;
}

.tool-detail-overlay-body .bash-terminal-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-detail-overlay-body .bash-terminal-body {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
  background: var(--bg-tertiary);
  border-radius: 6px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-detail-overlay-body .bash-prompt {
  color: #16a34a;
  font-weight: 700;
  margin-right: 4px;
}

:root[data-theme="dark"] .tool-detail-overlay-body .bash-prompt {
  color: #4ade80;
}

.tool-detail-overlay-body .bash-command {
  color: var(--text-primary);
}

/* Bash output */
.tool-detail-overlay-body .bash-output-body pre {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
  background: var(--bg-tertiary);
  border-radius: 6px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Grep search */
.tool-detail-overlay-body .grep-search-view {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .grep-pattern-row,
.tool-detail-overlay-body .grep-path-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.tool-detail-overlay-body .grep-label {
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

:root[data-theme="dark"] .tool-detail-overlay-body .grep-label {
  background: rgba(167, 139, 250, 0.15);
  color: #a78bfa;
}

.tool-detail-overlay-body .grep-pattern-text,
.tool-detail-overlay-body .grep-path-text {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.tool-detail-overlay-body .grep-mode-tag {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.08);
  color: #8b5cf6;
  font-weight: 500;
  align-self: flex-start;
}

:root[data-theme="dark"] .tool-detail-overlay-body .grep-mode-tag {
  background: rgba(167, 139, 250, 0.12);
  color: #a78bfa;
}

/* Glob pattern */
.tool-detail-overlay-body .glob-pattern-view {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .glob-pattern-row,
.tool-detail-overlay-body .glob-path-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.tool-detail-overlay-body .glob-label {
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

:root[data-theme="dark"] .tool-detail-overlay-body .glob-label {
  background: rgba(167, 139, 250, 0.15);
  color: #a78bfa;
}

.tool-detail-overlay-body .glob-pattern-text,
.tool-detail-overlay-body .glob-path-text {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

/* WebSearch */
.tool-detail-overlay-body .web-search-view {
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .web-search-query {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--text-primary);
}

.tool-detail-overlay-body .web-search-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1.4;
}

.tool-detail-overlay-body .web-search-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* WebFetch */
.tool-detail-overlay-body .web-fetch-view {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .web-fetch-url-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.tool-detail-overlay-body .web-fetch-label {
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

:root[data-theme="dark"] .tool-detail-overlay-body .web-fetch-label {
  background: rgba(167, 139, 250, 0.15);
  color: #a78bfa;
}

.tool-detail-overlay-body .web-fetch-link {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  color: var(--accent-color);
  text-decoration: none;
  word-break: break-all;
}

.tool-detail-overlay-body .web-fetch-link:hover {
  text-decoration: underline;
}

.tool-detail-overlay-body .web-fetch-text {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.tool-detail-overlay-body .web-fetch-prompt {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Agent call */
.tool-detail-overlay-body .agent-call-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .agent-call-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tool-detail-overlay-body .agent-type-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(236, 72, 153, 0.12);
  color: #db2777;
  font-weight: 600;
  white-space: nowrap;
}

:root[data-theme="dark"] .tool-detail-overlay-body .agent-type-badge {
  background: rgba(244, 114, 182, 0.15);
  color: #f472b6;
}

.tool-detail-overlay-body .agent-call-desc {
  color: var(--text-primary);
  font-weight: 500;
}

.tool-detail-overlay-body .agent-call-prompt {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-family: inherit;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}

/* Skill call */
.tool-detail-overlay-body .skill-call-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
}

.tool-detail-overlay-body .skill-call-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tool-detail-overlay-body .skill-call-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.tool-detail-overlay-body .skill-call-name {
  font-weight: 600;
  color: #0891b2;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 12px;
}

:root[data-theme="dark"] .tool-detail-overlay-body .skill-call-name {
  color: #22d3ee;
}

.tool-detail-overlay-body .skill-call-args {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}
</style>
