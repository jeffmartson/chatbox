import {
  type CSSProperties,
  type MouseEvent,
  memo,
  type UIEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const ITEM_HEIGHT = 12
const BASE_LINE_WIDTH = 10
const MAX_LINE_WIDTH = 32
const HOVER_DISTANCE = 72
const PREVIEW_MARGIN = 28

export type MessageMinimapAnchor = {
  messageId: string
  itemIndex: number
  text: string
}

export type MessageMinimapRailProps = {
  anchors: MessageMinimapAnchor[]
  className?: string
  onJump?: (anchor: MessageMinimapAnchor) => void
}

type HoveredAnchor = {
  anchor: MessageMinimapAnchor
  index: number
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value)
}

function normalizePreviewText(text: string, fallback: string) {
  const previewText = text.replace(/\s+/g, ' ').trim()
  return previewText || fallback
}

const previewTextStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 3,
  overflow: 'hidden',
}

const edgeFadeBlurStyle: CSSProperties = {
  backdropFilter: 'blur(1px)',
}

const MessageMinimapRail = ({ anchors, className, onJump }: MessageMinimapRailProps) => {
  const { t } = useTranslation()
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const contentHeight = anchors.length * ITEM_HEIGHT

  const [pointerContentY, setPointerContentY] = useState<number | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollHeight, setScrollHeight] = useState(0)
  const [hoveredAnchor, setHoveredAnchor] = useState<HoveredAnchor | null>(null)

  const updatePointerPosition = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollArea = event.currentTarget
      const rect = scrollArea.getBoundingClientRect()
      const nextContentOffset = Math.max(0, (scrollArea.clientHeight - anchors.length * ITEM_HEIGHT) / 2)
      const nextPointerContentY = event.clientY - rect.top + scrollArea.scrollTop - nextContentOffset
      const nextIndex = Math.round((nextPointerContentY - ITEM_HEIGHT / 2) / ITEM_HEIGHT)

      setPointerContentY(nextPointerContentY)
      setHoveredAnchor(
        nextPointerContentY >= 0 && nextPointerContentY <= anchors.length * ITEM_HEIGHT && anchors[nextIndex]
          ? { anchor: anchors[nextIndex], index: nextIndex }
          : null
      )
    },
    [anchors]
  )

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    setScrollHeight(event.currentTarget.scrollHeight)
  }, [])

  const handleMouseEnter = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      updatePointerPosition(event)
    },
    [updatePointerPosition]
  )

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      updatePointerPosition(event)
    },
    [updatePointerPosition]
  )

  const handleMouseLeave = useCallback(() => {
    setPointerContentY(null)
    setHoveredAnchor(null)
  }, [])

  const handleAnchorFocus = useCallback((anchor: MessageMinimapAnchor, index: number) => {
    setHoveredAnchor({ anchor, index })
    setPointerContentY(index * ITEM_HEIGHT + ITEM_HEIGHT / 2)
  }, [])

  const handleAnchorBlur = useCallback(() => {
    setHoveredAnchor(null)
    setPointerContentY(null)
  }, [])

  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) {
      return
    }

    const updateViewportHeight = () => {
      setViewportHeight(scrollArea.clientHeight)
      setScrollHeight(scrollArea.scrollHeight)
      setScrollTop(scrollArea.scrollTop)
    }

    updateViewportHeight()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportHeight)
      return () => {
        window.removeEventListener('resize', updateViewportHeight)
      }
    }

    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(scrollArea)

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (contentHeight === 0) {
      return
    }

    const scrollArea = scrollAreaRef.current
    if (!scrollArea) {
      return
    }

    setViewportHeight(scrollArea.clientHeight)
    setScrollHeight(scrollArea.scrollHeight)
    setScrollTop(scrollArea.scrollTop)
  }, [contentHeight])

  if (anchors.length === 0) {
    return null
  }

  const previewFallback = String(t('Attachment message'))
  const hoveredPreviewText = hoveredAnchor ? normalizePreviewText(hoveredAnchor.anchor.text, previewFallback) : ''
  const contentOffset = viewportHeight > contentHeight ? (viewportHeight - contentHeight) / 2 : 0
  const hasScrollableOverflow = scrollHeight > viewportHeight + 1
  const showTopFade = hasScrollableOverflow && scrollTop > 1
  const showBottomFade = hasScrollableOverflow && scrollTop + viewportHeight < scrollHeight - 1
  const hoveredTop =
    hoveredAnchor && viewportHeight > 0
      ? Math.min(
          Math.max(contentOffset + hoveredAnchor.index * ITEM_HEIGHT + ITEM_HEIGHT / 2 - scrollTop, PREVIEW_MARGIN),
          Math.max(PREVIEW_MARGIN, viewportHeight - PREVIEW_MARGIN)
        )
      : PREVIEW_MARGIN

  return (
    <div
      className={cn(
        'pointer-events-none absolute right-4 top-[46%] z-10 h-[42vh] min-h-24 max-h-[360px] w-[72px]',
        '-translate-y-1/2 overflow-visible',
        className
      )}
      data-testid="message-minimap-rail"
    >
      <div
        ref={scrollAreaRef}
        className={cn(
          'pointer-events-auto ml-auto h-full w-12 overflow-y-auto overflow-x-visible py-1',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onScroll={handleScroll}
      >
        <div style={{ height: contentHeight, transform: `translateY(${contentOffset}px)` }}>
          {anchors.map((anchor, index) => {
            const centerY = index * ITEM_HEIGHT + ITEM_HEIGHT / 2
            const rawInfluence =
              pointerContentY === null ? 0 : Math.max(0, 1 - Math.abs(centerY - pointerContentY) / HOVER_DISTANCE)
            const influence = smoothstep(rawInfluence)
            const hovered = hoveredAnchor?.anchor.messageId === anchor.messageId
            const lineWidth = Math.min(MAX_LINE_WIDTH, BASE_LINE_WIDTH + influence * (MAX_LINE_WIDTH - BASE_LINE_WIDTH))
            const opacity = hovered ? 0.95 : 0.3
            const lineColor = hovered ? 'var(--chatbox-tint-primary)' : 'var(--chatbox-tint-tertiary)'
            const previewText = normalizePreviewText(anchor.text, previewFallback)
            const jumpLabel = String(t('Jump to message {{index}}', { index: index + 1 }))

            return (
              <button
                key={anchor.messageId}
                type="button"
                className={cn(
                  'flex h-3 w-12 cursor-default items-center justify-end border-0 bg-transparent p-0 pr-2 outline-none',
                  'focus-visible:ring-1 focus-visible:ring-[var(--chatbox-border-brand)]'
                )}
                aria-label={jumpLabel}
                title={previewText}
                onMouseEnter={() => setHoveredAnchor({ anchor, index })}
                onFocus={() => handleAnchorFocus(anchor, index)}
                onBlur={handleAnchorBlur}
                onClick={() => onJump?.(anchor)}
              >
                <span
                  aria-hidden="true"
                  className="block rounded-full transition-[width,height,opacity,background-color] duration-100 ease-out will-change-[width,opacity]"
                  style={{
                    width: lineWidth,
                    height: hovered ? 2.5 : 2,
                    opacity,
                    backgroundColor: lineColor,
                  }}
                />
              </button>
            )
          })}
        </div>
      </div>

      {showTopFade && (
        <div
          aria-hidden="true"
          data-testid="message-minimap-top-fade"
          className="pointer-events-none absolute right-0 top-0 z-10 h-8 w-12 bg-gradient-to-b from-chatbox-background-primary to-transparent"
          style={edgeFadeBlurStyle}
        />
      )}
      {showBottomFade && (
        <div
          aria-hidden="true"
          data-testid="message-minimap-bottom-fade"
          className="pointer-events-none absolute right-0 bottom-0 z-10 h-8 w-12 bg-gradient-to-t from-chatbox-background-primary to-transparent"
          style={edgeFadeBlurStyle}
        />
      )}

      {hoveredAnchor && (
        <div
          className={cn(
            'pointer-events-none absolute right-12 z-20 w-[360px]',
            'rounded-md border border-solid border-chatbox-border-primary bg-chatbox-background-primary px-3 py-2',
            'shadow-lg'
          )}
          style={{ top: hoveredTop, transform: 'translateY(-50%)', maxWidth: 'min(360px, calc(100vw - 96px))' }}
        >
          <div className="text-sm leading-snug text-chatbox-tint-primary" style={previewTextStyle}>
            {hoveredPreviewText}
          </div>
          <div className="mt-1 text-xs leading-tight text-chatbox-tint-tertiary">
            {t('Message {{index}}', { index: hoveredAnchor.index + 1 })}
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(MessageMinimapRail)
