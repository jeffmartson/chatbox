import type { CSSProperties } from 'react'

export const SELECTED_CLASS = 'bg-chatbox-background-brand-secondary text-chatbox-tint-primary'
export const HOVER_CLASS = 'hover:bg-chatbox-background-brand-secondary-hover'
export const FALLBACK_UPGRADE_URL = 'https://chatboxai.app/#pricing'
export const DESKTOP_DETAIL_CARD_WIDTH = 320
export const DESKTOP_DETAIL_CARD_GAP = 12
export const DESKTOP_DETAIL_VIEWPORT_MARGIN = 12
export const EMPTY_MODEL_IDS: string[] = []

export const CARD_SURFACE_STYLE: CSSProperties = {
  background:
    'linear-gradient(180deg, color-mix(in srgb, var(--chatbox-background-secondary), var(--chatbox-background-primary) 18%), var(--chatbox-background-primary))',
  borderColor: 'color-mix(in srgb, var(--chatbox-border-secondary), transparent 18%)',
  boxShadow: '0 22px 52px rgb(0 0 0 / 0.24)',
}

export const DRAWER_SURFACE_STYLE: CSSProperties = {
  background:
    'linear-gradient(180deg, color-mix(in srgb, var(--chatbox-background-secondary), var(--chatbox-background-primary) 12%), var(--chatbox-background-primary))',
  borderColor: 'color-mix(in srgb, var(--chatbox-border-secondary), transparent 12%)',
}

export const MOBILE_TAP_RESET_STYLE: CSSProperties = {
  WebkitTapHighlightColor: 'transparent',
}
