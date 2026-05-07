import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface TerminalStatus {
  running: boolean
  cwd: string
}

export function useTerminalSession(getWsUrl: () => string) {
  const { t } = useI18n()
  const connectionState: Ref<ConnectionState> = ref('disconnected')
  const errorMessage = ref('')
  const errorCode = ref('')
  const currentCwd = ref('')
  const ws: Ref<WebSocket | null> = ref(null)
  let reconnectAttempts = 0
  const maxReconnectAttempts = 3
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.value && ws.value.readyState === WebSocket.OPEN) {
        resolve()
        return
      }

      connectionState.value = 'connecting'
      errorMessage.value = ''
      errorCode.value = ''

      const url = getWsUrl()
      const socket = new WebSocket(url)

      socket.onopen = () => {
        connectionState.value = 'connected'
        reconnectAttempts = 0
        ws.value = socket
        resolve()
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          handleMessage(msg)
        } catch {
          console.warn('terminal: invalid message', event.data)
        }
      }

      socket.onclose = () => {
        if (connectionState.value === 'connected') {
          // Unexpected disconnect — try reconnecting
          connectionState.value = 'disconnected'
          ws.value = null
          tryReconnect()
        } else {
          connectionState.value = 'disconnected'
          ws.value = null
        }
      }

      socket.onerror = () => {
        errorMessage.value = t('terminal.websocketFailed')
        connectionState.value = 'error'
        ws.value = null
        reject(new Error(errorMessage.value))
      }
    })
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempts = maxReconnectAttempts // prevent reconnect
    if (ws.value) {
      ws.value.close()
      ws.value = null
    }
    connectionState.value = 'disconnected'
  }

  function tryReconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
      connectionState.value = 'error'
      errorMessage.value = t('terminal.websocketFailed')
      return
    }

    reconnectAttempts++
    connectionState.value = 'reconnecting'
    reconnectTimer = setTimeout(() => {
      connect().catch(() => {
        // tryReconnect will be called again from onclose
      })
    }, 2000 * reconnectAttempts)
  }

  // Message handler callbacks — set by TerminalPanel
  let onOutput: ((data: string) => void) | null = null
  let onReplay: ((data: string) => void) | null = null
  let onStatus: ((status: TerminalStatus) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let onError: ((message: string, code: string) => void) | null = null

  function setCallbacks(callbacks: {
    onOutput?: (data: string) => void
    onReplay?: (data: string) => void
    onStatus?: (status: TerminalStatus) => void
    onExit?: (code: number) => void
    onError?: (message: string, code: string) => void
  }) {
    onOutput = callbacks.onOutput ?? null
    onReplay = callbacks.onReplay ?? null
    onStatus = callbacks.onStatus ?? null
    onExit = callbacks.onExit ?? null
    onError = callbacks.onError ?? null
  }

  function handleMessage(msg: { type: string; data?: string; cwd?: string; running?: boolean; code?: number; message?: string; errcode?: string }) {
    switch (msg.type) {
      case 'output':
        onOutput?.(msg.data ?? '')
        break
      case 'replay':
        onReplay?.(msg.data ?? '')
        break
      case 'status':
        currentCwd.value = msg.cwd ?? ''
        onStatus?.({ running: msg.running ?? true, cwd: msg.cwd ?? '' })
        break
      case 'exit':
        connectionState.value = 'disconnected'
        onExit?.(msg.code ?? 0)
        break
      case 'error':
        errorMessage.value = msg.message ?? ''
        errorCode.value = msg.errcode ?? ''
        if (msg.errcode === 'session_in_use') {
          connectionState.value = 'error'
        }
        onError?.(msg.message ?? '', msg.errcode ?? '')
        break
    }
  }

  function sendInput(data: string) {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({ type: 'input', data }))
    }
  }

  function sendResize(cols: number, rows: number) {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }

  function sendClose() {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({ type: 'close' }))
    }
    disconnect()
  }

  return {
    connectionState,
    errorMessage,
    errorCode,
    currentCwd,
    connect,
    disconnect,
    setCallbacks,
    sendInput,
    sendResize,
    sendClose,
  }
}
