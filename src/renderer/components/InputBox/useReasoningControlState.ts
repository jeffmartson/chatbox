import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as chatStore from '@/stores/chatStore'
import {
  ModelProviderType,
  type ProviderInfo,
  type ProviderModelInfo,
  type ProviderOptions,
  type SessionSettings,
} from '../../../shared/types'
import { getReasoningProviderOptions, type ReasoningControlLevel } from '../../../shared/utils/reasoning-control'

type SelectedModel = {
  provider: string
  modelId: string
}

interface UseReasoningControlStateOptions {
  currentSessionId?: string
  isNewSession: boolean
  model?: SelectedModel
  providers: ProviderInfo[]
  sessionProviderOptions?: ProviderOptions
}

interface ReasoningControlState {
  effectiveProviderOptions?: ProviderOptions
  isDirty: boolean
  modelInfo: ProviderModelInfo | null | undefined
  reasoningModelInfo: ProviderModelInfo | null
  selectedProviderInfo?: ProviderInfo
  settingsPatch?: Partial<SessionSettings>
  handleReasoningLevelChange: (level: ReasoningControlLevel) => Promise<void>
  markSettingsCommitted: () => void
  waitForPendingPersist: () => Promise<void>
}

const API_STYLE_BY_PROVIDER_TYPE: Partial<Record<ModelProviderType, ProviderModelInfo['apiStyle']>> = {
  [ModelProviderType.Claude]: 'anthropic',
  [ModelProviderType.Gemini]: 'google',
  [ModelProviderType.OpenAIResponses]: 'openai-responses',
  [ModelProviderType.OpenAI]: 'openai',
}

function withProviderApiStyleFallback(modelInfo: ProviderModelInfo, providerType?: string): ProviderModelInfo {
  if (modelInfo.apiStyle) return modelInfo
  const apiStyle = providerType ? API_STYLE_BY_PROVIDER_TYPE[providerType as ModelProviderType] : undefined
  return apiStyle ? { ...modelInfo, apiStyle } : modelInfo
}

function findProviderModelInfo(model: SelectedModel | undefined, providerInfo: ProviderInfo | undefined) {
  if (!model) return null
  const foundModel = (providerInfo?.models || providerInfo?.defaultSettings?.models)?.find(
    (item) => item.modelId === model.modelId
  )
  return foundModel ? withProviderApiStyleFallback(foundModel, providerInfo?.type) : undefined
}

export function useReasoningControlState({
  currentSessionId,
  isNewSession,
  model,
  providers,
  sessionProviderOptions,
}: UseReasoningControlStateOptions): ReasoningControlState {
  const [providerOptionsOverride, setProviderOptionsOverride] = useState<ProviderOptions | undefined>(undefined)
  const [isDirty, setIsDirty] = useState(false)

  const selectedProviderInfo = useMemo(
    () => (model ? providers.find((provider) => provider.id === model.provider) : undefined),
    [providers, model]
  )

  const modelInfo = useMemo(() => findProviderModelInfo(model, selectedProviderInfo), [model, selectedProviderInfo])
  const lastResolvedModelRef = useRef<{
    key: string
    modelInfo: ProviderModelInfo
  } | null>(null)

  const modelKey = model ? `${model.provider}:${model.modelId}` : ''
  const resetKey = `${currentSessionId || 'new'}:${modelKey}`
  const lastResetKeyRef = useRef(resetKey)
  const changeSeqRef = useRef(0)
  const pendingPersistRef = useRef<Promise<void> | null>(null)
  // Holds the latest options until their persist succeeds, so submit can retry a failed write
  const unpersistedOptionsRef = useRef<{ providerOptions: ProviderOptions | undefined } | null>(null)

  useEffect(() => {
    if (lastResetKeyRef.current === resetKey) {
      return
    }
    lastResetKeyRef.current = resetKey
    setProviderOptionsOverride(undefined)
    setIsDirty(false)
    changeSeqRef.current += 1
    pendingPersistRef.current = null
    unpersistedOptionsRef.current = null
  }, [resetKey])

  useEffect(() => {
    if (modelKey && modelInfo) {
      lastResolvedModelRef.current = {
        key: modelKey,
        modelInfo,
      }
    }
  }, [modelKey, modelInfo])

  const reasoningModelInfo = useMemo<ProviderModelInfo | null>(() => {
    if (!model) return null
    if (modelInfo) return modelInfo
    if (lastResolvedModelRef.current?.key === modelKey) {
      return lastResolvedModelRef.current.modelInfo
    }
    return withProviderApiStyleFallback({ modelId: model.modelId }, selectedProviderInfo?.type)
  }, [model, modelInfo, modelKey, selectedProviderInfo?.type])

  const effectiveProviderOptions = isDirty ? providerOptionsOverride : sessionProviderOptions
  // Existing sessions persist level changes directly (see handleReasoningLevelChange);
  // the patch is only needed when the session does not exist yet and will be created on submit.
  const settingsPatch = isNewSession && isDirty ? { providerOptions: effectiveProviderOptions } : undefined

  const persistProviderOptions = useCallback(async (sessionId: string, nextProviderOptions?: ProviderOptions) => {
    await chatStore.updateSession(sessionId, (session) => {
      if (!session) {
        throw new Error('Session not found')
      }
      return {
        ...session,
        settings: {
          ...session.settings,
          providerOptions: nextProviderOptions,
        },
      }
    })
  }, [])

  const handleReasoningLevelChange = useCallback(
    async (level: ReasoningControlLevel) => {
      const nextProviderOptions = getReasoningProviderOptions(
        model?.provider,
        reasoningModelInfo,
        level,
        effectiveProviderOptions
      )
      setProviderOptionsOverride(nextProviderOptions)
      setIsDirty(true)
      if (isNewSession || !currentSessionId) {
        return
      }
      changeSeqRef.current += 1
      const seq = changeSeqRef.current
      unpersistedOptionsRef.current = { providerOptions: nextProviderOptions }
      const persistPromise = persistProviderOptions(currentSessionId, nextProviderOptions).then(() => {
        // Once persisted, the session cache carries the new options; fall back to it
        // unless another change started in the meantime.
        if (changeSeqRef.current === seq) {
          unpersistedOptionsRef.current = null
          setIsDirty(false)
        }
      })
      pendingPersistRef.current = persistPromise
      await persistPromise
    },
    [
      currentSessionId,
      effectiveProviderOptions,
      isNewSession,
      model?.provider,
      persistProviderOptions,
      reasoningModelInfo,
    ]
  )

  // Called before submit so generation reads the new options from session settings.
  // Awaits the in-flight write and retries it once if it failed.
  const waitForPendingPersist = useCallback(async () => {
    if (isNewSession || !currentSessionId) {
      return
    }
    try {
      if (pendingPersistRef.current) {
        await pendingPersistRef.current
      }
    } catch {
      // fall through to the retry below
    }
    const unpersisted = unpersistedOptionsRef.current
    if (unpersisted) {
      const seq = changeSeqRef.current
      await persistProviderOptions(currentSessionId, unpersisted.providerOptions)
      if (changeSeqRef.current === seq) {
        unpersistedOptionsRef.current = null
        setIsDirty(false)
      }
    }
  }, [currentSessionId, isNewSession, persistProviderOptions])

  const markSettingsCommitted = useCallback(() => {
    setIsDirty(false)
  }, [])

  return {
    effectiveProviderOptions,
    isDirty,
    modelInfo,
    reasoningModelInfo,
    selectedProviderInfo,
    settingsPatch,
    handleReasoningLevelChange,
    markSettingsCommitted,
    waitForPendingPersist,
  }
}
