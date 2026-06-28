import type { SandboxProvider } from '@shared/sandbox-provider'
import type { JSONSchema7 } from 'json-schema'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/platform', () => ({
  default: { type: 'web' },
}))

vi.mock('@/packages/user-exec-approval', () => ({
  requestFileMutationApproval: vi.fn(),
}))

import { buildFilesystemTools } from './filesystem'
import sandboxToolSet from './sandbox'

function assertOpenAiCompatibleFunctionSchema(schema: JSONSchema7) {
  expect(schema.type).toBe('object')
  expect(schema).not.toHaveProperty('oneOf')
  expect(schema).not.toHaveProperty('anyOf')
  expect(schema).not.toHaveProperty('allOf')
  expect(schema).not.toHaveProperty('enum')
  expect(schema).not.toHaveProperty('not')
}

function getJsonSchema(inputSchema: unknown): JSONSchema7 {
  return (inputSchema as { jsonSchema: JSONSchema7 }).jsonSchema
}

function executeTool(tool: unknown, input: unknown) {
  const executableTool = tool as {
    execute?: (input: unknown, options: { toolCallId: string; messages: [] }) => unknown
  }
  return executableTool.execute?.(input, { toolCallId: 'tool-call-id', messages: [] })
}

async function toModelOutput(tool: unknown, output: unknown) {
  const mapper = tool as {
    toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown> | unknown
  }
  return await mapper.toModelOutput({ toolCallId: 'tool-call-id', input: {}, output })
}

describe('edit file tool schemas', () => {
  test('filesystem edit_file does not use top-level composition keywords', () => {
    const tools = buildFilesystemTools({
      sessionId: 'session-id',
      provider: {} as SandboxProvider,
    }).tools
    const schema = getJsonSchema(tools.edit_file.inputSchema)

    assertOpenAiCompatibleFunctionSchema(schema)
    expect(schema.required).toEqual(['file_path'])
    expect(schema.properties).toHaveProperty('edits')
    expect(schema.properties).toHaveProperty('old_text')
    expect(schema.properties).toHaveProperty('new_text')
  })

  test('filesystem edit_file rejects calls without edit content', async () => {
    const tools = buildFilesystemTools({}).tools
    const result = await executeTool(tools.edit_file, { file_path: '/tmp/example.txt' })

    expect(result).toEqual({ error: 'Provide edits[] or both old_text and new_text.' })
  })

  test('sandbox_edit does not use top-level composition keywords', () => {
    const schema = getJsonSchema(sandboxToolSet.tools.sandbox_edit.inputSchema)

    assertOpenAiCompatibleFunctionSchema(schema)
    expect(schema.required).toEqual(['file_path'])
    expect(schema.properties).toHaveProperty('edits')
    expect(schema.properties).toHaveProperty('old_text')
    expect(schema.properties).toHaveProperty('new_text')
  })

  test('sandbox_edit rejects calls without edit content', async () => {
    const result = await executeTool(sandboxToolSet.tools.sandbox_edit, { file_path: 'example.txt' })

    expect(result).toBe('Error editing file: Provide edits[] or both old_text and new_text.')
  })

  test('sandbox common tools map empty content to tool-specific results', async () => {
    await expect(
      toModelOutput(sandboxToolSet.tools.sandbox_bash, { stdout: '', stderr: '', exitCode: 0 })
    ).resolves.toEqual({
      type: 'text',
      value: 'Exit code: 0\n\n(no output)',
    })
    await expect(toModelOutput(sandboxToolSet.tools.sandbox_read, { content: '' })).resolves.toEqual({
      type: 'text',
      value: 'File is empty.',
    })
    await expect(toModelOutput(sandboxToolSet.tools.sandbox_grep, { content: '' })).resolves.toEqual({
      type: 'text',
      value: 'No matches found.',
    })
    await expect(toModelOutput(sandboxToolSet.tools.sandbox_ls, { content: '' })).resolves.toEqual({
      type: 'text',
      value: 'Directory is empty.',
    })
    await expect(toModelOutput(sandboxToolSet.tools.sandbox_find, { content: '' })).resolves.toEqual({
      type: 'text',
      value: 'No files found.',
    })
  })
})
