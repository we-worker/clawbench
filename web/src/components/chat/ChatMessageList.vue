<template>
  <div class="chat-messages" id="aiChatMessages" ref="messagesRef" @click="handleChatClick" @scroll="handleScroll">
    <!-- Lazy load feedback -->
    <div class="chat-load-area">
      <Transition name="load-hint-fade">
        <div v-if="loadingMore" class="chat-load-more">
          <span class="chat-load-spinner"></span>
          <span>{{ t('chat.messageList.loadingMore') }}</span>
        </div>
        <div v-else-if="hasMore && remainingCount > 0" class="chat-load-hint" @click="emit('load-more')">
          <ChevronUp :size="14" />
          <span>{{ t('chat.messageList.moreOlderMessages', { count: remainingCount }) }}</span>
        </div>
        <div v-else-if="showAllLoaded" class="chat-load-done">
          <span>{{ t('chat.messageList.allMessagesLoaded') }}</span>
        </div>
      </Transition>
    </div>

    <div class="chat-messages-list">
      <div v-if="messages.length === 0" class="chat-empty">
      <template v-if="currentAgent">
        <div class="agent-welcome">
          <span class="agent-welcome-icon">{{ currentAgent.icon }}</span>
          <div class="agent-welcome-info">
            <span class="agent-welcome-name">{{ currentAgent.name }}</span>
            <span class="agent-welcome-specialty">{{ currentAgent.specialty }}</span>
            <div class="agent-welcome-tags">
              <span class="agent-welcome-tag agent-welcome-backend">{{ currentAgent.backend }}</span>
              <span v-if="currentAgent.model" class="agent-welcome-tag agent-welcome-model">{{ currentAgent.model }}</span>
            </div>
          </div>
        </div>
        <span class="agent-welcome-hint">{{ t('chat.messageList.startConversation') }}</span>
      </template>
      <span v-else>{{ t('chat.messageList.startConversationAI') }}</span>
    </div>

    <ChatMessageItem
      v-for="(msg, i) in messages"
      :key="msg.id ? 'db-' + msg.id : 'local-' + i"
      :msg="msg"
      :index="i"
      :expandedTools="expandedTools"
      :blockProposals="blockProposals"
      :blockAskQuestions="blockAskQuestions"
      :agents="agents"
      :shouldCollapse="isCollapsed(i, msg)"
      @toggle-tool="$emit('toggle-tool', $event)"
      @show-metadata="$emit('show-metadata', $event)"
      @file-tag-click="$emit('file-tag-click', $event)"
      @edit-task="$emit('edit-task', $event)"
      @send-message="$emit('send-message', $event)"
      @expand="handleExpand"
      @collapse="handleCollapse"
      @render-flush="emit('render-flush')"
    />
    </div>

    <!-- Pending messages (queued while AI is generating) -->
    <div v-if="pendingMessages.length > 0" class="pending-messages-list">
      <PendingMessageItem
        v-for="(msg, i) in pendingMessages"
        :key="'pending-' + i"
        :msg="msg"
        :index="i"
        @remove="$emit('remove-pending', $event)"
        @file-tag-click="$emit('file-tag-click', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, inject, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronUp } from 'lucide-vue-next'
import ChatMessageItem from './ChatMessageItem.vue'
import PendingMessageItem from './PendingMessageItem.vue'
import { useDoubleClickCopy } from '@/composables/useDoubleClickCopy.ts'
import { useFilePathAnnotation } from '@/composables/useFilePathAnnotation.ts'

const { t } = useI18n()

const props = defineProps({
  messages: Array,
  expandedTools: Object,
  blockProposals: Object,
  blockAskQuestions: Object,
  agents: Array,
  currentAgent: Object,
  currentSessionId: String,
  hasMore: Boolean,
  loadingMore: Boolean,
  totalMessages: { type: Number, default: 0 },
  pendingMessages: { type: Array, default: () => [] },
})

const emit = defineEmits(['toggle-tool', 'show-metadata', 'file-tag-click', 'file-open', 'load-more', 'edit-task', 'send-message', 'remove-pending', 'render-flush'])

const messagesRef = ref(null)
const { handleDblClick } = useDoubleClickCopy()
const { openFilePath } = useFilePathAnnotation()

// How many older messages are not yet loaded
const remainingCount = computed(() => {
  if (!props.hasMore) return 0
  return Math.max(0, props.totalMessages - props.messages.length)
})

// "All loaded" brief hint: shown for 2s after last load completes with no more
const showAllLoaded = ref(false)
let allLoadedTimer = null

watch(() => props.hasMore, (hasMore, prevHasMore) => {
  // When transitioning from hasMore=true to hasMore=false (just finished loading all)
  if (!hasMore && prevHasMore && props.messages.length > 0) {
    showAllLoaded.value = true
    clearTimeout(allLoadedTimer)
    allLoadedTimer = setTimeout(() => { showAllLoaded.value = false }, 2000)
  }
})

// Track manually expanded/collapsed message indices
// expandedSet: indices that user manually expanded (should not auto-collapse)
// collapsedSet: indices that user manually collapsed after expanding (should auto-collapse even if last round)
const expandedSet = ref(new Set())
const collapsedSet = ref(new Set())

// Reset expanded/collapsed state when messages change identity (session switch / reload)
// Also reset isAtBottom so auto-scroll re-engages for the new session
watch(() => props.messages, () => {
  expandedSet.value = new Set()
  collapsedSet.value = new Set()
  isAtBottom = true
})

// Compute the last round: last assistant message + its preceding user message
const lastRoundIndices = computed(() => {
  const msgs = props.messages
  if (!msgs || msgs.length === 0) return new Set()

  // Find last assistant message index
  let lastAssistantIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  const indices = new Set()
  if (lastAssistantIdx >= 0) {
    indices.add(lastAssistantIdx)
    // Find the preceding user message
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        indices.add(i)
        break
      }
    }
  } else {
    // No assistant message — expand last user message
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        indices.add(i)
        break
      }
    }
  }

  return indices
})

function isCollapsed(index, msg) {
  // User explicitly collapsed this message — suggest collapse
  if (collapsedSet.value.has(index)) return true
  // Last round is always fully expanded (no collapse suggestion) unless user collapsed it
  if (lastRoundIndices.value.has(index)) return false
  // Manually expanded — don't suggest collapse
  if (expandedSet.value.has(index)) return false
  // Everything else: suggest collapse (ChatMessageItem decides whether content actually overflows)
  return true
}

function handleExpand(index) {
  expandedSet.value = new Set([...expandedSet.value, index])
  // Remove from collapsedSet if it was there
  if (collapsedSet.value.has(index)) {
    const newSet = new Set(collapsedSet.value)
    newSet.delete(index)
    collapsedSet.value = newSet
  }
}

function handleCollapse(index) {
  collapsedSet.value = new Set([...collapsedSet.value, index])
  // Remove from expandedSet if it was there
  if (expandedSet.value.has(index)) {
    const newSet = new Set(expandedSet.value)
    newSet.delete(index)
    expandedSet.value = newSet
  }
}

// Inject bottomSheetRef from parent for closing
const chatUI = inject('chatUI', {})

function handleChatClick(event) {
  const btn = (event.target).closest('.chat-file-open-btn')
  if (btn) {
    event.preventDefault()
    event.stopPropagation()
    const filePath = btn.getAttribute('data-file-path')
    if (filePath) {
      openFilePath(filePath)
      chatUI.closeSheet?.()
    }
    return
  }
  handleDblClick(event, (href) => {
    openFilePath(href)
    chatUI.closeSheet?.()
  })
}

let loadMorePending = false
// Track whether the user is at the bottom of the chat.
// When the user scrolls back to the bottom during streaming, auto-scroll resumes.
let isAtBottom = true

const NEAR_BOTTOM_THRESHOLD = 60

function handleScroll() {
  if (!messagesRef.value) return
  const el = messagesRef.value

  // Update isAtBottom state based on current scroll position
  isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD

  if (loadMorePending) return
  if (!props.hasMore || props.loadingMore) return
  if (el.scrollTop < 50) {
    loadMorePending = true
    emit('load-more')
    nextTick(() => { loadMorePending = false })
  }
}

function scrollToBottom(force = false) {
  nextTick(() => {
    if (!messagesRef.value) return
    const el = messagesRef.value
    if (force || isAtBottom) {
      el.scrollTop = el.scrollHeight
      // Verify the scroll actually reached the bottom — content may have grown
      // between the scrollToBottom call and this nextTick callback, or may grow
      // after this callback completes (streaming text, throttled render flush).
      // Use requestAnimationFrame to re-check after the browser has laid out
      // the DOM changes, and do a second scroll if still not at the bottom.
      requestAnimationFrame(() => {
        if (!messagesRef.value) return
        const el = messagesRef.value
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight
        if (gap > 0) {
          el.scrollTop = el.scrollHeight
        }
        // Final isAtBottom state based on actual scroll position after correction
        isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
        // For force scrolls, also do a delayed re-scroll to catch async content
        // rendering (Mermaid, KaTeX, collapse transitions) that settles later.
        if (force) {
          setTimeout(() => {
            if (!messagesRef.value) return
            const el = messagesRef.value
            el.scrollTop = el.scrollHeight
            isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
          }, 300)
        }
      })
    }
  })
}

defineExpose({
  scrollToBottom,
  messagesRef,
})
</script>

<style scoped>
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
}

/* Message list container */
.chat-messages-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-muted);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.agent-welcome {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  max-width: 280px;
  width: 100%;
  text-align: left;
}

.agent-welcome-icon {
  font-size: 28px;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: 10px;
}

.agent-welcome-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.agent-welcome-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.agent-welcome-specialty {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.agent-welcome-tags {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.agent-welcome-tag {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
  flex-shrink: 0;
}

.agent-welcome-backend {
  background: rgba(0, 102, 204, 0.1);
  color: var(--accent-color);
}

.agent-welcome-model {
  background: rgba(100, 100, 100, 0.08);
  color: var(--text-muted);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-welcome-hint {
    font-size: 12px;
    color: color-mix(in srgb, var(--text-muted) 70%, transparent);
}

/* Lazy load feedback area */
.chat-load-area {
  position: relative;
  min-height: 0;
}

.chat-load-more,
.chat-load-hint,
.chat-load-done {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-muted);
}

.chat-load-hint {
  cursor: pointer;
  transition: color 0.15s, opacity 0.15s;
  -webkit-tap-highlight-color: transparent;
}

.chat-load-hint:active {
  opacity: 0.6;
}

@media (hover: hover) {
  .chat-load-hint:hover {
    color: var(--text-secondary);
  }
}

.chat-load-done {
  color: var(--text-muted);
  opacity: 0.7;
  font-size: 11px;
}

.chat-load-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: tool-spin 0.6s linear infinite;
}

@keyframes tool-spin {
  to { transform: rotate(360deg); }
}

/* Transition for load hint switching */
.load-hint-fade-enter-active {
  transition: opacity 0.2s ease-out;
}
.load-hint-fade-leave-active {
  transition: opacity 0.15s ease-in;
}
.load-hint-fade-enter-from,
.load-hint-fade-leave-to {
  opacity: 0;
}

/* Pending messages list */
.pending-messages-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}

</style>
