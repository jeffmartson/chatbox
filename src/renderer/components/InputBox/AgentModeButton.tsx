import { Popover, UnstyledButton } from '@mantine/core'
import type { AgentModeValue, KnowledgeBase } from '@shared/types'
import { IconRobot } from '@tabler/icons-react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getSessionAgentMode } from '@/stores/session/utils'
import { useUIStore } from '@/stores/uiStore'
import AgentModePanel from './AgentModePanel'
import { getAgentModeUIState } from './agentModeState'

interface AgentModeButtonProps {
  sessionId: string
  iconSize?: number
  modelSupportsAgentMode?: boolean
  webBrowsingMode: boolean
  onWebBrowsingChange: (enabled: boolean) => void
  currentKnowledgeBaseId?: number
  onKnowledgeBaseSelect: (kb: KnowledgeBase | null) => void
  onSkillSelect: (skillName: string) => void
}

const MODE_COLORS: Record<AgentModeValue, string> = {
  on: 'var(--chatbox-tint-brand)',
  off: 'var(--chatbox-tint-tertiary)',
  auto: 'var(--chatbox-tint-secondary)',
}

const OPEN_DELAY = 100
const CLOSE_DELAY = 100

const AgentModeButton: FC<AgentModeButtonProps> = ({
  sessionId,
  iconSize = 18,
  modelSupportsAgentMode = true,
  webBrowsingMode,
  onWebBrowsingChange,
  currentKnowledgeBaseId,
  onKnowledgeBaseSelect,
  onSkillSelect,
}) => {
  const { t } = useTranslation()
  const sessionAgentModeMap = useUIStore((s) => s.sessionAgentModeMap)
  const [opened, setOpened] = useState(false)
  const openTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const entry = useMemo(() => {
    return sessionAgentModeMap[sessionId] ?? getSessionAgentMode(sessionId)
  }, [sessionAgentModeMap, sessionId])

  const agentModeUIState = useMemo(
    () => getAgentModeUIState(entry, modelSupportsAgentMode),
    [entry, modelSupportsAgentMode]
  )
  const disabled = agentModeUIState.modelUnsupported

  const color = useMemo(() => {
    return MODE_COLORS[agentModeUIState.effectiveValue]
  }, [agentModeUIState.effectiveValue])

  const modeLabel = useMemo(() => {
    switch (agentModeUIState.effectiveValue) {
      case 'on':
        return 'ON'
      case 'off':
        return 'OFF'
      default:
        return t('Auto')
    }
  }, [agentModeUIState.effectiveValue, t])

  // Hover open/close with delays, matching Menu trigger="hover" behavior
  const handleMouseEnter = useCallback(() => {
    clearTimeout(closeTimerRef.current)
    openTimerRef.current = setTimeout(() => setOpened(true), OPEN_DELAY)
  }, [])

  const handleMouseLeave = useCallback(() => {
    clearTimeout(openTimerRef.current)
    closeTimerRef.current = setTimeout(() => setOpened(false), CLOSE_DELAY)
  }, [])

  const handleClose = useCallback(() => {
    setOpened(false)
  }, [])

  useEffect(() => {
    return () => {
      clearTimeout(openTimerRef.current)
      clearTimeout(closeTimerRef.current)
    }
  }, [])

  return (
    <Popover
      position="top-start"
      withArrow
      shadow="md"
      opened={opened}
      onChange={setOpened}
      keepMounted
      transitionProps={{ transition: 'pop', duration: 200 }}
    >
      <Popover.Target>
        <UnstyledButton
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors ${disabled ? '' : 'hover:bg-[var(--chatbox-background-tertiary)]'}`}
          style={{ color, opacity: disabled ? 0.5 : undefined }}
        >
          <IconRobot size={iconSize} strokeWidth={1.8} />
          <span className="text-xs font-medium whitespace-nowrap">{modeLabel}</span>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown
        p={0}
        style={{ overflow: 'visible' }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <AgentModePanel
          sessionId={sessionId}
          modelSupportsAgentMode={modelSupportsAgentMode}
          webBrowsingMode={webBrowsingMode}
          onWebBrowsingChange={onWebBrowsingChange}
          currentKnowledgeBaseId={currentKnowledgeBaseId}
          onKnowledgeBaseSelect={onKnowledgeBaseSelect}
          onSkillSelect={onSkillSelect}
          onClose={handleClose}
        />
      </Popover.Dropdown>
    </Popover>
  )
}

export default AgentModeButton
