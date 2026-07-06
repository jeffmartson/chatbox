import { settingsStore } from '@/stores/settingsStore'

declare global {
  interface Window {
    plausible?: ((event: string, options?: { props?: Record<string, unknown> }) => void) & { q?: unknown[] }
  }
}

export function trackEvent(event: string, props: Record<string, unknown> = {}) {
  if (typeof window === 'undefined' || !window.plausible) {
    return
  }
  // The Plausible script tag loads unconditionally in index.html, so the opt-out
  // must be enforced here, same as trackJkEvent/trackingEvent.
  if (!settingsStore.getState().allowReportingAndTracking) {
    return
  }
  window.plausible(event, { props })
}
