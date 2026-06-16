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
})
