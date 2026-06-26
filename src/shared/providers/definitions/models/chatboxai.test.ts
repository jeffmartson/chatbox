import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { CallChatCompletionOptions } from '@shared/models/types'
import { type ChatboxAILicenseDetail, type ProviderModelInfo, ProviderModelInfoSchema } from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import type { SentryScope } from '@shared/utils/sentry_adapter'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatboxAI from './chatboxai'

const openAIMocks = vi.hoisted(() => {
  const languageModel: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'openai',
    modelId: 'gpt-5-mini',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  }

  const responses = vi.fn(() => languageModel)
  const createOpenAI = vi.fn(() => ({
    responses,
    languageModel: vi.fn(),
  }))

  return {
    createOpenAI,
    responses,
  }
})

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAIMocks.createOpenAI,
}))

class TestChatboxAI extends ChatboxAI {
  public exposeProvider(options: CallChatCompletionOptions) {
    return this.getProvider(options)
  }

  public exposeChatModel(options: CallChatCompletionOptions) {
    return this.getChatModel(options)
  }

  public exposeCallSettings(options: CallChatCompletionOptions) {
    return this.getCallSettings(options)
  }
}

function createDependencies(): ModelDependencies {
  return {
    request: {
      apiRequest: vi.fn(),
      fetchWithOptions: vi.fn(),
    },
    storage: {
      saveImage: vi.fn(),
      getImage: vi.fn(),
    },
    sentry: {
      captureException: vi.fn(),
      withScope: vi.fn((callback: (scope: SentryScope) => void) =>
        callback({
          setTag: vi.fn(),
          setExtra: vi.fn(),
        })
      ),
    },
    getRemoteConfig: vi.fn(),
    platformType: 'desktop',
  }
}

function createModel(model: ProviderModelInfo) {
  return new TestChatboxAI(
    {
      licenseKey: 'test-license',
      licenseInstances: {
        'test-license': 'test-instance',
      },
      licenseDetail: {} as ChatboxAILicenseDetail,
      model,
      language: 'en',
      dalleStyle: 'vivid',
    },
    { uuid: 'test-uuid' },
    createDependencies()
  )
}

describe('ChatboxAI openai-responses models', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults chat models without capability metadata to tool-use capable', () => {
    const model = createModel({
      modelId: 'gpt-5.5',
      type: 'chat',
      apiStyle: 'openai-responses',
    })

    expect(model.isSupportToolUse('agent')).toBe(true)
  })

  it('respects explicit capability metadata when provided', () => {
    const model = createModel({
      modelId: 'gpt-5.5',
      type: 'chat',
      apiStyle: 'openai-responses',
      capabilities: [],
    })

    expect(model.isSupportToolUse('agent')).toBe(false)
  })

  it('keeps weak DeepSeek tool-use models disabled for scoped tools even without capability metadata', () => {
    const model = createModel({
      modelId: 'deepseek-chat',
      type: 'chat',
      apiStyle: 'openai',
    })

    expect(model.isSupportToolUse('agent')).toBe(false)
    expect(model.isSupportToolUse('read-file')).toBe(false)
  })

  it('accepts openai-responses as a provider model apiStyle', () => {
    const parsed = ProviderModelInfoSchema.parse({
      modelId: 'gpt-5-mini',
      type: 'chat',
      apiStyle: 'openai-responses',
      capabilities: ['reasoning', 'tool_use'],
    })

    expect(parsed.apiStyle).toBe('openai-responses')
  })

  it('creates an OpenAI Responses gateway provider with Chatbox AI auth headers', () => {
    const model = createModel({
      modelId: 'gpt-5-mini',
      type: 'chat',
      apiStyle: 'openai-responses',
      capabilities: ['reasoning', 'tool_use'],
    })

    model.exposeProvider({ sessionId: 'session-123' })

    expect(openAIMocks.createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-license',
        baseURL: expect.stringContaining('/gateway/openai-responses/v1'),
        headers: {
          'Instance-Id': 'test-instance',
          'chatbox-session-id': 'session-123',
        },
        fetch: expect.any(Function),
      })
    )
  })

  it('uses provider.responses for openai-responses chat models', () => {
    const model = createModel({
      modelId: 'gpt-5-mini',
      type: 'chat',
      apiStyle: 'openai-responses',
      capabilities: ['reasoning', 'tool_use'],
    })

    const chatModel = model.exposeChatModel({ sessionId: 'session-123' })

    expect(openAIMocks.responses).toHaveBeenCalledWith('gpt-5-mini')
    expect(chatModel.modelId).toBe('gpt-5-mini')
  })

  it('forces store=false for openai-responses gateway requests while preserving user OpenAI provider options', () => {
    const model = createModel({
      modelId: 'gpt-5.5',
      type: 'chat',
      apiStyle: 'openai-responses',
      capabilities: ['reasoning', 'tool_use'],
    })

    const settings = model.exposeCallSettings({
      providerOptions: {
        openai: {
          reasoningEffort: 'high',
        },
      },
    })

    expect(settings.providerOptions).toEqual({
      openai: {
        reasoningEffort: 'high',
        store: false,
      },
    })
  })

  it('forces store=false for openai-responses gateway requests without user provider options', () => {
    const model = createModel({
      modelId: 'gpt-5.5',
      type: 'chat',
      apiStyle: 'openai-responses',
      capabilities: ['reasoning', 'tool_use'],
    })

    const settings = model.exposeCallSettings({})

    expect(settings.providerOptions).toEqual({
      openai: {
        store: false,
      },
    })
  })

  it('maps OpenAI-style reasoning options to OpenAI-compatible gateway extra body', () => {
    const model = createModel({
      modelId: 'gpt-5.5',
      type: 'chat',
      apiStyle: 'openai',
      capabilities: ['reasoning', 'tool_use'],
    })

    const settings = model.exposeCallSettings({
      providerOptions: {
        openai: {
          reasoningEffort: 'low',
        },
      },
    })

    expect(settings.providerOptions).toEqual({
      openaiCompatible: {
        reasoningEffort: 'low',
      },
      ChatboxAI: {
        reasoningEffort: 'low',
      },
    })
  })

  it('maps DeepSeek thinking through ChatboxAI gateway with native thinking options', () => {
    const model = createModel({
      modelId: 'deepseek-v4-pro',
      type: 'chat',
      apiStyle: 'openai',
      capabilities: ['reasoning', 'tool_use'],
    })

    const settings = model.exposeCallSettings({
      providerOptions: {
        deepseek: {
          thinking: {
            type: 'enabled',
          },
        },
      },
    })

    expect(settings.providerOptions).toEqual({
      deepseek: {
        thinking: {
          type: 'enabled',
        },
      },
    })
  })

  it('converts legacy ChatboxAI DeepSeek reasoning toggles to native thinking options', () => {
    const model = createModel({
      modelId: 'deepseek-v4-pro',
      type: 'chat',
      apiStyle: 'openai',
      capabilities: ['reasoning', 'tool_use'],
    })

    const settings = model.exposeCallSettings({
      providerOptions: {
        openaiCompatible: {
          reasoning: {
            enabled: false,
            exclude: true,
          },
        },
      },
    })

    expect(settings.providerOptions).toEqual({
      deepseek: {
        thinking: {
          type: 'disabled',
        },
      },
    })
  })
})
