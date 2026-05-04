import { ref, computed, type Ref } from 'vue'
import { gt } from '@/composables/useLocale'
import { useToast } from '@/composables/useToast.ts'
import { useNotification } from '@/composables/useNotification.ts'
import { useSessionIdentity } from '@/composables/useSessionIdentity.ts'
import { useAgents } from '@/composables/useAgents.ts'
import { store } from '@/stores/app.ts'

export interface UseChatSessionOptions {
  currentSessionId: Ref<string>
  messages: Ref<any[]>
  loading: Ref<boolean>
  inputDisabled: Ref<boolean>
  blockProposals: Record<string, any>
  blockAskQuestions: Record<string, any>
  expandedTools: Ref<Record<string, boolean>>
  switching?: Ref<boolean>
  onParseAssistantContent: (content: string) => any
  onExtractScheduleProposals: (msgs: any[]) => void
  onRenderUpdate: (forceFull: boolean) => void
  onScrollBottom: (force?: boolean) => void
  onConnectStream: (sessionId: string) => void
  onStopPolling: () => void
  onDisconnectStream: () => void
  onMessage: () => void
  onOpen: () => void
  isOpen: Ref<boolean>
  onStreamDone?: () => void
}

export function useChatSession(options: UseChatSessionOptions) {
  const {
    currentSessionId,
    messages,
    loading,
    inputDisabled,
    blockProposals,
    blockAskQuestions,
    expandedTools,
    onParseAssistantContent,
    onExtractScheduleProposals,
    onRenderUpdate,
    onScrollBottom,
    onConnectStream,
    onStopPolling,
    onDisconnectStream,
    onMessage,
    onOpen,
    isOpen,
    onStreamDone,
  } = options

  const toast = useToast()
  const notification = useNotification()

  // ── Identity refs from singleton ──
  const identity = useSessionIdentity()
  const { currentSessionTitle, currentBackend, currentAgentId, runningSessions } = identity

  // ── Agents from singleton ──
  const { agents, loadAgents, getAgentIcon, getAgentName } = useAgents()

  // Switching state — true while a session switch is in progress (distinct from
  // "loading" which means "AI is generating"). Used to show a fade/placeholder
  // transition so the user sees immediate feedback instead of a frozen UI.
  const switching = ref(false)

  const sessionDrawerOpen = ref(false)
  const taskDrawerOpen = ref(false)
  const lastMsgCount = ref(0)
  let msgCountInterval: ReturnType<typeof setInterval> | null = null
  let globalPollingInterval: ReturnType<typeof setInterval> | null = null

  // Pagination state
  const totalMessages = ref(0)
  const loadingMore = ref(false)
  const hasMore = computed(() => messages.value.length < totalMessages.value)

  const agentHeaderTitle = computed(() => {
    const agent = agents.value.find(a => a.id === currentAgentId.value)
    if (agent) return `${agent.icon} ${agent.name}`
    return gt('chat.session.aiDialog')
  })

  // Guard against concurrent switchSession calls — only the last one wins
  let switchSessionSeq = 0

  function parseMessages(rawMsgs) {
    return rawMsgs.map(msg => {
      if (msg.role === 'assistant') {
        const { blocks, metadata, cancelled } = onParseAssistantContent(msg.content)
        msg.blocks = blocks
        if (metadata) msg.metadata = metadata
        if (cancelled) msg.cancelled = cancelled
        if (msg.streaming) { msg.streaming = true; msg.fromDB = true }
      } else if (msg.role === 'user' && !msg.blocks) {
        // User messages also use ContentBlocks for unified rendering & auto-collapse
        msg.blocks = msg.content ? [{ type: 'text', text: msg.content }] : []
      }
      return msg
    })
  }

  // ── Change detection for polling ──
  // Tracks a lightweight fingerprint of the last loaded messages.
  // When polling-triggered reloads find no change, the UI is not refreshed,
  // preventing expandedTools collapse, scroll reset, and unnecessary re-renders.
  let lastMessageSnapshot = ''

  function buildMessageSnapshot(rawMsgs: any[]): string {
    // Fingerprint: each message's ID + role + content length + createdAt + streaming flag
    // Detects new/deleted messages and content changes without comparing full content.
    return rawMsgs.map(m =>
      `${m.id ?? ''}:${m.role}:${(m.content || '').length}:${m.createdAt || ''}:${m.streaming ? 1 : 0}`
    ).join('|')
  }

  // forceScrollBottom: true = always scroll to bottom (switch session, first load)
  //                   false = only scroll if already near bottom (re-open panel, polling)
  // showOverlay: true = show the switching overlay (session switch, first open)
  //            false = silent reload (stream done, polling)
  // skipIfUnchanged: true = when data matches last snapshot, skip UI refresh entirely
  //                (used by polling to avoid collapsing expandedTools / resetting scroll)
  async function loadHistory(forceScrollBottom = true, showOverlay = false, skipIfUnchanged = false) {
    if (showOverlay) switching.value = true
    try {
      // Load agents first so we can resolve agent names
      if (agents.value.length === 0) await loadAgents()
      // Use max of initialMessages and current loaded count to avoid truncating lazy-loaded messages
      const limit = Math.max(store.state.chatInitialMessages, messages.value.length)
      const url = currentSessionId.value
        ? `/api/ai/chat?session_id=${encodeURIComponent(currentSessionId.value)}&limit=${limit}`
        : `/api/ai/chat?limit=${limit}`
      const resp = await fetch(url)
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(errData.error || gt('chat.session.requestFailed', { status: resp.status }))
      }
      const data = await resp.json()
      const rawMsgs = data.messages || []

      // Change detection: if skipIfUnchanged and data matches last snapshot, do nothing.
      // Always refresh when session is running (SSE events may have been dropped).
      const newSnapshot = buildMessageSnapshot(rawMsgs)
      if (skipIfUnchanged && newSnapshot === lastMessageSnapshot && !data.running) {
        switching.value = false
        return
      }
      lastMessageSnapshot = newSnapshot

      // Data has changed (or this is a full load) — reset UI state and apply new data
      expandedTools.value = {}
      messages.value = parseMessages(rawMsgs)
      totalMessages.value = data.total || messages.value.length
      currentSessionId.value = data.sessionId || ''
      currentSessionTitle.value = data.sessionTitle || ''
      currentBackend.value = data.backend || ''
      currentAgentId.value = data.agentId || ''
      onExtractScheduleProposals(messages.value)
      onRenderUpdate(true)
      if (data.running) {
        loading.value = true
        stopMsgCountPolling()
        onScrollBottom(true)
        onConnectStream(currentSessionId.value)
      } else {
        loading.value = false
        startMsgCountPolling()
        onScrollBottom(forceScrollBottom)
      }
      switching.value = false
    } catch (err) {
      console.error('Failed to load chat history:', err)
      toast.show(err.message || gt('chat.session.loadHistoryFailed'), { icon: '⚠️', type: 'error' })
      switching.value = false
    }
  }

  async function loadMoreMessages() {
    if (loadingMore.value || !hasMore.value || !currentSessionId.value) return
    loadingMore.value = true
    try {
      const pageSize = store.state.chatPageSize
      // Use cursor-based pagination: pass the created_at of the oldest loaded message
      const oldestMsg = messages.value[0]
      const before = oldestMsg?.createdAt || ''
      const resp = await fetch(`/api/ai/chat?session_id=${encodeURIComponent(currentSessionId.value)}&limit=${pageSize}&before=${encodeURIComponent(before)}`)
      if (!resp.ok) return
      const data = await resp.json()
      const olderMsgs = parseMessages(data.messages || [])
      if (olderMsgs.length > 0) {
        messages.value = [...olderMsgs, ...messages.value]
        totalMessages.value = data.total || totalMessages.value
        onExtractScheduleProposals(olderMsgs)
        onRenderUpdate(true)
      }
    } catch (err) {
      console.error('Failed to load more messages:', err)
    } finally {
      loadingMore.value = false
    }
  }

  async function switchSession(sessionId) {
    // Increment sequence counter — if another switch starts before we finish,
    // our results will be discarded (last writer wins)
    const mySeq = ++switchSessionSeq

    // Mark switching state immediately so UI can show a fade/placeholder
    switching.value = true
    // Briefly lock input to prevent sending messages with stale sessionId.
    // This is the ONLY place inputDisabled is set to true — it defaults to false
    // and is restored as soon as the switch completes (even if the session is running).
    inputDisabled.value = true

    onDisconnectStream()
    onStopPolling()
    stopMsgCountPolling()
    lastMessageSnapshot = ''  // Invalidate snapshot — new session may have different data
    expandedTools.value = {}
    try {
      // Load agents first so we can resolve agent names
      if (agents.value.length === 0) await loadAgents()
      const limit = store.state.chatInitialMessages
      const resp = await fetch(`/api/ai/chat?session_id=${encodeURIComponent(sessionId)}&limit=${limit}`)
      if (!resp.ok) {
        toast.show(gt('chat.session.switchFailed'), { icon: '⚠️', type: 'error' })
        return
      }
      const data = await resp.json()

      // If another switch happened while we were fetching, discard our results
      // (the newer switch will set switching=false when it completes)
      if (switchSessionSeq !== mySeq) return

      messages.value = parseMessages(data.messages || [])
      totalMessages.value = data.total || messages.value.length
      currentSessionId.value = data.sessionId || sessionId
      currentSessionTitle.value = data.sessionTitle || ''
      currentBackend.value = data.backend || ''
      currentAgentId.value = data.agentId || ''
      onExtractScheduleProposals(messages.value)
      onRenderUpdate(true)
      onScrollBottom(true)
      if (data.running) {
        loading.value = true
        stopMsgCountPolling()
        onConnectStream(sessionId)
      } else {
        loading.value = false
        startMsgCountPolling()
      }
    } catch (err) {
      // If another switch happened, don't touch state
      if (switchSessionSeq !== mySeq) return
      console.error('Failed to switch session:', err)
      toast.show(gt('chat.session.switchFailed'), { icon: '⚠️', type: 'error' })
    } finally {
      // Always restore input — switchSession is the only place that locks it,
      // so it must always unlock regardless of success/failure/race.
      // If a newer switch started, it will set inputDisabled=true again immediately.
      inputDisabled.value = false
      switching.value = false
    }
  }

  async function createSession(agentId) {
    try {
      // Load agents first so UI can resolve agent names
      if (agents.value.length === 0) await loadAgents()
      const body = agentId ? { agentId } : {}
      const resp = await fetch('/api/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || gt('chat.session.createFailed', { status: resp.status }))
      }
      currentSessionId.value = data.sessionId
      currentSessionTitle.value = data.title || ''
      currentBackend.value = data.backend || ''
      currentAgentId.value = data.agentId || agentId || ''
      messages.value = []
      totalMessages.value = 0
      lastMessageSnapshot = ''  // New session — no messages yet
      Object.keys(blockProposals).forEach(k => delete blockProposals[k])
      Object.keys(blockAskQuestions).forEach(k => delete blockAskQuestions[k])
      loading.value = false
      const maxCount = store.state.sessionMaxCount
      toast.show(gt('chat.session.created', { count: data.sessionCount ?? '', max: maxCount }), { icon: '✨', type: 'success', duration: 1500 })
    } catch (err) {
      console.error('Failed to create session:', err)
      toast.show(err.message || gt('chat.session.createSessionFailed'), { icon: '⚠️', type: 'error' })
    }
  }

  async function deleteSession(sessionId, backend) {
    try {
      const resp = await fetch(`/api/ai/session/delete?session_id=${encodeURIComponent(sessionId)}&backend=${encodeURIComponent(backend || '')}`, {
        method: 'DELETE',
      })
      const data = await resp.json()
      if (data.ok) {
        // If deleted current session, switch to another
        if (sessionId === currentSessionId.value) {
          const sessionsResp = await fetch('/api/ai/sessions')
          const sessionsData = await sessionsResp.json()
          if (sessionsData.sessions && sessionsData.sessions.length > 0) {
            await switchSession(sessionsData.sessions[0].id, sessionsData.sessions[0].backend)
          } else {
            // No sessions left, create a default one
            await createSession()
          }
        }
        const maxCount = store.state.sessionMaxCount
        toast.show(gt('chat.session.deleted', { count: data.sessionCount ?? '', max: maxCount }), { icon: '🗑️', type: 'success', duration: 2000 })
      }
    } catch (err) {
      console.error('Failed to delete session:', err)
      toast.show(gt('chat.session.deleteFailed'), { icon: '⚠️', type: 'error' })
    }
  }

  function openSessionTab(tab) {
    if (tab === 'tasks') {
      taskDrawerOpen.value = true
    } else {
      sessionDrawerOpen.value = true
    }
  }

  function startMsgCountPolling() {
    stopMsgCountPolling()
    if (!currentSessionId.value) return
    lastMsgCount.value = messages.value.length
    msgCountInterval = setInterval(async () => {
      if (!currentSessionId.value || loading.value) return
      try {
        const resp = await fetch(`/api/ai/chat/count?session_id=${encodeURIComponent(currentSessionId.value)}`)
        if (!resp.ok) return
        const data = await resp.json()
        if (data.count > lastMsgCount.value) {
          lastMsgCount.value = data.count
          // Reload history to pick up new messages (don't force scroll, skip if unchanged)
          await loadHistory(false, false, true)
        }
      } catch (err) {
        // Silently ignore polling errors
      }
    }, 15000)
  }

  function stopMsgCountPolling() {
    if (msgCountInterval) { clearInterval(msgCountInterval); msgCountInterval = null }
  }

  function stopGlobalPolling() {
    if (globalPollingInterval) { clearInterval(globalPollingInterval); globalPollingInterval = null }
  }

  // Track which sessions have already had their completion notification fired.
  // Prevents repeated sound/notification if an exception in the callback
  // prevents runningSessions from being updated.
  const notifiedSessions = new Set<string>()

  async function startGlobalPolling() {
    stopGlobalPolling()
    globalPollingInterval = setInterval(async () => {
      try {
        const resp = await fetch('/api/ai/sessions')
        const data = await resp.json()
        const sessions = data.sessions || []
        const newRunning = new Set(sessions.filter(s => s.running).map(s => s.id))

        // Check for unread messages in other sessions
        const hasUnreadOther = sessions.some(s => s.unreadCount > 0 && s.id !== currentSessionId.value)
        store.state.chatUnread = hasUnreadOther

        // Calculate total chat unread count for native badge
        const totalChatUnread = sessions.reduce((sum, s) => sum + (s.unreadCount || 0), 0)

        // Track running sessions for dock/chat button indicator
        store.state.chatRunning = newRunning.size > 0

        // Check for unread task executions
        let totalTaskUnread = 0
        try {
          const taskResp = await fetch('/api/tasks')
          if (taskResp.ok) {
            const taskData = await taskResp.json()
            store.state.taskUnread = !!taskData.hasUnread
            store.state.tasks = taskData.tasks || []
            totalTaskUnread = (taskData.tasks || []).reduce((sum: number, t: any) => sum + (t.unreadCount || 0), 0)
          }
        } catch (_) {}

        // Check for completed sessions
        const completedSessions: string[] = []
        for (const sessionId of runningSessions.value) {
          if (!newRunning.has(sessionId)) {
            completedSessions.push(sessionId)
          }
        }

        // Update runningSessions FIRST so that even if callbacks throw,
        // we won't re-detect these sessions as "just completed" on the next poll.
        runningSessions.value = newRunning

        // Clean up notifiedSessions: remove entries that are no longer running
        // and have already been processed.
        for (const sid of completedSessions) {
          notifiedSessions.delete(sid)
        }

        // Now fire callbacks for completed sessions (with idempotency guard)
        for (const sessionId of completedSessions) {
          if (notifiedSessions.has(sessionId)) continue
          notifiedSessions.add(sessionId)

          if (sessionId === currentSessionId.value) {
            // Current session completed but UI may be stuck in loading state
            // (e.g. done event was dropped) — force reset with full reload
            if (loading.value) {
              loadHistory(true, false, true)
            }
          } else {
            // Other session completed
            const session = sessions.find(s => s.id === sessionId)
            if (session) {
              onStreamDone?.()
              toast.show(gt('chat.session.completed'), {
                icon: '✅',
                type: 'success',
                duration: 5000,
                onClick: () => {
                  switchSession(sessionId, session.backend)
                  onOpen()
                }
              })
              // Also show browser notification for completed session
              try {
                notification.show(gt('chat.session.completed'), {
                  body: gt('chat.session.clickToViewDetails'),
                  onClick: () => {
                    switchSession(sessionId, session.backend)
                    onOpen()
                  }
                })
              } catch (e) {
                console.warn('Failed to show browser notification:', e)
              }
            }
          }
        }
      } catch (err) {
        console.error('Global polling error:', err)
      }
    }, 2000)
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && loading.value) {
      // Page became visible while streaming - reconnect
      onDisconnectStream()
      onStopPolling()
      loadHistory(true, false, true).catch(() => {
        // loadHistory failed — reset loading state so user isn't stuck
        loading.value = false
      })
    }
  }

  return {
    // Identity refs — from singleton, but still returned for backward compat
    // (ChatPanel uses session.currentSessionTitle.value, etc.)
    currentSessionId,
    currentSessionTitle,
    currentBackend,
    currentAgentId,
    runningSessions,
    // UI state — local to this instance
    sessionDrawerOpen,
    taskDrawerOpen,
    agentHeaderTitle,
    totalMessages,
    hasMore,
    loadingMore,
    switching,
    // Operations
    loadHistory,
    loadMoreMessages,
    switchSession,
    createSession,
    deleteSession,
    openSessionTab,
    startGlobalPolling,
    stopGlobalPolling,
    startMsgCountPolling,
    stopMsgCountPolling,
    handleVisibilityChange,
    // Agent helpers — delegate to singleton
    getAgentIcon,
    getAgentName,
  }
}
