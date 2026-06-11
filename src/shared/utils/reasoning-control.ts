import type { ModelProvider, ProviderModelInfo, ProviderOptions } from '../types'
import { ModelProviderEnum } from '../types'
import { type GoogleThinkingLevel, getGoogleThinkingMode, getSupportedGoogleThinkingLevels } from './google-thinking'

export type ReasoningControlLevel = 'off' | 'low' | 'medium' | 'high'

export interface ReasoningControlCapabilities {
  supported: boolean
  kind:
    | 'anthropic-adaptive-effort'
    | 'anthropic-effort'
    | 'budget'
    | 'level'
    | 'openai-effort'
    | 'openrouter-reasoning'
    | 'toggle'
    | 'xai-effort'
  disabledReason?: string
}

export interface ReasoningControlOption {
  level: ReasoningControlLevel
  label: 'off' | 'on' | 'low' | 'medium' | 'high'
}

const DEFAULT_CAPABILITIES: ReasoningControlCapabilities = {
  supported: false,
  kind: 'toggle',
}

const CLAUDE_BUDGET_BY_LEVEL: Record<Exclude<ReasoningControlLevel, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
}

const GEMINI_BUDGET_BY_LEVEL: Record<Exclude<ReasoningControlLevel, 'off'>, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
}

const QWEN_THINKING_BUDGET_BY_LEVEL: Record<Exclude<ReasoningControlLevel, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
}

const GPT_EFFORT_MODELS = [/(?:^|\/)gpt-5(?:[.-]|$)/i, /(?:^|\/)gpt-oss(?:[.-]|$)/i]
const OPENAI_NONE_EFFORT_MODELS = [/(?:^|\/)gpt-5\.(?:1|2|5)(?:[.-]|$)/i]
const CLAUDE_EFFORT_MODELS = [/(?:^|\/)claude-opus-4-5/i]
const CLAUDE_ADAPTIVE_EFFORT_MODELS = [/(?:^|\/)claude-opus-4-(?:7|8)/i]
const CLAUDE_BUDGET_MODELS = [
  /(?:^|\/)claude-3-7-sonnet/i,
  /(?:^|\/)claude-sonnet-4/i,
  /(?:^|\/)claude-haiku-4-5/i,
  /(?:^|\/)claude-opus-4(?![.-]?5)(?![.-]?7)(?![.-]?8)/i,
]
const DEEPSEEK_THINKING_MODELS = [/deepseek-reasoner/i, /deepseek-r1/i, /deepseek-v[0-9.]+(?:-thinking|-pro|-flash)?/i]
const QWEN_THINKING_MODELS = [/^qwen3/i, /(?:^|\/)qwen3/i]
const GROK_REASONING_EFFORT_MODELS = [
  /(?:^|\/)grok-4\.3(?:-latest)?$/i,
  /(?:^|\/)grok-4(?:-latest|-0709)?$/i,
  /(?:^|\/)grok-4-fast(?:-reasoning)?(?:-latest)?$/i,
  /(?:^|\/)grok-4-1-fast(?:-reasoning)?(?:-latest)?$/i,
]

function matchesAny(modelId: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(modelId))
}

function getEffectiveProvider(
  provider: ModelProvider | undefined,
  model?: ProviderModelInfo | null
): ModelProvider | undefined {
  if (!model?.apiStyle || !usesModelApiStyleForReasoning(provider)) {
    return provider
  }

  if (provider === ModelProviderEnum.OpenRouter) {
    return provider
  }

  if (model.apiStyle === 'anthropic') return ModelProviderEnum.Claude
  if (model.apiStyle === 'google') return ModelProviderEnum.Gemini
  if (model.apiStyle === 'openai-responses') return ModelProviderEnum.OpenAIResponses
  return ModelProviderEnum.OpenAI
}

function usesModelApiStyleForReasoning(provider: ModelProvider | undefined): boolean {
  return provider === ModelProviderEnum.ChatboxAI || provider === ModelProviderEnum.Custom
}

function isOpenAICompatibleApiStyle(provider: ModelProvider | undefined, model: ProviderModelInfo): boolean {
  return provider === ModelProviderEnum.ChatboxAI && (!model.apiStyle || model.apiStyle === 'openai')
}

export function getReasoningControlCapabilities(
  provider: ModelProvider | undefined,
  model?: ProviderModelInfo | null
): ReasoningControlCapabilities {
  const modelId = model?.modelId
  if (!provider || !modelId) {
    return DEFAULT_CAPABILITIES
  }

  const effectiveProvider = getEffectiveProvider(provider, model)
  const disabledReason = getApiStyleDisabledReason(provider, effectiveProvider, model)
  if (disabledReason) {
    return { supported: false, kind: 'toggle', disabledReason }
  }

  if (effectiveProvider === ModelProviderEnum.Claude && matchesAny(modelId, CLAUDE_ADAPTIVE_EFFORT_MODELS)) {
    return { supported: true, kind: 'anthropic-adaptive-effort' }
  }
  if (effectiveProvider === ModelProviderEnum.Claude && matchesAny(modelId, CLAUDE_EFFORT_MODELS)) {
    return { supported: true, kind: 'anthropic-effort' }
  }
  if (effectiveProvider === ModelProviderEnum.Claude && matchesAny(modelId, CLAUDE_BUDGET_MODELS)) {
    return { supported: true, kind: 'budget' }
  }
  if (effectiveProvider === ModelProviderEnum.Gemini) {
    const mode = getGoogleThinkingMode(modelId)
    if (mode === 'budget') return { supported: true, kind: 'budget' }
    if (mode === 'level') return { supported: true, kind: 'level' }
  }
  if (effectiveProvider === ModelProviderEnum.DeepSeek && isDeepSeekReasoningModel(model)) {
    return { supported: true, kind: 'toggle' }
  }
  if (model && isOpenAICompatibleApiStyle(provider, model) && isDeepSeekReasoningModel(model)) {
    return { supported: true, kind: 'toggle' }
  }
  if (
    (effectiveProvider === ModelProviderEnum.OpenAI ||
      effectiveProvider === ModelProviderEnum.OpenAIResponses ||
      effectiveProvider === ModelProviderEnum.Azure) &&
    matchesAny(modelId, GPT_EFFORT_MODELS)
  ) {
    return { supported: true, kind: 'openai-effort' }
  }
  if (
    (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) &&
    matchesAny(modelId, QWEN_THINKING_MODELS)
  ) {
    return { supported: true, kind: 'budget' }
  }
  if (effectiveProvider === ModelProviderEnum.XAI && matchesAny(modelId, GROK_REASONING_EFFORT_MODELS)) {
    return { supported: true, kind: 'xai-effort' }
  }
  if (effectiveProvider === ModelProviderEnum.OpenRouter && isOpenRouterReasoningModel(model)) {
    return { supported: true, kind: 'openrouter-reasoning' }
  }

  return DEFAULT_CAPABILITIES
}

function getApiStyleDisabledReason(
  provider: ModelProvider | undefined,
  effectiveProvider: ModelProvider | undefined,
  model: ProviderModelInfo
): string | undefined {
  if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    return undefined
  }

  const modelId = model.modelId
  if (matchesAny(modelId, [...CLAUDE_ADAPTIVE_EFFORT_MODELS, ...CLAUDE_EFFORT_MODELS, ...CLAUDE_BUDGET_MODELS])) {
    if (effectiveProvider !== ModelProviderEnum.Claude) {
      return 'Thinking controls are disabled because this Claude model is not exposed through the Anthropic API style.'
    }
  }

  if (getGoogleThinkingMode(modelId) !== 'none') {
    if (effectiveProvider !== ModelProviderEnum.Gemini) {
      return 'Thinking controls are disabled because this Gemini model is not exposed through the Google API style.'
    }
  }

  if (matchesAny(modelId, GPT_EFFORT_MODELS)) {
    const isOpenAIStyle =
      effectiveProvider === ModelProviderEnum.OpenAI ||
      effectiveProvider === ModelProviderEnum.OpenAIResponses ||
      effectiveProvider === ModelProviderEnum.Azure
    if (!isOpenAIStyle) {
      return 'Thinking controls are disabled because this GPT model is not exposed through an OpenAI API style.'
    }
  }

  if (
    matchesAny(modelId, DEEPSEEK_THINKING_MODELS) &&
    effectiveProvider !== ModelProviderEnum.DeepSeek &&
    !isOpenAICompatibleApiStyle(provider, model)
  ) {
    return 'Thinking controls are disabled because this DeepSeek model is not exposed through the DeepSeek API style.'
  }

  if (
    matchesAny(modelId, QWEN_THINKING_MODELS) &&
    effectiveProvider !== ModelProviderEnum.Qwen &&
    effectiveProvider !== ModelProviderEnum.QwenPortal
  ) {
    return 'Thinking controls are disabled because this Qwen model is not exposed through the Qwen API style.'
  }

  if (matchesAny(modelId, GROK_REASONING_EFFORT_MODELS) && effectiveProvider !== ModelProviderEnum.XAI) {
    return 'Thinking controls are disabled because this Grok model is not exposed through the xAI API style.'
  }

  return undefined
}

export function getReasoningControlLevel(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  providerOptions?: ProviderOptions
): ReasoningControlLevel {
  const capabilities = getReasoningControlCapabilities(provider, model)
  if (!capabilities.supported) return 'off'

  const effectiveProvider = getEffectiveProvider(provider, model)
  if (model && isOpenAICompatibleApiStyle(provider, model) && isDeepSeekReasoningModel(model)) {
    const deepseekThinking = providerOptions?.deepseek?.thinking
    if (deepseekThinking) {
      return deepseekThinking.type === 'enabled' ? 'high' : 'off'
    }
    const thinking = providerOptions?.openaiCompatible?.reasoning
    return thinking?.enabled === false || thinking?.exclude === true ? 'off' : thinking?.enabled ? 'high' : 'off'
  }
  if (effectiveProvider === ModelProviderEnum.Claude) {
    if (capabilities.kind === 'anthropic-adaptive-effort' || capabilities.kind === 'anthropic-effort') {
      return providerOptions?.claude?.effort || 'off'
    }
    const thinking = providerOptions?.claude?.thinking
    if (thinking?.type !== 'enabled') return 'off'
    const budget = thinking.budgetTokens
    if (budget >= CLAUDE_BUDGET_BY_LEVEL.high) return 'high'
    if (budget >= CLAUDE_BUDGET_BY_LEVEL.medium) return 'medium'
    return 'low'
  }
  if (
    effectiveProvider === ModelProviderEnum.OpenAI ||
    effectiveProvider === ModelProviderEnum.OpenAIResponses ||
    effectiveProvider === ModelProviderEnum.Azure
  ) {
    const effort = providerOptions?.openai?.reasoningEffort
    return normalizeEffortToLevel(effort)
  }
  if (effectiveProvider === ModelProviderEnum.XAI) {
    const effort = providerOptions?.openai?.reasoningEffort
    return normalizeEffortToLevel(effort)
  }
  if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    return normalizeEffortToLevel(providerOptions?.openrouter?.reasoning?.effort)
  }
  if (effectiveProvider === ModelProviderEnum.Gemini) {
    const config = providerOptions?.google?.thinkingConfig
    if (!config || config.includeThoughts === false) return 'off'
    if (config.thinkingLevel && config.thinkingLevel !== 'minimal') return config.thinkingLevel
    const budget = config.thinkingBudget
    if (budget === undefined || budget <= 0) return 'off'
    if (budget >= GEMINI_BUDGET_BY_LEVEL.high) return 'high'
    if (budget >= GEMINI_BUDGET_BY_LEVEL.medium) return 'medium'
    return 'low'
  }
  if (effectiveProvider === ModelProviderEnum.DeepSeek) {
    const thinking = providerOptions?.deepseek?.thinking
    return thinking?.type === 'enabled' ? 'high' : 'off'
  }
  if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
    const openaiCompatible = providerOptions?.openaiCompatible
    if (openaiCompatible?.enable_thinking !== true) return 'off'
    const budget = openaiCompatible.thinking_budget
    if (budget !== undefined && budget >= QWEN_THINKING_BUDGET_BY_LEVEL.high) return 'high'
    if (budget !== undefined && budget >= QWEN_THINKING_BUDGET_BY_LEVEL.medium) return 'medium'
    return 'low'
  }
  return 'off'
}

export function getReasoningControlOptions(
  provider: ModelProvider | undefined,
  model?: ProviderModelInfo | null
): ReasoningControlOption[] {
  const capabilities = getReasoningControlCapabilities(provider, model)
  if (!capabilities.supported) return []

  if (capabilities.kind === 'toggle') {
    return [
      { level: 'off', label: 'off' },
      { level: 'high', label: 'on' },
    ]
  }

  return [
    { level: 'off', label: 'off' },
    { level: 'low', label: 'low' },
    { level: 'medium', label: 'medium' },
    { level: 'high', label: 'high' },
  ]
}

export function getReasoningProviderOptions(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  level: ReasoningControlLevel,
  previous?: ProviderOptions
): ProviderOptions | undefined {
  const capabilities = getReasoningControlCapabilities(provider, model)
  if (!capabilities.supported) return previous

  const effectiveProvider = getEffectiveProvider(provider, model)
  const next: ProviderOptions = { ...(previous || {}) }

  if (level === 'off') {
    if (effectiveProvider === ModelProviderEnum.Claude) {
      if (capabilities.kind === 'anthropic-adaptive-effort' || capabilities.kind === 'anthropic-effort') {
        delete next.claude
      } else {
        next.claude = { thinking: { type: 'disabled', budgetTokens: 0 } }
      }
    } else if (isOpenAICompatibleApiStyle(provider, model as ProviderModelInfo) && isDeepSeekReasoningModel(model)) {
      next.deepseek = { thinking: { type: 'disabled' } }
    } else if (
      effectiveProvider === ModelProviderEnum.OpenAI ||
      effectiveProvider === ModelProviderEnum.OpenAIResponses ||
      effectiveProvider === ModelProviderEnum.Azure
    ) {
      next.openai = {
        reasoningEffort: getOpenAIReasoningEffort(model?.modelId || '', level),
        forceReasoning: true,
      }
    } else if (effectiveProvider === ModelProviderEnum.XAI) {
      next.openai = { reasoningEffort: 'none', forceReasoning: true }
    } else if (effectiveProvider === ModelProviderEnum.OpenRouter) {
      next.openrouter = { reasoning: { enabled: false, exclude: true } }
    } else if (effectiveProvider === ModelProviderEnum.Gemini) {
      next.google = { thinkingConfig: getGoogleOffThinkingConfig(model?.modelId || '') }
    } else if (effectiveProvider === ModelProviderEnum.DeepSeek) {
      next.deepseek = { thinking: { type: 'disabled' } }
    } else if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
      next.openaiCompatible = { enable_thinking: false }
    }
    return compactProviderOptions(next)
  }

  if (effectiveProvider === ModelProviderEnum.Claude) {
    if (capabilities.kind === 'anthropic-adaptive-effort' || capabilities.kind === 'anthropic-effort') {
      next.claude = { effort: level }
    } else {
      next.claude = { thinking: { type: 'enabled', budgetTokens: CLAUDE_BUDGET_BY_LEVEL[level] } }
    }
  } else if (isOpenAICompatibleApiStyle(provider, model as ProviderModelInfo) && isDeepSeekReasoningModel(model)) {
    next.deepseek = { thinking: { type: 'enabled' } }
  } else if (
    effectiveProvider === ModelProviderEnum.OpenAI ||
    effectiveProvider === ModelProviderEnum.OpenAIResponses ||
    effectiveProvider === ModelProviderEnum.Azure
  ) {
    next.openai = {
      reasoningEffort: getOpenAIReasoningEffort(model?.modelId || '', level),
      ...(effectiveProvider === ModelProviderEnum.OpenAIResponses
        ? {
            reasoningSummary: 'auto' as const,
            include: ['reasoning.encrypted_content'],
            forceReasoning: true,
          }
        : {}),
    }
  } else if (effectiveProvider === ModelProviderEnum.XAI) {
    next.openai = {
      reasoningEffort: level,
      include: ['reasoning.encrypted_content'],
      forceReasoning: true,
    }
  } else if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    next.openrouter = {
      reasoning: {
        effort: level,
        exclude: false,
      },
    }
  } else if (effectiveProvider === ModelProviderEnum.Gemini) {
    if (capabilities.kind === 'level') {
      next.google = { thinkingConfig: { thinkingLevel: level as GoogleThinkingLevel, includeThoughts: true } }
    } else {
      next.google = { thinkingConfig: { thinkingBudget: GEMINI_BUDGET_BY_LEVEL[level], includeThoughts: true } }
    }
  } else if (effectiveProvider === ModelProviderEnum.DeepSeek) {
    next.deepseek = { thinking: { type: 'enabled' } }
  } else if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
    next.openaiCompatible = {
      enable_thinking: true,
      thinking_budget: QWEN_THINKING_BUDGET_BY_LEVEL[level],
    }
  }

  return compactProviderOptions(next)
}

function isDeepSeekReasoningModel(model: ProviderModelInfo | null | undefined): boolean {
  if (!model?.modelId) return false
  return matchesAny(model.modelId, DEEPSEEK_THINKING_MODELS)
}

function getGoogleOffThinkingConfig(modelId: string): NonNullable<ProviderOptions['google']>['thinkingConfig'] {
  if (getGoogleThinkingMode(modelId) === 'level') {
    const supportedLevels = getSupportedGoogleThinkingLevels(modelId)
    return {
      thinkingLevel: supportedLevels.includes('minimal') ? 'minimal' : 'low',
      includeThoughts: false,
    }
  }

  return { thinkingBudget: 0, includeThoughts: false }
}

function isOpenRouterReasoningModel(model: ProviderModelInfo | null | undefined): boolean {
  if (!model?.modelId) return false
  return matchesAny(model.modelId, [
    ...CLAUDE_ADAPTIVE_EFFORT_MODELS,
    ...CLAUDE_EFFORT_MODELS,
    ...CLAUDE_BUDGET_MODELS,
    ...GPT_EFFORT_MODELS,
    ...DEEPSEEK_THINKING_MODELS,
    ...QWEN_THINKING_MODELS,
    ...GROK_REASONING_EFFORT_MODELS,
    /(?:^|\/)o[1-9](?:[.-]|$)/i,
  ])
}

function getOpenAIReasoningEffort(
  modelId: string,
  level: ReasoningControlLevel
): NonNullable<ProviderOptions['openai']>['reasoningEffort'] {
  if (level === 'off') {
    return matchesAny(modelId, OPENAI_NONE_EFFORT_MODELS) ? 'none' : 'minimal'
  }
  return level
}

function normalizeEffortToLevel(effort: string | undefined): ReasoningControlLevel {
  if (effort === 'none' || effort === 'minimal' || !effort) return 'off'
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort
  return 'high'
}

function compactProviderOptions(options: ProviderOptions): ProviderOptions | undefined {
  const next: ProviderOptions = { ...options }
  if (!next.claude) delete next.claude
  if (!next.openai) delete next.openai
  if (!next.google) delete next.google
  if (!next.deepseek) delete next.deepseek
  if (!next.openaiCompatible) delete next.openaiCompatible
  if (!next.openrouter) delete next.openrouter
  return Object.keys(next).length > 0 ? next : undefined
}
