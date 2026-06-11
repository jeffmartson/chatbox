import type { CallChatCompletionOptions } from '@shared/models/types'
import type { ProviderModelInfo } from '@shared/types'
import type { ModelDependencies } from '@shared/types/adapters'
import type { SentryScope } from '@shared/utils/sentry_adapter'
import { describe, expect, it, vi } from 'vitest'
import Claude from './claude'
import DeepSeek from './deepseek'
import OpenRouter from './openrouter'
import Qwen from './qwen'

class TestDeepSeek extends DeepSeek {
  public exposeCallSettings(options: CallChatCompletionOptions) {
    return this.getCallSettings(options)
  }
}

class TestOpenRouter extends OpenRouter {
  public exposeCallSettings(options: CallChatCompletionOptions) {
    return this.getCallSettings(options)
  }
}

class TestQwen extends Qwen {
  public exposeCallSettings(options: CallChatCompletionOptions) {
    return this.getCallSettings(options)
  }
}

type ClaudeFetchHarness = {
  createFetch(): typeof globalThis.fetch | undefined
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

const reasoningModel = (modelId: string): ProviderModelInfo => ({
  modelId,
  type: 'chat',
  capabilities: ['reasoning'],
})

describe('reasoning request options', () => {
  it('adds summarized display to Claude thinking requests before fetch', async () => {
    let requestBody: unknown
    const baseFetch: typeof globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      return Promise.resolve(new Response('{}'))
    }
    const claude = new Claude(
      {
        claudeApiKey: 'test-key',
        claudeApiHost: 'https://api.anthropic.com/v1',
        model: reasoningModel('claude-sonnet-4-6'),
        customFetch: baseFetch,
      },
      createDependencies()
    )

    const wrappedFetch = (claude as unknown as ClaudeFetchHarness).createFetch()
    await wrappedFetch?.('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        thinking: {
          type: 'enabled',
          budget_tokens: 1024,
        },
      }),
    })

    expect(requestBody).toEqual({
      thinking: {
        type: 'enabled',
        budget_tokens: 1024,
        display: 'summarized',
      },
    })
  })

  it('binds the default global fetch when wrapping Claude requests', async () => {
    let fetchThis: unknown
    const globalFetch = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      fetchThis = this
      return Promise.resolve(new Response('{}'))
    } as typeof globalThis.fetch
    vi.stubGlobal('fetch', globalFetch)
    try {
      const claude = new Claude(
        {
          claudeApiKey: 'test-key',
          claudeApiHost: 'https://api.anthropic.com/v1',
          model: reasoningModel('claude-sonnet-4-6'),
        },
        createDependencies()
      )

      const wrappedFetch = (claude as unknown as ClaudeFetchHarness).createFetch()
      await wrappedFetch?.('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({}),
      })

      expect(fetchThis).toBe(globalThis)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('converts Claude Opus 4.8 effort requests to adaptive summarized thinking before fetch', async () => {
    let requestBody: unknown
    const baseFetch: typeof globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      return Promise.resolve(new Response('{}'))
    }
    const claude = new Claude(
      {
        claudeApiKey: 'test-key',
        claudeApiHost: 'https://api.anthropic.com/v1',
        model: reasoningModel('claude-opus-4-8'),
        customFetch: baseFetch,
      },
      createDependencies()
    )

    const wrappedFetch = (claude as unknown as ClaudeFetchHarness).createFetch()
    await wrappedFetch?.('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        output_config: {
          effort: 'high',
        },
      }),
    })

    expect(requestBody).toEqual({
      output_config: {
        effort: 'high',
      },
      thinking: {
        type: 'adaptive',
        display: 'summarized',
      },
    })
  })

  it('passes DeepSeek thinking toggle to provider options without unsupported effort levels', () => {
    const deepseek = new TestDeepSeek(
      {
        apiKey: 'test-key',
        model: reasoningModel('deepseek-v3.2-thinking'),
      },
      createDependencies()
    )

    const enabled = deepseek.exposeCallSettings({
      providerOptions: {
        deepseek: {
          thinking: {
            type: 'enabled',
          },
        },
      },
    })
    const disabled = deepseek.exposeCallSettings({
      providerOptions: {
        deepseek: {
          thinking: {
            type: 'disabled',
          },
        },
      },
    })

    expect(enabled.providerOptions).toEqual({
      deepseek: {
        thinking: {
          type: 'enabled',
        },
      },
    })
    expect(disabled.providerOptions).toEqual({
      deepseek: {
        thinking: {
          type: 'disabled',
        },
      },
    })
  })

  it('passes OpenRouter reasoning effort and response inclusion options to provider options', () => {
    const openrouter = new TestOpenRouter(
      {
        apiKey: 'test-key',
        model: reasoningModel('deepseek/deepseek-v4-pro'),
      },
      createDependencies()
    )

    const settings = openrouter.exposeCallSettings({
      providerOptions: {
        openrouter: {
          reasoning: {
            effort: 'high',
            exclude: false,
          },
        },
      },
    })

    expect(settings.providerOptions).toEqual({
      openrouter: {
        reasoning: {
          effort: 'high',
          exclude: false,
        },
      },
    })
  })

  it('keys Qwen thinking options by provider name for OpenAI-compatible extra body', () => {
    const qwen = new TestQwen(
      {
        name: 'Qwen',
        apiKey: 'test-key',
        apiHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: reasoningModel('qwen3.7-max'),
      },
      createDependencies()
    )

    const settings = qwen.exposeCallSettings({
      providerOptions: {
        openaiCompatible: {
          enable_thinking: true,
          thinking_budget: 8192,
        },
      },
    })

    expect(settings.providerOptions).toEqual({
      openaiCompatible: {
        enable_thinking: true,
        thinking_budget: 8192,
      },
      Qwen: {
        enable_thinking: true,
        thinking_budget: 8192,
      },
    })
  })
})
