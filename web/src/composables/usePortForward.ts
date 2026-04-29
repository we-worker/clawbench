import { ref } from 'vue'
import { apiGet, apiPost, apiDelete } from '@/utils/api.ts'
import { useAppMode } from './useAppMode.ts'

interface ForwardedPort {
  port: number
  name: string
  autoDetect: boolean
  active: boolean
}

// Module-level shared state
const ports = ref<ForwardedPort[]>([])
const detectedPorts = ref<number[]>([])
const loading = ref(false)

/**
 * Manages port forwarding state: list of forwarded ports, CRUD operations,
 * auto-detection, and registration with Android native layer.
 */
export function usePortForward() {
  const { isAppMode } = useAppMode()

  async function loadPorts() {
    loading.value = true
    try {
      const data = await apiGet<{ ports: ForwardedPort[] }>('/api/proxy/ports')
      ports.value = data.ports || []
    } finally {
      loading.value = false
    }
  }

  async function registerPort(port: number, name?: string) {
    await apiPost('/api/proxy/ports', { port, name: name || '' })
    // Register with Android native layer
    if (isAppMode.value) {
      ;(window as any).AndroidNative?.addForwardedPort(port)
    }
    await loadPorts()
  }

  async function unregisterPort(port: number) {
    await apiDelete(`/api/proxy/ports/${port}`)
    if (isAppMode.value) {
      ;(window as any).AndroidNative?.removeForwardedPort(port)
    }
    await loadPorts()
  }

  async function detectPorts() {
    const data = await apiGet<{ ports: number[] }>('/api/proxy/detect')
    detectedPorts.value = data.ports || []
  }

  /** Sync all registered ports to Android native on initial load */
  async function syncToNative() {
    if (!isAppMode.value) return
    await loadPorts()
    for (const p of ports.value) {
      ;(window as any).AndroidNative?.addForwardedPort(p.port)
    }
  }

  /** Open a forwarded port in the WebView (triggers shouldInterceptRequest on Android) */
  function openPort(port: number) {
    window.open(`http://localhost:${port}`, '_blank')
  }

  return {
    ports,
    detectedPorts,
    loading,
    isAppMode,
    loadPorts,
    registerPort,
    unregisterPort,
    detectPorts,
    syncToNative,
    openPort,
  }
}
