import { ref } from 'vue'

// Module-level singleton — all consumers share the same state
const isAppMode = ref(false)
let initialized = false

/**
 * Detects if the app is running inside the Android native WebView.
 * Uses the AndroidNative.isNativeApp() JS bridge method,
 * with User-Agent as fallback.
 */
export function useAppMode() {
  if (!initialized) {
    initialized = true
    try {
      // Method 1: JS Bridge (most reliable)
      if (typeof (window as any).AndroidNative !== 'undefined') {
        isAppMode.value = (window as any).AndroidNative.isNativeApp() === true
      }
      // Method 2: User-Agent fallback
      if (!isAppMode.value && navigator.userAgent.includes('ClawBench-Android')) {
        isAppMode.value = true
      }
    } catch {
      // Not in native app
    }
  }
  return { isAppMode }
}
