import type { SandboxProvider } from '@shared/sandbox-provider'
import { shellQuote } from '@shared/utils/shell'
import type { ToolSet } from 'ai'
import { tool } from 'ai'
import { z } from 'zod'
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

const editOperationsSchema = z
  .object({
    old_text: z.string().describe('Exact text to replace; must be unique within the current file content'),
    new_text: z.string().describe('Replacement text'),
  })
  .array()
  .min(1)

const editFileInputSchema = z
  .object({
    file_path: z.string().describe('File path to edit'),
    old_text: z.string().optional().describe('Legacy single edit: exact text to replace; must be unique'),
    new_text: z.string().optional().describe('Legacy single edit: replacement text'),
    edits: editOperationsSchema
      .optional()
      .describe('Multiple exact search-and-replace edits to apply atomically in order'),
  })
  .refine((input) => !!input.edits?.length || (input.old_text !== undefined && input.new_text !== undefined), {
    message: 'Provide either edits or old_text/new_text',
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
  const list_files = tool({
    description:
      'List files in a directory. Relative paths are resolved in the session sandbox. Absolute paths read the user filesystem.',
    inputSchema: z.object({
      path: z.string().describe('Directory path to list'),
    }),
    execute: async (input: { path: string }) => {
      if (await shouldUseSandbox(context, input.path)) {
        const setup = await ensureSandbox(context)
        if (!setup.success) return { error: setup.error }
        if (!context.provider) return { error: 'Sandbox is not available' }
        const result = await context.provider.exec({
          language: 'bash',
          code: `ls -la ${shellQuote(input.path)}`,
          timeout: 10_000,
        })
        return result.exitCode === 0 ? { content: result.stdout } : { error: result.stderr || result.stdout }
      }
      const pathError = requireAbsoluteRealPath(input.path)
      if (pathError) return pathError
      if (!platform.fsList) return { error: 'Filesystem access is not available on this platform' }
      const result = await platform.fsList({ dirPath: input.path })
      return result.success ? { content: result.content ?? '' } : { error: result.error }
    },
  })

  const search_files = tool({
    description:
      'Search text in files. Relative paths search the session sandbox. Absolute paths search the user filesystem.',
    inputSchema: z.object({
      path: z.string().describe('Directory path to search'),
      query: z.string().describe('Literal text to search for'),
      include: z.string().optional().describe('Optional file name filter, for example "*.ts"'),
    }),
    execute: async (input: { path: string; query: string; include?: string }) => {
      if (await shouldUseSandbox(context, input.path)) {
        const setup = await ensureSandbox(context)
        if (!setup.success) return { error: setup.error }
        const include = input.include ? ` --include=${shellQuote(input.include)}` : ''
        if (!context.provider) return { error: 'Sandbox is not available' }
        const result = await context.provider.exec({
          language: 'bash',
          code: `grep -RInF${include} -- ${shellQuote(input.query)} ${shellQuote(input.path)} | head -100`,
          timeout: 10_000,
        })
        return result.exitCode === 0 || result.exitCode === 1
          ? { content: result.stdout }
          : { error: result.stderr || result.stdout }
      }
      const pathError = requireAbsoluteRealPath(input.path)
      if (pathError) return pathError
      if (!platform.fsSearch) return { error: 'Filesystem access is not available on this platform' }
      const result = await platform.fsSearch({ dirPath: input.path, pattern: input.query, include: input.include })
      return result.success ? { content: result.content ?? '' } : { error: result.error }
    },
  })

  const write_file = tool({
    description:
      'Write a file. Relative sandbox paths are written directly. Writing absolute user filesystem paths requires user approval.',
    inputSchema: z.object({
      file_path: z.string().describe('File path to write'),
      content: z.string().describe('Full file content'),
    }),
    execute: async (
      input: { file_path: string; content: string },
      { toolCallId, approved: alreadyApproved }: { toolCallId: string; approved?: boolean }
    ) => {
      if (await shouldUseSandbox(context, input.file_path)) {
        const result = await writeSandboxFile(context, input.file_path, input.content)
        return result.success ? { success: true, file_path: input.file_path } : { error: result.error }
      }
      const pathError = requireAbsoluteRealPath(input.file_path)
      if (pathError) return pathError
      if (!platform.fsWrite) return { error: 'Filesystem access is not available on this platform' }
      const approved =
        alreadyApproved ||
        (await requestFileMutationApproval(toolCallId, `Write file: ${input.file_path}`, previewContent(input.content)))
      if (!approved) return { success: false, error: 'File write denied by user.' }
      const result = await platform.fsWrite({ filePath: input.file_path, content: input.content })
      return result.success ? { success: true, file_path: input.file_path } : { error: result.error }
    },
  })

  const edit_file = tool({
    description:
      'Edit a file with one or more exact search-and-replace edits. Prefer edits[] for multiple changes in one call. Each old_text must be unique at the time it is applied. Relative sandbox paths are edited directly. Editing absolute user filesystem paths requires user approval.',
    inputSchema: editFileInputSchema,
    execute: async (
      input: EditFileInput,
      { toolCallId, approved: alreadyApproved }: { toolCallId: string; approved?: boolean }
    ) => {
      const edits = normalizeEdits(input)
      if (await shouldUseSandbox(context, input.file_path)) {
        const result = await editSandboxFile(context, input.file_path, edits)
        return result.success
          ? { success: true, file_path: input.file_path, edits: edits.length }
          : { error: result.error }
      }
      const pathError = requireAbsoluteRealPath(input.file_path)
      if (pathError) return pathError
      if (!platform.fsEdit) return { error: 'Filesystem access is not available on this platform' }
      const approved =
        alreadyApproved ||
        (await requestFileMutationApproval(
          toolCallId,
          edits.length === 1
            ? `Edit file: ${input.file_path}`
            : `Edit file: ${input.file_path} (${edits.length} edits)`,
          previewEdits(edits)
        ))
      if (!approved) return { success: false, error: 'File edit denied by user.' }
      const result = await platform.fsEdit({
        filePath: input.file_path,
        edits: edits.map((edit) => ({ search: edit.old_text, replace: edit.new_text })),
      })
      return result.success
        ? { success: true, file_path: input.file_path, edits: edits.length }
        : { error: result.error }
    },
  })

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
