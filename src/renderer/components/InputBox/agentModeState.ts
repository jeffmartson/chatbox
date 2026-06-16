import type { AgentModeEntry, AgentModeValue } from '@shared/types'
import platform from '@/platform'

export interface AgentModeUIState {
  /**
   * The mode to render in the selector / robot button (off | auto | on), clamped to
   * 'off' when the platform or model can't run agent mode. Display only — never gate
   * behavior on this. In particular, 'auto' is a display state, not an active state.
   */
  displayValue: AgentModeValue
  /**
   * Whether agent-mode capabilities are actually engaged. True only for 'on'.
   * 'auto' stays visible and runs the first-turn suggestion classifier, but
   * generation resolves it to off unless the user accepts the suggestion, so for
   * input gating it behaves exactly like normal (off) mode. Gate all input and
   * capability behavior on this flag (or `capabilitiesDisabled`), not on displayValue.
   */
  isActive: boolean
  /** Inverse of `isActive`, for disabling capability controls (skills, MCP, KB...). */
  capabilitiesDisabled: boolean
  modelUnsupported: boolean
}

export function getAgentModeUIState(entry: AgentModeEntry, modelSupportsAgentMode: boolean): AgentModeUIState {
  const modelUnsupported = !modelSupportsAgentMode
  // Agent mode requires desktop platform (sandbox is not available on mobile/web)
  const platformUnsupported = platform.type !== 'desktop'
  const displayValue: AgentModeValue =
    entry.value === 'off' || modelUnsupported || platformUnsupported ? 'off' : entry.value

  // Capabilities (code execution, skills, MCP, knowledge base, agent-mode file
  // handling) only apply when agent mode is actually on; 'auto' merely allows the
  // suggestion, so it is treated as inactive here.
  const isActive = displayValue === 'on'

  return {
    displayValue,
    isActive,
    capabilitiesDisabled: !isActive,
    modelUnsupported,
  }
}
