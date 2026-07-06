import * as Sentry from '@sentry/react'
import { AIProviderNoImplementedPaintError, ApiError, BaseError, NetworkError, OCRError } from '@shared/models/errors'
import { trackEvent } from '@/utils/track'

export type BooleanString = 'true' | 'false'

export type AgentModeEntrySource = 'suggestion_accept' | 'locked_session' | 'manual' | 'none'

export function toBooleanString(value: boolean): BooleanString {
  return value ? 'true' : 'false'
}

export function bucketCount(count: number): '0' | '1' | '2_plus' {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  return '2_plus'
}

export function trackAgentModeSuggested(props: { hasFiles: boolean; fileCount: number }) {
  trackEvent('agent_mode_suggested', {
    has_files: toBooleanString(props.hasFiles),
    file_count: bucketCount(props.fileCount),
  })
}

export function trackAgentModeSuggestionAction(props: {
  action: 'accept' | 'decline'
  hasFiles: boolean
  fileCount: number
}) {
  trackEvent('agent_mode_suggestion_action', {
    action: props.action,
    has_files: toBooleanString(props.hasFiles),
    file_count: bucketCount(props.fileCount),
  })
}

export function trackAgentModePauseAction(props: {
  type: 'approval' | 'tool_limit'
  action: 'approve' | 'deny' | 'continue' | 'stop'
}) {
  trackEvent('agent_mode_pause_action', props)
}

export function trackAgentModeFullAccessBypass(props: { tool: 'user_exec' | 'write_file' | 'edit_file' }) {
  trackEvent('agent_mode_full_access_bypass', props)
}

// Same expected-error set as handleGenerationError: provider/network failures are
// user-environment noise, not defects, and their messages can echo request content.
export function isExpectedGenerationError(error: unknown): boolean {
  return (
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof AIProviderNoImplementedPaintError ||
    (error instanceof OCRError && error.cause instanceof BaseError)
  )
}

function sanitizeProviderTag(provider: string): string {
  return provider.startsWith('custom-provider-') ? 'custom' : provider
}

// MCP tool names embed the user-entered server name (`mcp__<server>__<tool>`); drop it.
function sanitizeToolNameTag(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `mcp__${parts.slice(2).join('__')}`
  }
  return toolName
}

export function captureAgentModeException(
  error: unknown,
  context: {
    operation:
      | 'suggestion'
      | 'suggestion_model'
      | 'generation'
      | 'tool_pause_continue'
      | 'tool_retry'
      | 'full_access_bypass'
    provider?: string
    model?: string
    agentMode?: string
    fullAccess?: boolean
    toolName?: string
    pauseType?: string
    operationType?: string
  }
) {
  if (isExpectedGenerationError(error)) return
  const exception = error instanceof Error ? error : new Error(`${error}`)
  const customProvider = context.provider?.startsWith('custom-provider-') === true
  Sentry.withScope((scope) => {
    scope.setTag('component', 'agent-mode')
    scope.setTag('operation', context.operation)
    if (context.provider) scope.setTag('provider', sanitizeProviderTag(context.provider))
    // Custom-provider model IDs are user-typed free text; skip them.
    if (context.model && !customProvider) scope.setTag('model', context.model)
    if (context.agentMode) scope.setTag('agent_mode', context.agentMode)
    if (context.fullAccess !== undefined) scope.setTag('full_access', toBooleanString(context.fullAccess))
    if (context.toolName) scope.setTag('tool_name', sanitizeToolNameTag(context.toolName))
    if (context.pauseType) scope.setTag('pause_type', context.pauseType)
    if (context.operationType) scope.setTag('operation_type', context.operationType)
    Sentry.captureException(exception)
  })
}
