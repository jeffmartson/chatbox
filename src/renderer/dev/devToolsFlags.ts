const SHOW_GUIDE_DEV_BUTTONS_KEY = 'dev-tools:show-guide-dev-buttons'

export function getShowGuideDevButtonsFlag() {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(SHOW_GUIDE_DEV_BUTTONS_KEY) === 'true'
}

export function setShowGuideDevButtonsFlag(show: boolean) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SHOW_GUIDE_DEV_BUTTONS_KEY, show ? 'true' : 'false')
}
