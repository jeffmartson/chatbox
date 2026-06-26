import type { Message } from '@shared/types'
import { modelMessageSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { convertToModelMessages } from './model-message-converter'

// Tool-call fixtures below never reference images, so the resolver is never called.
const noImage = () => Promise.resolve(null)

function assistantWithToolResult(result: unknown): Message {
  return {
    id: 'a1',
    role: 'assistant',
    contentParts: [
      {
        type: 'tool-call',
        state: 'result',
        toolCallId: 'call-1',
        toolName: 'mcp__repro__crash_transport',
        args: { reason: 'repro invalid prompt bug' },
        result,
      },
    ],
  }
}

describe('convertToModelMessages — tool result sanitization', () => {
  it('produces a schema-valid prompt when a tool result is a raw Error object', async () => {
    // Regression: when an MCP tool crashed, the raw Error leaked into history. On the next
    // send, the AI SDK rejected the prompt with AI_InvalidPromptError because an Error is not
    // a valid ModelMessage[] tool output.
    const messages = [assistantWithToolResult(new Error('transport crashed'))]

    const output = await convertToModelMessages(messages, noImage)

    // Every produced message must pass the exact schema the AI SDK validates against.
    for (const msg of output) {
      expect(() => modelMessageSchema.parse(msg)).not.toThrow()
    }

    const toolMsg = output.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    const part = (toolMsg?.content as Array<{ type: string; output: unknown }>)[0]
    expect(part.output).toEqual({ type: 'json', value: { error: 'transport crashed' } })
  })

  it('strips non-serializable values (circular refs) from tool results', async () => {
    const circular: Record<string, unknown> = { ok: true }
    circular.self = circular
    const messages = [assistantWithToolResult(circular)]

    const output = await convertToModelMessages(messages, noImage)

    for (const msg of output) {
      expect(() => modelMessageSchema.parse(msg)).not.toThrow()
    }
    // The whole prompt must JSON round-trip (this is what the SDK ultimately serializes).
    expect(() => JSON.stringify(output)).not.toThrow()
  })

  it('coerces nested Errors and BigInt instead of dropping/throwing', async () => {
    const messages = [assistantWithToolResult({ inner: new Error('boom'), count: 10n, ok: true })]

    const output = await convertToModelMessages(messages, noImage)

    for (const msg of output) {
      expect(() => modelMessageSchema.parse(msg)).not.toThrow()
    }
    const toolMsg = output.find((m) => m.role === 'tool')
    const part = (toolMsg?.content as Array<{ type: string; output: { value: unknown } }>)[0]
    expect(part.output).toEqual({
      type: 'json',
      value: { inner: { error: 'boom' }, count: '10', ok: true },
    })
  })

  it('passes plain JSON tool results through unchanged', async () => {
    const messages = [assistantWithToolResult({ content: [{ type: 'text', text: 'hello' }] })]

    const output = await convertToModelMessages(messages, noImage)

    const toolMsg = output.find((m) => m.role === 'tool')
    const part = (toolMsg?.content as Array<{ type: string; output: unknown }>)[0]
    expect(part.output).toEqual({ type: 'json', value: { content: [{ type: 'text', text: 'hello' }] } })
  })

  it('preserves Gemini thought signatures on assistant tool-call parts', async () => {
    const providerMetadata = { google: { thoughtSignature: 'signature-1' } }
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        contentParts: [
          {
            type: 'tool-call',
            state: 'result',
            toolCallId: 'call-1',
            toolName: 'default_api:write_file',
            args: { path: 'demo.txt', content: 'hello' },
            providerMetadata,
            providerExecuted: true,
            result: { ok: true },
          },
        ],
      },
    ]

    const output = await convertToModelMessages(messages, noImage)
    const assistantMsg = output.find((m) => m.role === 'assistant')
    const toolCallPart = (assistantMsg?.content as Array<{ type: string; providerOptions?: unknown }>)[0]

    expect(toolCallPart.providerOptions).toEqual(providerMetadata)
    expect(toolCallPart).toMatchObject({ providerExecuted: true })
    expect(() => modelMessageSchema.parse(assistantMsg)).not.toThrow()
  })

  it('preserves provider metadata on tool results', async () => {
    const resultProviderMetadata = { openai: { itemId: 'result-item-1' } }
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        contentParts: [
          {
            type: 'tool-call',
            state: 'result',
            toolCallId: 'call-1',
            toolName: 'tool_search',
            args: { query: 'docs' },
            resultProviderMetadata,
            result: { ok: true },
          },
        ],
      },
    ]

    const output = await convertToModelMessages(messages, noImage)
    const toolMsg = output.find((m) => m.role === 'tool')
    const toolResultPart = (toolMsg?.content as Array<{ type: string; providerOptions?: unknown }>)[0]

    expect(toolResultPart.providerOptions).toEqual(resultProviderMetadata)
    expect(() => modelMessageSchema.parse(toolMsg)).not.toThrow()
  })

  it('preserves reasoning only when requested by the provider path', async () => {
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        contentParts: [
          { type: 'reasoning', text: 'thinking about the answer' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ]

    const defaultOutput = await convertToModelMessages(messages, noImage)
    const defaultAssistant = defaultOutput.find((m) => m.role === 'assistant')
    expect(defaultAssistant?.content).toEqual([{ type: 'text', text: 'final answer' }])

    const preservedOutput = await convertToModelMessages(messages, noImage, {
      modelSupportVision: true,
      preserveReasoning: true,
    })
    const preservedAssistant = preservedOutput.find((m) => m.role === 'assistant')
    expect(preservedAssistant?.content).toEqual([
      { type: 'reasoning', text: 'thinking about the answer' },
      { type: 'text', text: 'final answer' },
    ])
    expect(() => modelMessageSchema.parse(preservedAssistant)).not.toThrow()
  })
})
