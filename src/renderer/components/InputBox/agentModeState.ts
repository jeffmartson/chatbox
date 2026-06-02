import type { AgentModeEntry, AgentModeValue } from '@shared/types'
import platform from '@/platform'

export interface AgentModeUIState {
  effectiveValue: AgentModeValue
  capabilitiesDisabled: boolean
  modelUnsupported: boolean
}

export function getAgentModeUIState(entry: AgentModeEntry, modelSupportsAgentMode: boolean): AgentModeUIState {
  const modelUnsupported = !modelSupportsAgentMode
  // Agent mode requires desktop platform (sandbox is not available on mobile/web)
  const platformUnsupported = platform.type !== 'desktop'
  const effectiveValue: AgentModeValue =
    entry.value === 'off' || modelUnsupported || platformUnsupported ? 'off' : entry.value

  return {
    effectiveValue,
    capabilitiesDisabled: effectiveValue === 'off',
    modelUnsupported,
  }
}
