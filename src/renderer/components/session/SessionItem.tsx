import { ActionIcon, Flex, Text, Tooltip } from '@mantine/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { SessionMeta } from '@shared/types'
import { IconArchive, IconPinned, IconPinnedFilled } from '@tabler/icons-react'
import clsx from 'clsx'
import { memo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import platform from '@/platform'
import { router } from '@/router'
import { archiveSession, updateSession as updateSessionStore } from '@/stores/chatStore'
import { switchCurrentSession } from '@/stores/sessionActions'
import * as toastActions from '@/stores/toastActions'
import { useUIStore } from '@/stores/uiStore'
import ActionMenu, { type ActionMenuItemProps } from '../ActionMenu'
import { AssistantAvatar } from '../common/Avatar'
import { ScalableIcon } from '../common/ScalableIcon'

const ARCHIVE_TIP_STORAGE_KEY = 'chatbox:lastArchiveSessionTipAt'
const ARCHIVE_TIP_INTERVAL = 24 * 60 * 60 * 1000
const MOBILE_LONG_PRESS_DELAY = 550
const MOBILE_LONG_PRESS_MOVE_TOLERANCE = 10

function triggerLongPressHaptic() {
  if (platform.type === 'mobile') {
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
      navigator.vibrate?.(10)
    })
    return
  }
  navigator.vibrate?.(10)
}

export interface Props {
  session: SessionMeta
  selected: boolean
}

function SessionItem(props: Props) {
  const { session, selected } = props
  const { t } = useTranslation()
  const setShowSidebar = useUIStore((s) => s.setShowSidebar)
  const onClick = () => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false
      return
    }
    switchCurrentSession(session.id)
    if (isSmallScreen) {
      setShowSidebar(false)
    }
  }
  const isSmallScreen = useIsSmallScreen()
  // const smallSize = theme.typography.pxToRem(20)

  const [archiving, setArchiving] = useState(false)
  const [mobileMenuOpened, setMobileMenuOpened] = useState(false)
  const [longPressing, setLongPressing] = useState(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggeredRef = useRef(false)
  const longPressStartPointRef = useRef<{ x: number; y: number } | null>(null)

  const stopItemClick = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }

  const showArchiveTipOncePerDay = () => {
    const now = Date.now()
    const lastTipAt = Number(localStorage.getItem(ARCHIVE_TIP_STORAGE_KEY) || 0)
    if (now - lastTipAt < ARCHIVE_TIP_INTERVAL) {
      return
    }
    localStorage.setItem(ARCHIVE_TIP_STORAGE_KEY, String(now))
    toastActions.add(t('Archived. Manage archived chats in Settings.') || '', 8000, {
      label: t('Manage') || '',
      settingsPath: '/archive',
    })
  }

  const archiveCurrentSession = async () => {
    if (archiving) {
      return
    }
    setArchiving(true)
    try {
      await archiveSession(session.id)
      showArchiveTipOncePerDay()
      if (selected) {
        router.navigate({ to: '/', replace: true })
      }
    } catch (error) {
      console.error('Failed to archive session:', error)
      setArchiving(false)
    }
  }

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartPointRef.current = null
    setLongPressing(false)
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (!isSmallScreen) {
      return
    }
    clearLongPressTimer()
    longPressTriggeredRef.current = false
    longPressStartPointRef.current = { x: event.clientX, y: event.clientY }
    setLongPressing(true)
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true
      setLongPressing(false)
      triggerLongPressHaptic()
      setMobileMenuOpened(true)
    }, MOBILE_LONG_PRESS_DELAY)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (!isSmallScreen || !longPressStartPointRef.current) {
      return
    }
    const deltaX = Math.abs(event.clientX - longPressStartPointRef.current.x)
    const deltaY = Math.abs(event.clientY - longPressStartPointRef.current.y)
    if (deltaX > MOBILE_LONG_PRESS_MOVE_TOLERANCE || deltaY > MOBILE_LONG_PRESS_MOVE_TOLERANCE) {
      clearLongPressTimer()
    }
  }

  const handleContextMenu = (event: MouseEvent) => {
    if (!isSmallScreen) {
      return
    }
    event.preventDefault()
  }

  const handleMobileMenuChange = (opened: boolean) => {
    setMobileMenuOpened(opened)
    if (!opened) {
      clearLongPressTimer()
      longPressTriggeredRef.current = false
    }
  }

  const mobileMenuItems: ActionMenuItemProps[] = [
    {
      text: (session.starred ? t('Unpin') : t('Pin')) || '',
      icon: session.starred ? IconPinnedFilled : IconPinned,
      onClick: () => {
        void updateSessionStore(session.id, { starred: !session.starred })
      },
    },
    {
      text: t('Archive') || '',
      icon: IconArchive,
      disabled: archiving,
      onClick: () => {
        void archiveCurrentSession()
      },
    },
  ]

  const content = (
    <Flex
      align="center"
      className={clsx(
        'cursor-pointer rounded-sm group/session-item',
        'select-none',
        isSmallScreen
          ? longPressing
            ? 'bg-chatbox-background-gray-secondary'
            : ''
          : selected
            ? 'bg-chatbox-background-brand-secondary'
            : 'hover:bg-chatbox-background-gray-secondary'
      )}
      mx="xs"
      px="xs"
      py={10}
      gap={10}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
    >
      <AssistantAvatar
        avatarKey={session.assistantAvatarKey}
        picUrl={session.picUrl}
        sessionType={session.type}
        size="sm"
        type="chat"
        c={selected ? 'chatbox-brand' : 'chatbox-primary'}
      />

      <Text span flex={1} lineClamp={1} c={selected ? 'chatbox-brand' : 'chatbox-primary'}>
        {session.name}
      </Text>

      <Flex gap={2} className={clsx(isSmallScreen ? 'hidden' : '')}>
        <Tooltip label={session.starred ? t('Unpin') : t('Pin')} openDelay={1000} withArrow>
          <ActionIcon
            variant="transparent"
            size={20}
            color={session.starred ? 'chatbox-brand' : 'chatbox-tertiary'}
            className={clsx(isSmallScreen ? '' : 'group-hover/session-item:visible invisible')}
            onPointerDown={stopItemClick}
            onClick={(event) => {
              stopItemClick(event)
              void updateSessionStore(session.id, { starred: !session.starred })
            }}
          >
            {session.starred ? (
              <ScalableIcon icon={IconPinnedFilled} className="text-inherit" size={16} />
            ) : (
              <ScalableIcon icon={IconPinned} className="text-inherit" size={16} />
            )}
          </ActionIcon>
        </Tooltip>

        <Tooltip label={t('Archive')} openDelay={1000} withArrow>
          <ActionIcon
            variant="transparent"
            size={20}
            color="chatbox-tertiary"
            loading={archiving}
            className={clsx(isSmallScreen ? '' : 'group-hover/session-item:visible invisible')}
            onPointerDown={stopItemClick}
            onClick={async (event) => {
              stopItemClick(event)
              if (archiving) {
                return
              }
              await archiveCurrentSession()
            }}
          >
            <ScalableIcon icon={IconArchive} className="text-inherit" size={16} />
          </ActionIcon>
        </Tooltip>
      </Flex>
    </Flex>
  )

  if (!isSmallScreen) {
    return content
  }

  return (
    <ActionMenu
      type="mobile"
      trigger="manual"
      title={session.name}
      items={mobileMenuItems}
      opened={mobileMenuOpened}
      onChange={handleMobileMenuChange}
    >
      {content}
    </ActionMenu>
  )
}

export default memo(SessionItem)
