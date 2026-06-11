import type { SandboxProvider } from '@shared/sandbox-provider'
import { shellQuote } from '@shared/utils/shell'
import { jsonSchema, type ToolSet } from 'ai'
import { requestFileMutationApproval } from '@/packages/user-exec-approval'
import platform from '@/platform'

interface FilesystemContext {
  sessionId?: string
  provider?: SandboxProvider
}

interface EditOperation {
  old_text: string
  new_text: string
}

interface EditFileInput {
  file_path: string
  old_text?: string
  new_text?: string
  edits?: EditOperation[]
}

const editFileInputSchema = jsonSchema({
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
      description: 'Legacy single edit: exact text to replace; must be unique',
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
            description: 'Exact text to replace; must be unique within the current file content',
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

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)
}

function previewContent(content: string, maxLength = 2000): string {
  return content.length > maxLength ? `${content.slice(0, maxLength)}\n... [truncated]` : content
}

function normalizeEdits(input: EditFileInput): EditOperation[] {
  if (input.edits?.length) return input.edits
  return [{ old_text: input.old_text ?? '', new_text: input.new_text ?? '' }]
}

function validateEditInput(input: EditFileInput): { edits: EditOperation[] } | { error: string } {
  if (input.edits?.length) return { edits: input.edits }
  if (input.old_text !== undefined && input.new_text !== undefined) return { edits: normalizeEdits(input) }
  return { error: 'Provide edits[] or both old_text and new_text.' }
}

function previewEdits(edits: EditOperation[]): string {
  return edits
    .map(
      (edit, index) =>
        `# Edit ${index + 1}\n--- old\n${previewContent(edit.old_text)}\n+++ new\n${previewContent(edit.new_text)}`
    )
    .join('\n\n')
}

function ensureSandbox(context: FilesystemContext): Promise<{ success: boolean; error?: string }> {
  if (!context.provider || !context.sessionId) {
    return Promise.resolve({ success: false, error: 'Sandbox is not available' })
  }
  return context.provider.init(context.sessionId)
}

async function getSandboxRoot(context: FilesystemContext): Promise<string | null> {
  if (!context.provider) return null
  const status = await context.provider.getStatus().catch(() => null)
  return status?.workingDirectory ?? null
}

function isInsideRoot(root: string, filePath: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  return filePath === root || filePath.startsWith(normalizedRoot)
}

function requireAbsoluteRealPath(filePath: string) {
  return isAbsolutePath(filePath) ? null : { error: 'Relative paths require an active session sandbox' }
}

async function shouldUseSandbox(context: FilesystemContext, filePath: string): Promise<boolean> {
  if (!context.provider) return false
  if (!isAbsolutePath(filePath)) return true
  const root = await getSandboxRoot(context)
  return root ? isInsideRoot(root, filePath) : false
}

async function writeSandboxFile(context: FilesystemContext, filePath: string, content: string) {
  const setup = await ensureSandbox(context)
  if (!setup.success) return setup
  if (!context.provider) return { success: false, error: 'Sandbox is not available' }
  const encoded = btoa(unescape(encodeURIComponent(content)))
  const result = await context.provider.exec({
    language: 'bash',
    code: `mkdir -p "$(dirname ${shellQuote(filePath)})" && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`,
    timeout: 10_000,
  })
  return result.exitCode === 0 ? { success: true } : { success: false, error: result.stderr || result.stdout }
}

async function editSandboxFile(context: FilesystemContext, filePath: string, edits: EditOperation[]) {
  const setup = await ensureSandbox(context)
  if (!setup.success) return setup
  if (!context.provider) return { success: false, error: 'Sandbox is not available' }
  const result = await context.provider.exec({
    language: 'node',
    code: `
const fs = require('fs')
const filePath = ${JSON.stringify(filePath)}
const edits = ${JSON.stringify(edits)}
let text = fs.readFileSync(filePath, 'utf8')
for (let i = 0; i < edits.length; i++) {
  const { old_text, new_text } = edits[i]
  const first = text.indexOf(old_text)
  if (first === -1) {
    console.error('Edit ' + (i + 1) + ': search text not found')
    process.exit(1)
  }
  if (text.indexOf(old_text, first + old_text.length) !== -1) {
    console.error('Edit ' + (i + 1) + ': search text is not unique')
    process.exit(1)
  }
  text = text.slice(0, first) + new_text + text.slice(first + old_text.length)
}
fs.writeFileSync(filePath, text, 'utf8')
`,
    timeout: 10_000,
  })
  return result.exitCode === 0 ? { success: true } : { success: false, error: result.stderr || result.stdout }
}

export function buildFilesystemTools(context: FilesystemContext): { tools: ToolSet; description: string } {
  const list_files: ToolSet[string] = {
    description:
      'List files in a directory. Relative paths are resolved in the session sandbox. Absolute paths read the user filesystem.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list',
        },
      },
      required: ['path'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const listInput = input as { path: string }
      if (await shouldUseSandbox(context, listInput.path)) {
        const setup = await ensureSandbox(context)
        if (!setup.success) return { error: setup.error }
        if (!context.provider) return { error: 'Sandbox is not available' }
        const result = await context.provider.exec({
          language: 'bash',
          code: `ls -la ${shellQuote(listInput.path)}`,
          timeout: 10_000,
        })
        return result.exitCode === 0 ? { content: result.stdout } : { error: result.stderr || result.stdout }
      }
      const pathError = requireAbsoluteRealPath(listInput.path)
      if (pathError) return pathError
      if (!platform.fsList) return { error: 'Filesystem access is not available on this platform' }
      const result = await platform.fsList({ dirPath: listInput.path })
      return result.success ? { content: result.content ?? '' } : { error: result.error }
    },
  }

  const search_files: ToolSet[string] = {
    description:
      'Search text in files. Relative paths search the session sandbox. Absolute paths search the user filesystem.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to search',
        },
        query: {
          type: 'string',
          description: 'Literal text to search for',
        },
        include: {
          type: 'string',
          description: 'Optional file name filter, for example "*.ts"',
        },
      },
      required: ['path', 'query'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const searchInput = input as { path: string; query: string; include?: string }
      if (await shouldUseSandbox(context, searchInput.path)) {
        const setup = await ensureSandbox(context)
        if (!setup.success) return { error: setup.error }
        const include = searchInput.include ? ` --include=${shellQuote(searchInput.include)}` : ''
        if (!context.provider) return { error: 'Sandbox is not available' }
        const result = await context.provider.exec({
          language: 'bash',
          code: `grep -RInF${include} -- ${shellQuote(searchInput.query)} ${shellQuote(searchInput.path)} | head -100`,
          timeout: 10_000,
        })
        return result.exitCode === 0 || result.exitCode === 1
          ? { content: result.stdout }
          : { error: result.stderr || result.stdout }
      }
      const pathError = requireAbsoluteRealPath(searchInput.path)
      if (pathError) return pathError
      if (!platform.fsSearch) return { error: 'Filesystem access is not available on this platform' }
      const result = await platform.fsSearch({
        dirPath: searchInput.path,
        pattern: searchInput.query,
        include: searchInput.include,
      })
      return result.success ? { content: result.content ?? '' } : { error: result.error }
    },
  }

  const write_file: ToolSet[string] = {
    description:
      'Write a file. Relative sandbox paths are written directly. Writing absolute user filesystem paths requires user approval.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path to write',
        },
        content: {
          type: 'string',
          description: 'Full file content',
        },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    }),
    execute: async (input, toolOptions) => {
      const writeInput = input as { file_path: string; content: string }
      const alreadyApproved = (toolOptions as typeof toolOptions & { approved?: boolean }).approved
      if (await shouldUseSandbox(context, writeInput.file_path)) {
        const result = await writeSandboxFile(context, writeInput.file_path, writeInput.content)
        return result.success ? { success: true, file_path: writeInput.file_path } : { error: result.error }
      }
      const pathError = requireAbsoluteRealPath(writeInput.file_path)
      if (pathError) return pathError
      if (!platform.fsWrite) return { error: 'Filesystem access is not available on this platform' }
      const approved =
        alreadyApproved ||
        (await requestFileMutationApproval(
          toolOptions.toolCallId,
          `Write file: ${writeInput.file_path}`,
          previewContent(writeInput.content)
        ))
      if (!approved) return { success: false, error: 'File write denied by user.' }
      const result = await platform.fsWrite({ filePath: writeInput.file_path, content: writeInput.content })
      return result.success ? { success: true, file_path: writeInput.file_path } : { error: result.error }
    },
  }

  const edit_file: ToolSet[string] = {
    description:
      'Edit a file with one or more exact search-and-replace edits. Prefer edits[] for multiple changes in one call. Each old_text must be unique at the time it is applied. Relative sandbox paths are edited directly. Editing absolute user filesystem paths requires user approval.',
    inputSchema: editFileInputSchema,
    execute: async (input, toolOptions) => {
      const editInput = input as EditFileInput
      const alreadyApproved = (toolOptions as typeof toolOptions & { approved?: boolean }).approved
      const validatedInput = validateEditInput(editInput)
      if ('error' in validatedInput) return { error: validatedInput.error }
      const { edits } = validatedInput
      if (await shouldUseSandbox(context, editInput.file_path)) {
        const result = await editSandboxFile(context, editInput.file_path, edits)
        return result.success
          ? { success: true, file_path: editInput.file_path, edits: edits.length }
          : { error: result.error }
      }
      const pathError = requireAbsoluteRealPath(editInput.file_path)
      if (pathError) return pathError
      if (!platform.fsEdit) return { error: 'Filesystem access is not available on this platform' }
      const approved =
        alreadyApproved ||
        (await requestFileMutationApproval(
          toolOptions.toolCallId,
          edits.length === 1
            ? `Edit file: ${editInput.file_path}`
            : `Edit file: ${editInput.file_path} (${edits.length} edits)`,
          previewEdits(edits)
        ))
      if (!approved) return { success: false, error: 'File edit denied by user.' }
      const result = await platform.fsEdit({
        filePath: editInput.file_path,
        edits: edits.map((edit) => ({ search: edit.old_text, replace: edit.new_text })),
      })
      return result.success
        ? { success: true, file_path: editInput.file_path, edits: edits.length }
        : { error: result.error }
    },
  }

  return {
    tools: {
      list_files,
      search_files,
      write_file,
      edit_file,
    },
    description: `
## Filesystem
Use these tools when you need to inspect or modify files.
- Relative paths are resolved in the session sandbox and can be written or edited without confirmation.
- Absolute paths access the user's real filesystem. Read/list/search only when the user provided or clearly requested the path.
- Writing or editing an absolute user filesystem path requires user approval. Do not attempt destructive operations; file deletion is not available.
- Keep tool results small. For large generated outputs, write a file and return a path plus a short summary.
`,
  }
}
