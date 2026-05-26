import { describe, expect, test } from 'vitest'
import { settings as defaultSettings } from '../defaults'
import { SettingsSchema } from './settings'

describe('SettingsSchema RAG default models', () => {
  test('parses default embedding and rerank model selections', () => {
    const parsed = SettingsSchema.parse({
      ...defaultSettings(),
      defaultEmbeddingModel: {
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      defaultRerankModel: {
        provider: 'cohere',
        model: 'rerank-v3.5',
      },
    })

    expect(parsed.defaultEmbeddingModel).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    })
    expect(parsed.defaultRerankModel).toEqual({
      provider: 'cohere',
      model: 'rerank-v3.5',
    })
  })

  test('defaults leave RAG model fallbacks unset', () => {
    const parsed = SettingsSchema.parse(defaultSettings())

    expect(parsed.defaultEmbeddingModel).toBeUndefined()
    expect(parsed.defaultRerankModel).toBeUndefined()
  })
})
