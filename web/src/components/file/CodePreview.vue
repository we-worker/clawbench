<template>
  <pre class="raw-content-pre" :class="{ 'word-wrap': wordWrap }" ref="codeRef" :data-file-path="filePath" :data-language="language" @click="handleClick">
    <code v-html="codeHtml" />
  </pre>
</template>

<script setup>
import { ref, watch } from 'vue'
import { hljs } from '@/utils/globals.ts'
import { escapeHtml } from '@/utils/html.ts'
import { useDoubleClickCopy } from '@/composables/useDoubleClickCopy.ts'
import { useQuoteQuestion } from '@/composables/useQuoteQuestion.ts'

const props = defineProps({
    /** Raw file content */
    content: { type: String, default: '' },
    /** Language for syntax highlighting */
    language: { type: String, default: 'plaintext' },
    /** File path for quote-question feature */
    filePath: { type: String, default: null },
    /** Enable word wrap */
    wordWrap: { type: Boolean, default: false },
})

const codeHtml = ref('')
const codeRef = ref(null)

const quoteQuestion = useQuoteQuestion()

const { handleDblClick } = useDoubleClickCopy({
    lineSelector: '.code-line',
    onCopy(target, text) {
        // 从 DOM 读取文件信息和行号
        const lineEl = target && 'closest' in target ? target.closest('.code-line') : null
        const preEl = lineEl?.closest('.raw-content-pre')
        const filePath = preEl?.getAttribute('data-file-path') || ''
        const language = preEl?.getAttribute('data-language') || ''
        const lineNum = lineEl ? parseInt(lineEl.getAttribute('data-line') || '0') : 0

        quoteQuestion.showBar({
            text,
            filePath,
            language,
            startLine: lineNum,
            endLine: lineNum,
        })
    },
})

function handleClick(event) {
    handleDblClick(event)
}

function renderCode(content, lang) {
    return content.split('\n').map((rawLine, i) => {
        let h
        try { h = hljs.highlight(rawLine, { language: lang, ignoreIllegals: true }).value } catch { h = escapeHtml(rawLine) }
        h = h.replace(/^<span class="line">/, '').replace(/<\/span>\s*$/, '')
        return `<div class="code-line" data-line="${i + 1}"><span class="line-num">${i + 1}</span><span class="code-text">${h}</span></div>`
    }).join('')
}

function doRender(content) {
    if (!content) return
    codeHtml.value = renderCode(content, props.language)
}

watch(() => props.content, doRender, { immediate: true })
</script>

<style scoped>
pre {
    user-select: text;
    min-height: 0;
}
pre :deep(code) {
    min-height: 0;
}

/* Raw content pre - code display area */
.raw-content-pre {
    margin: 0;
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--code-bg);
    border: none;
    font-size: 13px;
    line-height: 1.6;
    tab-size: 4;
}

.raw-content-pre :deep(code) {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Segoe UI Mono', 'Roboto Mono', Consolas, 'Liberation Mono', monospace;
    background: transparent;
    padding: 0;
    font-size: inherit;
    white-space: pre;
    display: block;
    min-width: max-content;
}

.raw-content-pre :deep(code .code-line) {
    display: flex;
    align-items: start;
}

.raw-content-pre :deep(code .line-num) {
    position: sticky;
    left: 0;
    display: inline-block;
    min-width: 48px;
    padding-right: 12px;
    margin-right: 0;
    color: var(--text-muted);
    text-align: right;
    user-select: none;
    cursor: pointer;
    border-right: 1px solid var(--border-color);
    opacity: 0.5;
    transition: opacity 0.15s, color 0.15s;
    font-size: inherit;
    line-height: inherit;
    background: var(--code-bg);
}

.raw-content-pre :deep(code .code-text) {
    white-space: pre;
    padding-left: 12px;
}

/* Word wrap mode */
.raw-content-pre.word-wrap {
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: break-word;
}

.raw-content-pre.word-wrap :deep(code) {
    white-space: pre-wrap;
    min-width: 0;
    word-break: break-all;
    overflow-wrap: break-word;
}

.raw-content-pre.word-wrap :deep(code .code-text) {
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: break-word;
}

.raw-content-pre.word-wrap :deep(code .code-line) {
    align-items: stretch;
}

.raw-content-pre.word-wrap :deep(code .line-num) {
    position: static;
    border-right: 1px solid var(--border-color);
}

.raw-content-pre :deep(code .line-num:hover) {
    opacity: 1;
    color: var(--accent-color);
}
</style>

<style>
/* Line flash animation for TOC jump and search jump */
@keyframes line-flash {
    0%, 100% { background: transparent; }
    10%, 30%  { background: rgba(255, 230, 0, 0.4); }
    20%, 40%  { background: transparent; }
    50%, 70%  { background: rgba(255, 230, 0, 0.3); }
    60%, 80%  { background: transparent; }
    90%       { background: rgba(255, 230, 0, 0.2); }
}
.line-flash {
    animation: line-flash 1.2s ease-out forwards;
}

/* Copy flash animation for block elements — used by useDoubleClickCopy */
@keyframes copy-flash {
    0%, 100% { background: transparent; }
    50%      { background: rgba(255, 230, 0, 0.4); }
}
.copy-flash {
    animation: copy-flash 0.4s ease-out forwards;
    border-radius: 4px;
}
</style>
