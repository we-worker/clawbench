<template>
  <div class="file-header-bar">
    <div class="file-name-wrap">
      <span class="file-path-hint" style="cursor:pointer" @click="$emit('showDetails')" :title="file.name">{{ file.name }}</span>
    </div>
    <div class="header-actions">
      <!-- File navigation: back/forward capsule group -->
      <div class="nav-capsule">
        <button class="nav-capsule-btn" :class="{ disabled: !canGoBack }" @click.stop="handleGoBack" :title="t('nav.prevFile')">
          <ChevronLeft :size="12" />
        </button>
        <button class="nav-capsule-btn" :class="{ disabled: !canGoForward }" @click.stop="handleGoForward" :title="t('nav.nextFile')">
          <ChevronRight :size="12" />
        </button>
      </div>

      <!-- TOC button (only for file types that support TOC) -->
      <button v-if="hasToc" class="file-header-btn" :class="{ active: tocOpen }" @click.stop="$emit('toggleToc')" :title="t('file.header.toc')">
        <List :size="12" />
      </button>


      <!-- Search button (only for file types that support search) -->
      <button v-if="hasToc" class="file-header-btn" :class="{ active: searchOpen }" :disabled="!file.content" @click.stop="$emit('toggleSearch')" :title="t('file.header.search')">
        <Search :size="12" />
      </button>

      <!-- Refresh button -->
      <button class="file-header-btn" @click.stop="$emit('refresh')" :title="t('nav.refresh')">
        <RotateCw :size="12" />
      </button>

      <!-- More actions dropdown -->
      <div class="dropdown-wrapper" ref="dropdownRef">
        <button class="file-header-btn" @click.stop="menuOpen = !menuOpen" :title="t('file.header.more')">
          <MoreVertical :size="12" />
        </button>
        <div v-if="menuOpen" class="dropdown-menu">
          <button v-if="file.isBinary" class="dropdown-item" @click="handleOpenAsText">
            <Code2 :size="14" />
            {{ t('file.header.openAsText') }}
          </button>
          <button v-if="isMarkdown" class="dropdown-item" @click="handleToggleView">
            <Code2 :size="14" />
            {{ viewMode === 'rendered' ? t('file.header.sourceView') : t('file.header.renderedView') }}
          </button>
          <button v-if="!isMarkdownRendered" class="dropdown-item" @click="handleToggleWordWrap">
            <TextWrap :size="14" />
            {{ t('file.header.wordWrap') }}
            <span v-if="wordWrap" class="wrap-check">✓</span>
          </button>
          <a v-if="!isAppMode" class="dropdown-item" :href="'/api/local-file/' + encodeURIComponent(file.path) + '?download=1'" :download="file.name" @click="menuOpen = false">
            <Download :size="14" />
            {{ t('common.download') }}
          </a>
          <button v-else class="dropdown-item" @click="handleDownload">
            <Download :size="14" />
            {{ t('common.download') }}
          </button>
          <button class="dropdown-item" @click="handleDelete">
            <Trash2 :size="14" />
            {{ t('common.delete') }}
          </button>
          <button class="dropdown-item" @click="handleGitHistory">
            <GitBranch :size="14" />
            {{ t('file.header.fileHistory') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { List, Search, MoreVertical, Code2, Download, Trash2, GitBranch, TextWrap, RotateCw, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { getFileType } from '@/utils/fileType.ts'
import { useAppMode } from '@/composables/useAppMode.ts'
import { store } from '@/stores/app.ts'

const props = defineProps({
    file: Object,
    viewMode: String,
    tocOpen: Boolean,
    searchOpen: Boolean,
    wordWrap: Boolean,
})
const emit = defineEmits(['delete', 'toggleView', 'showDetails', 'openGitHistory', 'toggleToc', 'toggleSearch', 'openAsText', 'toggleWordWrap', 'refresh'])

const { isAppMode } = useAppMode()
const { t } = useI18n()

const menuOpen = ref(false)
const dropdownRef = ref(null)

const fileType = computed(() => props.file ? getFileType(props.file.name) : null)
const isMarkdown = computed(() => fileType.value?.isMarkdown || false)
const isMarkdownRendered = computed(() => isMarkdown.value && props.viewMode === 'rendered')
const hasToc = computed(() => {
    if (!props.file) return false
    const ft = fileType.value
    if (!ft) return false
    // PDF: always show TOC button (outline may be available)
    if (ft.isPdf) return true
    // Other file types: need content
    if (!props.file.content) return false
    if (ft.isImage || ft.isAudio || ft.isVideo) return false
    return true
})

const canGoBack = computed(() => store.canNavigateBack())
const canGoForward = computed(() => store.canNavigateForward())

function handleGoBack() {
    if (canGoBack.value) store.navigateToPrevFile()
}

function handleGoForward() {
    if (canGoForward.value) store.navigateToNextFile()
}

const badgeLabel = computed(() => {
    if (!props.file) return ''
    return getFileType(props.file.name)?.label || 'TXT'
})

const badgeColor = computed(() => {
    if (!props.file) return '#8b8b8b'
    return getFileType(props.file.name)?.color || '#8b8b8b'
})

const badgeStyle = computed(() => ({
    background: badgeColor.value + '22',
    color: badgeColor.value,
    border: `1px solid ${badgeColor.value}44`,
}))

function handleToggleView() {
    menuOpen.value = false
    emit('toggleView')
}

function handleToggleWordWrap() {
    menuOpen.value = false
    emit('toggleWordWrap')
}

function handleOpenAsText() {
    menuOpen.value = false
    emit('openAsText')
}

function handleDownload() {
    menuOpen.value = false
    const native = window.AndroidNative
    if (native && native.downloadFile) {
        native.downloadFile(props.file?.path)
    }
}

function handleDelete() {
    menuOpen.value = false
    emit('delete', props.file?.path)
}

function handleGitHistory() {
    menuOpen.value = false
    emit('openGitHistory')
}

// Close dropdown on outside click
function handleClickOutside(e) {
    if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
        menuOpen.value = false
    }
}

onMounted(() => {
    document.addEventListener('click', handleClickOutside)
})

onBeforeUnmount(() => {
    document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.file-header-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-left: none;
    border-right: none;
    border-radius: 0;
    z-index: 10;
    border-bottom: none;
    font-size: 12px;
    position: sticky;
    top: 0;
    left: 0;
    min-width: 0;
}

.file-name-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}

.lang-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 5px;
    flex-shrink: 0;
    font-family: monospace;
    letter-spacing: 0.5px;
}

.file-path-hint {
    flex: 0 0 auto;
    max-width: 100%;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 12px;
    overflow-x: auto;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.15s;
    scrollbar-width: none;
}
.file-path-hint::-webkit-scrollbar {
    display: none;
}
.file-path-hint:hover {
    color: var(--accent-color);
}
.file-path-hint.copied {
    color: #22c55e;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-shrink: 0;
}

/* Navigation capsule group */
.nav-capsule {
    display: flex;
    align-items: center;
    background: var(--bg-tertiary);
    border-radius: 12px;
    overflow: hidden;
    flex-shrink: 0;
}

.nav-capsule-btn {
    padding: 0;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
}

.nav-capsule-btn:first-child {
    border-right: 1px solid var(--border-color);
}

.nav-capsule-btn:hover:not(.disabled) {
    background: var(--bg-secondary);
    color: var(--accent-color);
}

.nav-capsule-btn.disabled {
    opacity: 0.25;
    cursor: default;
    pointer-events: none;
}

.file-header-btn {
    margin-left: auto;
    padding: 0;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 50%;
    background: var(--bg-tertiary);
    font-size: 11px;
    cursor: pointer;
    color: var(--text-secondary);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}
.file-header-btn:hover {
    background: var(--bg-secondary);
    color: var(--accent-color);
}
.file-header-btn svg {
    width: 12px;
    height: 12px;
}
.file-header-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
}
.file-header-btn:disabled:hover {
    background: transparent;
    color: var(--text-secondary);
}
.file-header-btn.active {
    background: var(--accent-color);
    color: #fff;
}

/* Dropdown */
.dropdown-wrapper {
    position: relative;
}

.dropdown-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 100;
    min-width: 140px;
    padding: 4px 0;
    overflow: hidden;
}

.dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    width: 100%;
    border: none;
    background: none;
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
}
.dropdown-item:hover {
    background: var(--accent-color);
    color: #fff;
}
.dropdown-item svg {
    flex-shrink: 0;
}

.wrap-check {
    margin-left: auto;
    color: var(--accent-color);
    font-size: 14px;
    font-weight: 700;
}
</style>
