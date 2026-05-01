<template>
  <Transition name="quote-bar">
    <div v-if="visible && quoteData" ref="barRef" class="quote-question-bar">
      <!-- Collapsed: preview + button -->
      <div v-if="!expanded" class="quote-bar-row">
        <div class="quote-bar-preview">
          <span class="quote-bar-icon">💬</span>
          <span class="quote-bar-text">{{ previewText }}</span>
        </div>
        <button class="quote-bar-btn" @click="expand">
          引用提问
        </button>
      </div>

      <!-- Expanded: session info + input + send -->
      <div v-else class="quote-bar-expanded">
        <div class="qq-session" @click="openSessionDrawer">
          <span class="qq-session-icon">{{ sessionIcon }}</span>
          <span class="qq-session-name">{{ displaySessionName }}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="qq-input-row">
          <textarea
            ref="inputRef"
            v-model="inputText"
            class="qq-input"
            rows="2"
            placeholder="输入你的问题..."
            @keydown.enter.meta="handleSend"
            @keydown.enter.ctrl="handleSend"
          />
          <div class="qq-actions">
            <button class="qq-action-btn qq-cancel-btn" @click="collapse" title="取消">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            <button class="qq-action-btn qq-send-btn" :disabled="!canSend" @click="handleSend" title="发送">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'

const props = defineProps({
  visible: Boolean,
  quoteData: Object,
  sessionIcon: { type: String, default: '🤖' },
  sessionTitle: { type: String, default: '' },
  currentSessionId: { type: String, default: '' },
})
const emit = defineEmits(['send', 'close', 'pin', 'open-sessions'])

const expanded = ref(false)
const inputText = ref('')
const inputRef = ref(null)
const barRef = ref(null)

const previewText = computed(() => {
  if (!props.quoteData) return ''
  const text = props.quoteData.text || ''
  return text.length > 60 ? text.slice(0, 60) + '…' : text
})

const canSend = computed(() => inputText.value.trim().length > 0)

const displaySessionName = computed(() => {
  return props.sessionTitle || '新会话'
})

// Reset when bar hides
watch(() => props.visible, (val) => {
  if (!val) {
    expanded.value = false
    inputText.value = ''
  }
})

// Click outside to close
function onPointerDown(e) {
  if (!props.visible) return
  if (!barRef.value) return
  // Don't close if clicking inside the bar
  if (barRef.value.contains(e.target)) return
  // Don't close if clicking inside a BottomSheet (bs-overlay/bs-panel) or ModalDialog
  if (e.target.closest('.bs-overlay, .bs-panel, .modal-dialog')) return
  emit('close')
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
})

async function expand() {
  emit('pin')  // Pin bar so selection loss won't auto-hide it
  expanded.value = true
  await nextTick()
  inputRef.value?.focus()
}

function collapse() {
  expanded.value = false
  inputText.value = ''
  emit('close')
}

function openSessionDrawer() {
  // Delegate to the existing SessionDrawer via event
  emit('open-sessions')
}

function handleSend() {
  if (!canSend.value) return
  // Always send to current session (after switching via SessionDrawer if needed)
  emit('send', inputText.value)
  expanded.value = false
  inputText.value = ''
}
</script>

<style scoped>
.quote-question-bar {
  position: fixed;
  top: calc(48px + env(safe-area-inset-top, 0px));
  left: 8px;
  right: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: var(--shadow-md);
  z-index: 2400;
  max-width: 400px;
  margin: 0 auto;
  overflow: hidden;
}

/* Collapsed row */
.quote-bar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
}

.quote-bar-preview {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.quote-bar-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.quote-bar-text {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quote-bar-btn {
  flex-shrink: 0;
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: var(--accent-color);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.quote-bar-btn:active {
  opacity: 0.8;
}

/* Expanded */
.quote-bar-expanded {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qq-session {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.qq-session:active {
  background: var(--bg-secondary);
}

.qq-session-icon {
  font-size: 12px;
}

.qq-session-name {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qq-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.qq-input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  resize: none;
  min-height: 48px;
  max-height: 80px;
  outline: none;
  font-family: inherit;
  line-height: 1.4;
}

.qq-input:focus {
  border-color: var(--accent-color);
}

.qq-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

.qq-action-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity 0.15s;
}

.qq-action-btn:active {
  opacity: 0.7;
}

.qq-cancel-btn {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.qq-send-btn {
  background: var(--accent-color);
  color: #fff;
}

.qq-send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Transition */
.quote-bar-enter-active {
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.quote-bar-leave-active {
  transition: all 0.15s ease-in;
}

.quote-bar-enter-from,
.quote-bar-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
