import type { SandboxExecResult, SandboxOperationResult } from '@shared/sandbox-provider'
import { jsonSchema, type ToolSet } from 'ai'
import platform from '@/platform'
import { asRecord, contentOrErrorText, numberField, stringField, toTextModelOutput } from './model-output'

interface SandboxEditOperation {
  old_text: string
  new_text: string
}

interface SandboxEditInput {
  file_path: string
  old_text?: string
  new_text?: string
  edits?: SandboxEditOperation[]
}

const sandboxEditInputSchema = jsonSchema({
  type: 'object',
  description:
    'Provide either edits for one or more replacements, or legacy old_text and new_text for a single replacement.',
  properties: {
    file_path: {
      type: 'string',
      description: 'File path to edit',
    },
    old_text: {
      type: 'string',
      description: 'Legacy single edit: exact text to find; must be unique',
    },
    new_text: {
      type: 'string',
      description: 'Legacy single edit: replacement text',
    },
    edits: {
      type: 'array',
      minItems: 1,
      description: 'Multiple exact search-and-replace edits to apply atomically in order',
      items: {
        type: 'object',
        properties: {
          old_text: {
            type: 'string',
            description: 'Exact text to find; must be unique within the current file content',
          },
          new_text: {
            type: 'string',
            description: 'Replacement text',
          },
        },
        required: ['old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['file_path'],
  additionalProperties: false,
})

function normalizeSandboxEdits(input: SandboxEditInput): SandboxEditOperation[] {
  if (input.edits?.length) return input.edits
  return [{ old_text: input.old_text ?? '', new_text: input.new_text ?? '' }]
}

function validateSandboxEditInput(input: SandboxEditInput): { edits: SandboxEditOperation[] } | { error: string } {
  if (input.edits?.length) return { edits: input.edits }
  if (input.old_text !== undefined && input.new_text !== undefined) return { edits: normalizeSandboxEdits(input) }
  return { error: 'Provide edits[] or both old_text and new_text.' }
}

const toolSetDescription = `
Use these tools to interact with a sandboxed environment for executing code, reading/writing files, and exploring the file system.
All file paths are relative to the sandbox working directory.
Write access is limited to the selected working directory and /tmp.
Prefer operating within granted directories;
if a task needs global/system-level changes, ask the user to run those steps.

## sandbox_bash
Execute a shell command in the sandbox. Returns stdout, stderr, and exit code.
Use for running scripts, installing packages, building projects, or any command-line operation.
Default timeout is 120 seconds (120000ms).

## sandbox_read
Read the content of a file. Returns the file content as a string.
Use when you need to examine file contents.

## sandbox_write
Write content to a file, creating it if it doesn't exist or overwriting if it does.
Use for creating new files or replacing entire file contents.

## sandbox_edit
Perform one or more search-and-replace edits within a file. Prefer edits[] for multiple changes in one call.
Each search text must be an exact, unique match at the time it is applied.
Use for making targeted modifications to existing files without rewriting the whole file.

## sandbox_grep
Search file contents using regex or literal patterns. Returns matching lines with file paths and line numbers.
Use to find specific code patterns, function definitions, or text across multiple files.

## sandbox_ls
List directory contents with details (permissions, size, dates).
Use to explore the file system structure.

## sandbox_find
Find files by name pattern (glob). Returns matching file paths.
Use to locate files when you know part of the name but not the exact path.
`

const DEFAULT_BASH_TIMEOUT = 120_000

function formatSandboxBashOutput(output: unknown): string {
  if (typeof output === 'string') return output
  const record = asRecord(output)
  const stdout = stringField(record, 'stdout') ?? ''
  const stderr = stringField(record, 'stderr') ?? ''
  const errorCode = stringField(record, 'errorCode')
  const exitCode = numberField(record, 'exitCode')
  const sections = [`Exit code: ${exitCode ?? 'unknown'}`]
  if (errorCode) sections.push(`Error code: ${errorCode}`)
  if (stdout) sections.push(`Stdout:\n${stdout}`)
  if (stderr) sections.push(`Stderr:\n${stderr}`)
  if (!stdout && !stderr) sections.push('(no output)')
  return sections.join('\n\n')
}

function sandboxOperationToolError(prefix: string, result: SandboxOperationResult) {
  const error = `${prefix}: ${result.error || 'Unknown error'}`
  if (!result.errorCode) return error
  return {
    error,
    errorCode: result.errorCode,
  }
}

function abortableExec(execPromise: Promise<SandboxExecResult>, abortSignal?: AbortSignal): Promise<SandboxExecResult> {
  if (!abortSignal) return execPromise

  return Promise.race([
    execPromise,
    new Promise<SandboxExecResult>((_, reject) => {
      if (abortSignal.aborted) {
        platform.sandboxKill?.()
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      abortSignal.addEventListener(
        'abort',
        () => {
          platform.sandboxKill?.()
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true }
      )
    }),
  ])
}

const sandbox_bash: ToolSet[string] = {
  description: 'Execute a shell command in the sandbox environment.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute in the sandbox',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
    },
    required: ['command'],
    additionalProperties: false,
  }),
  execute: async (input, { abortSignal }) => {
    const bashInput = input as { command: string; timeout?: number }
    if (!platform.sandboxExecCode) {
      return 'Sandbox not available on this platform'
    }
    try {
      const timeout = bashInput.timeout ?? DEFAULT_BASH_TIMEOUT
      const result = await abortableExec(
        platform.sandboxExecCode({ code: bashInput.command, language: 'bash', timeout }),
        abortSignal
      )
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        errorCode: result.errorCode,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { stdout: '', stderr: '[Command cancelled]', exitCode: 130 }
      }
      return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(formatSandboxBashOutput),
}

const sandbox_read: ToolSet[string] = {
  description: 'Read the content of a file in the sandbox.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'File path relative to working directory',
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  }),
  execute: async (input) => {
    const readInput = input as { file_path: string }
    if (!platform.sandboxRead) {
      return 'Sandbox not available on this platform'
    }
    try {
      const result = await platform.sandboxRead({ filePath: readInput.file_path })
      if (!result.success) {
        return sandboxOperationToolError('Error reading file', result)
      }
      return { content: result.content ?? '' }
    } catch (error) {
      return `Error reading file: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(contentOrErrorText, { emptyFallback: 'File is empty.' }),
}

const sandbox_write: ToolSet[string] = {
  description: 'Write content to a file in the sandbox, creating or overwriting it.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'File path relative to working directory',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file',
      },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  }),
  execute: async (input) => {
    const writeInput = input as { file_path: string; content: string }
    if (!platform.sandboxWrite) {
      return 'Sandbox not available on this platform'
    }
    try {
      const result = await platform.sandboxWrite({ filePath: writeInput.file_path, content: writeInput.content })
      if (!result.success) {
        return `Error writing file: ${result.error}`
      }
      return `Status: success\nAction: sandbox_write\nPath: ${writeInput.file_path}`
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(contentOrErrorText),
}

const sandbox_edit: ToolSet[string] = {
  description:
    'Search and replace text in a file. Prefer edits[] for multiple changes in one call. Each search text must be an exact unique match within the file.',
  inputSchema: sandboxEditInputSchema,
  execute: async (input) => {
    const editInput = input as SandboxEditInput
    const validatedInput = validateSandboxEditInput(editInput)
    if ('error' in validatedInput) return `Error editing file: ${validatedInput.error}`
    if (!platform.sandboxEdit) {
      return 'Sandbox not available on this platform'
    }
    try {
      const { edits } = validatedInput
      const result = await platform.sandboxEdit({
        filePath: editInput.file_path,
        edits: edits.map((edit) => ({ search: edit.old_text, replace: edit.new_text })),
      })
      if (!result.success) {
        return `Error editing file: ${result.error}`
      }
      return `Status: success\nAction: sandbox_edit\nPath: ${editInput.file_path}\nEdits applied: ${edits.length}`
    } catch (error) {
      return `Error editing file: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(contentOrErrorText),
}

const sandbox_grep: ToolSet[string] = {
  description:
    'Search file contents using ripgrep/Rust regex syntax (look-around and backreferences are unsupported). Returns matching lines with file paths.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'ripgrep/Rust regex pattern',
      },
      path: {
        type: 'string',
        description: 'Directory to search (default: .)',
      },
      include: {
        type: 'string',
        description: 'File filter glob (e.g., "*.ts")',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  execute: async (input) => {
    const grepInput = input as { pattern: string; path?: string; include?: string }
    if (!platform.sandboxSearch) {
      return 'Sandbox not available on this platform'
    }
    try {
      const result = await platform.sandboxSearch({
        pattern: grepInput.pattern,
        path: grepInput.path ?? '.',
        regex: true,
        include: grepInput.include,
      })
      if (!result.success) {
        return sandboxOperationToolError('Error searching', result)
      }
      return { content: result.content ?? '' }
    } catch (error) {
      return `Error searching: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(contentOrErrorText, { emptyFallback: 'No matches found.' }),
}

const sandbox_ls: ToolSet[string] = {
  description: 'List directory contents in the sandbox.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path (default: .)',
      },
    },
    additionalProperties: false,
  }),
  execute: async (input) => {
    const lsInput = input as { path?: string }
    if (!platform.sandboxLs) {
      return 'Sandbox not available on this platform'
    }
    try {
      const result = await platform.sandboxLs({ dirPath: lsInput.path || '.' })
      if (!result.success) {
        return sandboxOperationToolError('Error listing directory', result)
      }
      return { content: result.content ?? '' }
    } catch (error) {
      return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(contentOrErrorText, { emptyFallback: 'Directory is empty.' }),
}

const sandbox_find: ToolSet[string] = {
  description: 'Find files by name pattern (glob) in the sandbox.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern for file name search',
      },
      path: {
        type: 'string',
        description: 'Directory to search (default: .)',
      },
    },
    additionalProperties: false,
  }),
  execute: async (input) => {
    const findInput = input as { pattern?: string; path?: string }
    if (!platform.sandboxFind) {
      return 'Sandbox not available on this platform'
    }
    try {
      const result = await platform.sandboxFind({ dirPath: findInput.path || '.', pattern: findInput.pattern })
      if (!result.success) {
        return sandboxOperationToolError('Error finding files', result)
      }
      return { content: result.content ?? '' }
    } catch (error) {
      return `Error finding files: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  toModelOutput: toTextModelOutput(contentOrErrorText, { emptyFallback: 'No files found.' }),
}

export default {
  description: toolSetDescription,
  tools: {
    sandbox_bash,
    sandbox_read,
    sandbox_write,
    sandbox_edit,
    sandbox_grep,
    sandbox_ls,
    sandbox_find,
  },
}
