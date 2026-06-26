import { buildContext } from '@shared/context'
import type { ModelInterface, ModelStreamPart } from '@shared/models/types'
import type {
  Message,
  MessageContentParts,
  MessageToolCallPart,
  ModelProvider,
  Session,
  SessionSettings,
} from '@shared/types'
import { getMessageText } from '@shared/utils/message'
import type { ModelMessage, ToolSet } from 'ai'
import { createModel, createModelDependencies } from '@/adapters'
import * as appleAppStore from '@/packages/apple_app_store'
import { estimateTokensFromMessages } from '@/packages/token'
import {
  denyAllPendingApprovals,
  FileMutationApprovalPausedError,
  UserExecApprovalPausedError,
} from '@/packages/user-exec-approval'
import platform from '@/platform'
import { createSandboxProvider } from '@/sandbox'
import storage from '@/storage'
import { StorageKeyGenerator } from '@/storage/StoreStorage'
import * as chatStore from '../chatStore'
import * as settingActions from '../settingActions'
import { settingsStore } from '../settingsStore'
import { uiStore } from '../uiStore'
import { prepareAgentGenerationHarness, refreshSessionAttachmentStatuses } from './agent-harness'
import {
  AGENT_MODE_SUGGESTION_PROMPT,
  type AgentModeSuggestionDecision,
  describeUserMessageForAgentModeDecision,
  getLastUserMessage,
  isFirstUserTurn,
  parseAgentModeSuggestionDecision,
} from './agent-mode-suggestion'
import { createAttachmentResolver } from './attachment-resolver'
import { findMessageLocation } from './forks'
import { modifyMessage, persistStreamingMessage, updateStreamingCache } from './messages'
import { createInitialState, processStreamChunk } from './stream-chunk-processor'
import { buildToolsForSession } from './tools-builder'
import {
  findTargetMessageIndex,
  getSessionAgentMode,
  getSessionWebBrowsing,
  handleGenerationError,
  initializeTargetMessage,
  trackGenerateEvent,
} from './utils'

const MAX_TOOL_CALLS_BEFORE_CONFIRMATION = 25

type ExecutableTool = {
  execute?: (input: unknown, context: { toolCallId?: string; approved?: boolean }) => unknown
}

class ToolCallLimitPausedError extends Error {
  constructor(
    readonly toolCallId: string,
    readonly toolName: string,
    readonly maxToolCalls: number
  ) {
    super(`Tool call limit reached before executing ${toolName}`)
    this.name = 'ToolCallLimitPausedError'
  }
}

function isToolCallLimitPausedError(error: unknown): error is ToolCallLimitPausedError {
  return (
    error instanceof ToolCallLimitPausedError ||
    Boolean(
      error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'ToolCallLimitPausedError' &&
        'toolCallId' in error &&
        typeof error.toolCallId === 'string' &&
        'maxToolCalls' in error &&
        typeof error.maxToolCalls === 'number'
    )
  )
}

function isUserExecApprovalPausedError(error: unknown): error is UserExecApprovalPausedError {
  return (
    error instanceof UserExecApprovalPausedError ||
    Boolean(
      error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'UserExecApprovalPausedError' &&
        'toolCallId' in error &&
        typeof error.toolCallId === 'string' &&
        'command' in error &&
        typeof error.command === 'string'
    )
  )
}

function isFileMutationApprovalPausedError(error: unknown): error is FileMutationApprovalPausedError {
  return (
    error instanceof FileMutationApprovalPausedError ||
    Boolean(
      error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'FileMutationApprovalPausedError' &&
        'toolCallId' in error &&
        typeof error.toolCallId === 'string' &&
        'title' in error &&
        typeof error.title === 'string' &&
        'preview' in error &&
        typeof error.preview === 'string'
    )
  )
}

function getToolCallPause(error: unknown): {
  toolCallId: string
  pauseReason: MessageToolCallPart['pauseReason']
} | null {
  if (isToolCallLimitPausedError(error)) {
    return {
      toolCallId: error.toolCallId,
      pauseReason: { type: 'tool_call_limit', maxToolCalls: error.maxToolCalls },
    }
  }
  if (isUserExecApprovalPausedError(error)) {
    return {
      toolCallId: error.toolCallId,
      pauseReason: {
        type: 'user_exec_approval',
        command: error.command,
        explanation: error.explanation,
        explanationError: error.explanationError,
      },
    }
  }
  if (isFileMutationApprovalPausedError(error)) {
    return {
      toolCallId: error.toolCallId,
      pauseReason: { type: 'file_mutation_approval', title: error.title, preview: error.preview },
    }
  }
  return null
}

async function shouldSuggestAgentMode(options: {
  sessionId: string
  model: ModelInterface
  userMessage: Message
  signal: AbortSignal
  providerOptions?: SessionSettings['providerOptions']
}): Promise<AgentModeSuggestionDecision> {
  const { sessionId, model, userMessage, signal, providerOptions } = options
  const userPrompt = describeUserMessageForAgentModeDecision(userMessage)
  const promptMessages: ModelMessage[] = model.isSupportSystemMessage()
    ? [
        { role: 'system', content: AGENT_MODE_SUGGESTION_PROMPT },
        { role: 'user', content: userPrompt },
      ]
    : [
        {
          role: 'user',
          content: `${AGENT_MODE_SUGGESTION_PROMPT}\n\n${userPrompt}`,
        },
      ]

  try {
    const result = await model.chat(promptMessages, {
      sessionId,
      signal,
      providerOptions,
    })
    const text = getMessageText({ id: 'agent-mode-decision', role: 'assistant', contentParts: result.contentParts })
    return parseAgentModeSuggestionDecision(text) ?? { suggest: false }
  } catch (error) {
    console.warn('Agent mode suggestion decision failed:', error)
    return { suggest: false }
  }
}

/**
 * Resolve the model used to classify whether Agent Mode should be suggested.
 * Prefer the user-configured fast model (threadNamingModel) to keep this
 * pre-flight classification cheap; fall back to the conversation model when it
 * is not configured or cannot be created.
 */
async function createAgentModeSuggestionModel(
  settings: SessionSettings,
  namingModel: { provider: string; model: string } | undefined | null,
  dependencies: Awaited<ReturnType<typeof createModelDependencies>>,
  fallbackModel: ModelInterface
): Promise<ModelInterface> {
  if (!namingModel) return fallbackModel
  try {
    return await createModel(
      { ...settings, provider: namingModel.provider as ModelProvider, modelId: namingModel.model },
      dependencies
    )
  } catch (error) {
    console.warn('Failed to create fast model for agent mode suggestion, falling back to current model:', error)
    return fallbackModel
  }
}

function withToolCallLimitPause(tools: ToolSet, maxToolCalls: number): ToolSet {
  let toolCallsSinceConfirmation = 0
  const wrappedTools: Record<string, unknown> = {}

  for (const [toolName, toolValue] of Object.entries(tools as Record<string, unknown>)) {
    if (!toolValue || typeof toolValue !== 'object') {
      wrappedTools[toolName] = toolValue
      continue
    }

    const executableTool = toolValue as ExecutableTool
    if (typeof executableTool.execute !== 'function') {
      wrappedTools[toolName] = toolValue
      continue
    }

    const originalExecute = executableTool.execute
    wrappedTools[toolName] = {
      ...toolValue,
      execute: (input: unknown, context: { toolCallId?: string; approved?: boolean }) => {
        if (toolCallsSinceConfirmation >= maxToolCalls) {
          const toolCallId = context.toolCallId
          if (!toolCallId) {
            return { error: `Tool call limit reached (${maxToolCalls}). Please continue manually.` }
          }
          throw new ToolCallLimitPausedError(toolCallId, toolName, maxToolCalls)
        }

        toolCallsSinceConfirmation += 1
        return originalExecute(input, context)
      },
    }
  }

  return wrappedTools as ToolSet
}

function markToolCallPaused(
  contentParts: MessageContentParts,
  toolCallId: string,
  pauseReason: MessageToolCallPart['pauseReason']
): MessageContentParts {
  return contentParts.map((part) => {
    if (part.type !== 'tool-call' || part.toolCallId !== toolCallId) return part
    return {
      ...part,
      state: 'paused',
      pauseReason,
    } satisfies MessageToolCallPart
  })
}

function updateToolCallPart(
  message: Message,
  toolCallId: string,
  updater: (part: MessageToolCallPart) => MessageToolCallPart
): Message {
  return {
    ...message,
    contentParts: message.contentParts.map((part) => {
      if (part.type !== 'tool-call' || part.toolCallId !== toolCallId) return part
      return updater(part as MessageToolCallPart)
    }),
  }
}

function findToolCallPart(message: Message, toolCallId: string): MessageToolCallPart | undefined {
  return message.contentParts.find(
    (part): part is MessageToolCallPart => part.type === 'tool-call' && part.toolCallId === toolCallId
  )
}

function findLastRetryableToolCallPart(message: Message): MessageToolCallPart | undefined {
  for (let index = message.contentParts.length - 1; index >= 0; index -= 1) {
    const part = message.contentParts[index]
    if (part.type === 'tool-call') {
      const toolCallPart = part as MessageToolCallPart
      if (isRetryableToolCallStep(toolCallPart)) {
        return toolCallPart
      }
    }
  }
  return undefined
}

function isRetryableToolCallStep(part: MessageToolCallPart): boolean {
  return part.state === 'result' || part.state === 'error'
}

function keepContentPartsThroughToolCall(message: Message, toolCallId: string): MessageContentParts {
  const index = message.contentParts.findIndex((part) => part.type === 'tool-call' && part.toolCallId === toolCallId)
  return index >= 0 ? message.contentParts.slice(0, index + 1) : message.contentParts
}

export function shouldPersistStreamingChunk(
  chunkType: ModelStreamPart<ToolSet>['type'],
  elapsedMs: number,
  persistInterval: number
) {
  // Tool calls can block the stream for a long time (for example while waiting
  // on user_exec approval), so persist them immediately instead of relying on
  // the periodic 2s flush.
  return chunkType === 'tool-call' || elapsedMs >= persistInterval
}

export async function orchestrateGeneration(
  sessionId: string,
  targetMsg: Message,
  options?: {
    operationType?: 'send_message' | 'regenerate'
    appendToMessage?: boolean
    skipAgentModeSuggestion?: boolean
  }
) {
  const session = await chatStore.getSession(sessionId)
  const settings = await chatStore.getSessionSettings(sessionId)
  const globalSettings = settingsStore.getState().getSettings()
  const configs = await platform.getConfig()

  if (!session || !settings) {
    return
  }

  trackGenerateEvent(sessionId, settings, globalSettings, session.type, options)

  const startTime = Date.now()
  let firstTokenLatency: number | undefined
  const persistInterval = 2000
  let lastPersistTimestamp = Date.now()

  targetMsg = await initializeTargetMessage(targetMsg, settings, globalSettings, session.type)

  await persistStreamingMessage(sessionId, targetMsg)

  const found = findTargetMessageIndex(session, targetMsg.id)
  if (!found) return
  const { messages, index: targetMsgIx } = found
  const promptTargetMsgIx = options?.appendToMessage ? targetMsgIx + 1 : targetMsgIx

  const controller = new AbortController()
  // Wire the stop button to this controller before any pre-stream network work
  // runs (agent-mode suggestion classifier, MCP/tool harness setup). Those steps
  // issue real requests that can hang; without a cancel handler in the message
  // cache the stop button would be a no-op until the main stream starts.
  targetMsg = { ...targetMsg, cancel: () => controller.abort() }
  updateStreamingCache(sessionId, targetMsg)
  let processorState = createInitialState()
  const infoParts: MessageContentParts = []
  let promptMsgs: Message[] = []

  try {
    const dependencies = await createModelDependencies()
    const model = await createModel(settings, dependencies)
    const sessionKnowledgeBaseMap = uiStore.getState().sessionKnowledgeBaseMap
    const knowledgeBase = sessionKnowledgeBaseMap[sessionId]
    const webBrowsing = getSessionWebBrowsing(sessionId, settings.provider)
    const agentModeSupported = platform.type === 'desktop'
    const { value: storedAgentModeValue } = getSessionAgentMode(sessionId)
    const agentModeValue = agentModeSupported ? storedAgentModeValue : 'off'
    const agentModeEntry = uiStore.getState().sessionAgentModeMap[sessionId]
    const lastUserMessage = getLastUserMessage(messages, promptTargetMsgIx)

    if (
      options?.operationType === 'send_message' &&
      !options?.appendToMessage &&
      !options.skipAgentModeSuggestion &&
      agentModeSupported &&
      // Only 'auto' runs the suggestion classifier; 'on' is already enabled and
      // 'off' opts out of suggestions entirely.
      agentModeValue === 'auto' &&
      model.isSupportToolUse('agent') &&
      lastUserMessage &&
      isFirstUserTurn(messages, promptTargetMsgIx)
    ) {
      const suggestionModel = await createAgentModeSuggestionModel(
        settings,
        globalSettings.threadNamingModel,
        dependencies,
        model
      )
      const decision = await shouldSuggestAgentMode({
        sessionId,
        model: suggestionModel,
        userMessage: lastUserMessage,
        signal: controller.signal,
        providerOptions: settings.providerOptions,
      })

      // If the user cancelled while the classifier was running, finalize the
      // message as stopped instead of falling through into a generation with an
      // already-aborted controller. shouldSuggestAgentMode() swallows the abort
      // and returns normally, so this won't reach the catch block below.
      if (controller.signal.aborted) {
        targetMsg = { ...targetMsg, generating: false, cancel: undefined, status: [] }
        await persistStreamingMessage(sessionId, targetMsg, { refreshCounting: true })
        return
      }

      if (decision.suggest) {
        targetMsg = {
          ...targetMsg,
          generating: false,
          cancel: undefined,
          contentParts: [
            {
              type: 'agent-mode-suggestion',
              reason: decision.reason,
            },
          ],
          status: [],
          finishReason: 'agent-mode-suggested',
        }
        await persistStreamingMessage(sessionId, targetMsg, { refreshCounting: true })
        return
      }

      uiStore.getState().setSessionAgentMode(sessionId, 'off')
    }

    const prepared = await prepareAgentGenerationHarness({
      session,
      settings,
      globalSettings,
      configs,
      messages,
      targetMsgIx: promptTargetMsgIx,
      model,
      dependencies,
      knowledgeBase,
      webBrowsing,
      agentModeValue,
      agentModeLocked: Boolean(agentModeEntry?.locked),
      agentModeSupported,
      signal: controller.signal,
      providerOptions: settings.providerOptions,
      preserveLastPromptMessageToolCalls: Boolean(options?.appendToMessage),
      isPro: settingActions.isPro,
      sideEffects: {
        lockAgentMode: (reason) => {
          uiStore.getState().lockSessionAgentMode(sessionId, reason)
        },
      },
    })
    promptMsgs = prepared.promptMsgs
    if (!options?.appendToMessage) {
      infoParts.push(...prepared.infoParts)
    }
    const { coreMessages, tools, fallbackToolCallPart } = prepared

    const chatOptions = { ...prepared.chatOptions }

    if (Object.keys(tools).length > 0) {
      chatOptions.tools = withToolCallLimitPause(tools as ToolSet, MAX_TOOL_CALLS_BEFORE_CONFIRMATION)
    }

    const stream = model.chatStream(coreMessages, chatOptions) as AsyncGenerator<ModelStreamPart<ToolSet>>

    processorState = createInitialState(
      options?.appendToMessage ? targetMsg.contentParts : fallbackToolCallPart ? [fallbackToolCallPart] : undefined
    )

    const streamCallbacks = {
      onFileReceived: async (mediaType: string, base64: string) => {
        const storageKey = StorageKeyGenerator.picture(`${session.id}:${targetMsg.id}`)
        await storage.setBlob(storageKey, `data:${mediaType};base64,${base64}`)
        return storageKey
      },
      onLargeToolResult: async (toolCallId: string, serialized: string) => {
        const storageKey = `tool-result:${session.id}:${toolCallId}`
        await storage.setBlob(storageKey, serialized)
        return storageKey
      },
    }

    for await (const chunk of stream) {
      const result = await processStreamChunk(chunk, processorState, streamCallbacks)
      processorState = result.state

      if (result.skipUpdate) {
        if (result.statusChunk && result.statusChunk.type === 'status') {
          targetMsg = {
            ...targetMsg,
            status: result.statusChunk.status ? [result.statusChunk.status] : [],
          }
          updateStreamingCache(sessionId, targetMsg)
        }
        continue
      }

      const nextMsg: Message = {
        ...targetMsg,
        contentParts: [...infoParts, ...processorState.contentParts],
      }

      const textLength = getMessageText(nextMsg, true, true).length
      if (!firstTokenLatency && textLength > 0) {
        firstTokenLatency = Date.now() - startTime
      }

      targetMsg = {
        ...nextMsg,
        status: textLength > 0 ? [] : nextMsg.status,
        firstTokenLatency,
      }

      const shouldPersist = shouldPersistStreamingChunk(chunk.type, Date.now() - lastPersistTimestamp, persistInterval)
      if (shouldPersist) {
        void persistStreamingMessage(sessionId, targetMsg)
      } else {
        updateStreamingCache(sessionId, targetMsg)
      }
      if (shouldPersist) {
        lastPersistTimestamp = Date.now()
      }
    }

    for (const part of processorState.contentParts) {
      if (part.type === 'reasoning' && part.startTime && !part.duration) {
        part.duration = Date.now() - part.startTime
      }
      if (
        part.type === 'tool-call' &&
        part.startTime &&
        !part.duration &&
        (part.state === 'result' || part.state === 'error')
      ) {
        part.duration = Date.now() - part.startTime
      }
    }

    targetMsg = {
      ...targetMsg,
      generating: false,
      cancel: undefined,
      contentParts: [...infoParts, ...processorState.contentParts],
      tokensUsed: targetMsg.tokensUsed ?? estimateTokensFromMessages([...promptMsgs, targetMsg]),
      status: [],
      finishReason: processorState.finishReason,
      usage: processorState.usage,
      generationDuration: Date.now() - startTime,
    }

    await persistStreamingMessage(sessionId, targetMsg, { refreshCounting: true })
    appleAppStore.tickAfterMessageGenerated()
    // Defensive: deny any approvals that are still pending after normal completion
    denyAllPendingApprovals()
  } catch (err: unknown) {
    const pause = getToolCallPause(err)
    if (pause) {
      denyAllPendingApprovals()
      targetMsg = {
        ...targetMsg,
        generating: false,
        cancel: undefined,
        contentParts: [
          ...infoParts,
          ...markToolCallPaused(processorState.contentParts, pause.toolCallId, pause.pauseReason),
        ],
        tokensUsed: targetMsg.tokensUsed ?? estimateTokensFromMessages([...promptMsgs, targetMsg]),
        status: [],
        finishReason: 'tool-call-paused',
        usage: processorState.usage,
      }
      await persistStreamingMessage(sessionId, targetMsg, { refreshCounting: true })
      return
    }

    if (controller.signal.aborted) {
      denyAllPendingApprovals()
      targetMsg = {
        ...targetMsg,
        generating: false,
        cancel: undefined,
        status: [],
      }
      await persistStreamingMessage(sessionId, targetMsg, { refreshCounting: true })
      return
    }

    denyAllPendingApprovals()
    targetMsg = handleGenerationError(err, targetMsg, settings)
    await persistStreamingMessage(sessionId, targetMsg, { refreshCounting: true })
  }
}

async function buildToolsForPausedToolCall(session: Session, settings: SessionSettings, targetMsg: Message) {
  const dependencies = await createModelDependencies()
  const model = await createModel(settings, dependencies)
  const location = findTargetMessageIndex(session, targetMsg.id)
  const messagesBeforeTarget = location ? location.messages.slice(0, location.index) : session.messages
  const agentModeSupported = platform.type === 'desktop'
  const { value: storedAgentModeValue } = getSessionAgentMode(session.id)
  const agentModeValue = agentModeSupported ? storedAgentModeValue : 'off'
  const effectiveAgentMode = agentModeSupported && agentModeValue === 'on' ? 'on' : 'off'

  const sandboxProvider = effectiveAgentMode !== 'off' ? createSandboxProvider() : null
  // Mirror the main generation path: grant the sandbox the user's bound working directories
  // so a resumed write into them succeeds (allowWrite) instead of failing under confinement.
  const userWorkingDirectories = settings.workingDirectories?.filter((dir) => dir.trim().length > 0) ?? []
  if (sandboxProvider && userWorkingDirectories.length > 0) {
    sandboxProvider.setExtraWritableDirs(userWorkingDirectories)
  }
  let canExecuteCode = Boolean(sandboxProvider && model.isSupportToolUse('agent'))
  if (canExecuteCode && sandboxProvider?.type === 'cloud' && !settingActions.isPro()) {
    canExecuteCode = false
  }
  if (canExecuteCode && sandboxProvider) {
    const availability = await sandboxProvider.checkAvailability()
    if (!availability.available) {
      canExecuteCode = false
    }
  }

  const attachmentResolver = createAttachmentResolver()
  const messagesForPrompt = await refreshSessionAttachmentStatuses(messagesBeforeTarget)
  const promptMsgs = await buildContext(messagesForPrompt, {
    attachmentResolver,
    compactionPoints: session.compactionPoints,
    modelSupportToolUseForFile: model.isSupportToolUse('read-file'),
    maxContextMessageCount: settings.maxContextMessageCount,
    sandboxMode: canExecuteCode,
  })

  const sessionKnowledgeBaseMap = uiStore.getState().sessionKnowledgeBaseMap
  const knowledgeBase = sessionKnowledgeBaseMap[session.id]
  const webBrowsing = getSessionWebBrowsing(session.id, settings.provider)
  const codeExecutionOption =
    canExecuteCode && sandboxProvider
      ? {
          sessionId: session.id,
          provider: sandboxProvider,
          files: messagesBeforeTarget.flatMap(
            (message) =>
              message.files?.map((file) => ({
                storageKey: file.storageKey || '',
                rawStorageKey: file.rawStorageKey,
                name: file.name,
              })) || []
          ),
        }
      : undefined

  const { tools } = await buildToolsForSession(model, {
    webBrowsing,
    knowledgeBase,
    messages: promptMsgs,
    agentMode: effectiveAgentMode,
    sessionSettings: settings,
    codeExecution: codeExecutionOption,
    onAgentModeActivated: () => {
      uiStore.getState().lockSessionAgentMode(session.id, 'load_skill')
    },
  })

  return { tools }
}

export async function stopPausedToolCall(sessionId: string, messageId: string, toolCallId: string) {
  const session = await chatStore.getSession(sessionId)
  if (!session) return
  const location = findMessageLocation(session, messageId)
  const message = location ? location.list[location.index] : undefined
  if (!message) return
  const part = findToolCallPart(message, toolCallId)
  if (!part || part.state !== 'paused') return

  if (part.pauseReason?.type === 'user_exec_approval' || part.pauseReason?.type === 'file_mutation_approval') {
    const deniedResult =
      part.pauseReason.type === 'user_exec_approval'
        ? { success: false, exitCode: null, stdout: '', stderr: 'Command denied by user.' }
        : { success: false, error: 'File mutation denied by user.' }
    const nextMessage = updateToolCallPart(message, toolCallId, (toolPart) => ({
      ...toolPart,
      state: 'result',
      pauseReason: undefined,
      result: deniedResult,
      // Denied without executing — no meaningful duration to report.
      startTime: undefined,
      duration: undefined,
    }))
    await modifyMessage(sessionId, nextMessage, true)
    await orchestrateGeneration(
      sessionId,
      { ...nextMessage, generating: true },
      { operationType: 'regenerate', appendToMessage: true }
    )
    return
  }

  await modifyMessage(
    sessionId,
    updateToolCallPart(message, toolCallId, (toolPart) => ({
      ...toolPart,
      state: 'error',
      pauseReason: undefined,
      result: { error: 'Tool execution stopped by user.' },
    })),
    true
  )
}

export async function continuePausedToolCall(sessionId: string, messageId: string, toolCallId: string) {
  const session = await chatStore.getSession(sessionId)
  const settings = await chatStore.getSessionSettings(sessionId)
  if (!session || !settings) return

  const location = findMessageLocation(session, messageId)
  let message = location ? location.list[location.index] : undefined
  if (!message) return
  const part = findToolCallPart(message, toolCallId)
  if (!part || part.state !== 'paused') return

  message = updateToolCallPart(message, toolCallId, (toolPart) => ({
    ...toolPart,
    state: 'call',
    pauseReason: undefined,
    result: undefined,
    resultStorageKey: undefined,
    // Restart the timer at continuation so the reported duration excludes the
    // time spent waiting for user approval / manual continuation.
    startTime: Date.now(),
    duration: undefined,
  }))
  await modifyMessage(sessionId, message, false)

  try {
    const { tools } = await buildToolsForPausedToolCall(session, settings, message)
    const toolValue = (tools as Record<string, unknown>)[part.toolName]
    const executableTool = toolValue && typeof toolValue === 'object' ? (toolValue as ExecutableTool) : undefined
    if (typeof executableTool?.execute !== 'function') {
      throw new Error(`Tool "${part.toolName}" is not available`)
    }

    const result = await executableTool.execute(part.args, { toolCallId, approved: true })
    message = updateToolCallPart(message, toolCallId, (toolPart) => ({
      ...toolPart,
      state: 'result',
      result,
      duration: toolPart.startTime ? Date.now() - toolPart.startTime : undefined,
    }))
    await modifyMessage(sessionId, message, true)

    await orchestrateGeneration(
      sessionId,
      { ...message, generating: true },
      { operationType: 'regenerate', appendToMessage: true }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await modifyMessage(
      sessionId,
      updateToolCallPart(message, toolCallId, (toolPart) => ({
        ...toolPart,
        state: 'error',
        result: { error: errorMessage },
      })),
      true
    )
  }
}

export async function retryFromLastToolCallAfterApiError(sessionId: string, messageId: string, toolCallId: string) {
  const session = await chatStore.getSession(sessionId)
  if (!session) return

  const location = findMessageLocation(session, messageId)
  const message = location ? location.list[location.index] : undefined
  if (!message) return
  const part = findToolCallPart(message, toolCallId)
  const lastRetryableToolCall = findLastRetryableToolCallPart(message)
  if (!part || !isRetryableToolCallStep(part) || !message.error || lastRetryableToolCall?.toolCallId !== toolCallId) {
    return
  }

  const retrySourceMessage: Message = {
    ...message,
    generating: false,
    error: undefined,
    errorCode: undefined,
    errorExtra: undefined,
    contentParts: keepContentPartsThroughToolCall(message, toolCallId),
  }

  await modifyMessage(sessionId, retrySourceMessage, true)
  await orchestrateGeneration(
    sessionId,
    { ...retrySourceMessage, generating: true },
    { operationType: 'regenerate', appendToMessage: true }
  )
}
