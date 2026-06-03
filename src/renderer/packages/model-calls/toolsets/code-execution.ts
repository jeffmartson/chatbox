import { isTextFilePath } from '@shared/file-extensions'
import { DEFAULT_EXEC_TIMEOUT, type SandboxProvider } from '@shared/sandbox-provider'
import { escapeSingleQuotes } from '@shared/utils/shell'
import { jsonSchema, type ToolSet } from 'ai'
import { getLogger } from '@/lib/utils'
import platform from '@/platform'

const log = getLogger('toolset:code-execution')

const MAX_STDOUT_LENGTH = 50_000

interface CodeExecutionContext {
  sessionId: string
  files: Array<{ storageKey: string; rawStorageKey?: string; name: string }>
  provider: SandboxProvider
}

function truncateOutput(output: string, maxLength = MAX_STDOUT_LENGTH): string {
  if (output.length <= maxLength) return output
  const half = Math.floor(maxLength / 2)
  return `${output.slice(0, half)}\n\n... [truncated ${output.length - maxLength} characters] ...\n\n${output.slice(-half)}`
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)
}

function isInsideRoot(root: string, filePath: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  return filePath === root || filePath.startsWith(normalizedRoot)
}

/**
 * Build code execution tools for a session.
 * Returns tool definitions and a system prompt description.
 */
export function buildCodeExecutionTools(context: CodeExecutionContext): { tools: ToolSet; description: string } {
  const { provider, files } = context
  let sandboxInitialized = false
  let filesSeeded = false
  let initPromise: Promise<{ success: boolean; error?: string }> | null = null

  /**
   * Lazy initialization: init sandbox + copy files on first tool call.
   * Uses a promise lock to prevent concurrent init from parallel tool calls.
   */
  async function ensureSandbox(): Promise<{ success: boolean; error?: string }> {
    if (sandboxInitialized && filesSeeded) {
      return { success: true }
    }

    if (initPromise) return initPromise
    initPromise = doInit()
    try {
      return await initPromise
    } finally {
      initPromise = null
    }
  }

  async function doInit(): Promise<{ success: boolean; error?: string }> {
    if (!sandboxInitialized) {
      const initResult = await provider.init(context.sessionId)
      if (!initResult.success) {
        return { success: false, error: `Sandbox init failed: ${initResult.error}` }
      }
      sandboxInitialized = true
    }

    if (!filesSeeded && files.length > 0) {
      // Copy files into sandbox with concurrency limit to avoid overwhelming IPC
      const MAX_CONCURRENT = 5
      const copyResults: Array<{ name: string; success: boolean; error?: string }> = []

      // Build copy tasks: original file + parsed text for non-text files
      const copyTasks: Array<{ blobKey: string; targetName: string; label: string }> = []
      for (const file of files) {
        const key = file.rawStorageKey || file.storageKey
        copyTasks.push({ blobKey: key, targetName: file.name, label: file.name })

        // For non-text files (PDF, DOCX, etc.), also copy pre-parsed text as {name}_parsed.txt
        if (!isTextFilePath(file.name) && file.rawStorageKey && file.storageKey) {
          const parsedName = `${file.name}_parsed.txt`
          copyTasks.push({ blobKey: file.storageKey, targetName: parsedName, label: parsedName })
        }
      }

      for (let i = 0; i < copyTasks.length; i += MAX_CONCURRENT) {
        const batch = copyTasks.slice(i, i + MAX_CONCURRENT)
        const batchResults = await Promise.all(
          batch.map(async (task) => {
            try {
              const result = await provider.copyBlobIn(task.blobKey, task.targetName)
              return { name: task.label, success: result.success, error: result.error }
            } catch (err) {
              log.error(`Failed to copy file ${task.label} to sandbox:`, err)
              return { name: task.label, success: false, error: String(err) }
            }
          })
        )
        copyResults.push(...batchResults)
      }

      const failures = copyResults.filter((r) => !r.success)
      if (failures.length > 0) {
        log.warn(`Some files failed to copy: ${failures.map((f) => f.name).join(', ')}`)
      }

      // Only mark seeded if all files copied successfully, so we can retry on next call
      if (failures.length === 0) {
        filesSeeded = true
      }
    }

    return { success: true }
  }

  const code_execution: ToolSet[string] = {
    description:
      'Run short Node.js or Bash code in a sandbox for lightweight file processing, data analysis, ' +
      'calculations, simple HTML/SVG/Canvas chart generation, and file conversion. Prefer Node.js built-ins ' +
      'and shell tools. Avoid installing packages or creating projects unless the user explicitly asks for ' +
      'that and the task cannot be completed with the available runtime. Generated files can be made ' +
      'downloadable via create_download.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code to execute',
        },
        language: {
          type: 'string',
          enum: ['node', 'bash'],
          default: 'node',
          description: 'Programming language',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default: 120000)',
        },
      },
      required: ['code'],
      additionalProperties: false,
    }),
    execute: async (input, { abortSignal }) => {
      const codeInput = input as { code: string; language?: 'node' | 'bash'; timeout?: number }
      const setupResult = await ensureSandbox()
      if (!setupResult.success) {
        return { stdout: '', stderr: setupResult.error || 'Sandbox setup failed', exitCode: 1 }
      }

      if (abortSignal?.aborted) {
        return { stdout: '', stderr: '[Cancelled]', exitCode: 130 }
      }

      const result = await provider.exec({
        code: codeInput.code,
        language: codeInput.language ?? 'node',
        timeout: codeInput.timeout ?? DEFAULT_EXEC_TIMEOUT,
      })

      return {
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
        exitCode: result.exitCode,
      }
    },
  }

  const READ_FILE_MAX_LINES = 2000
  const READ_FILE_DEFAULT_LINES = 500

  const read_file: ToolSet[string] = {
    description:
      'Read the content of a file in the sandbox working directory, or an absolute user filesystem path when explicitly provided. ' +
      'For document files (PDF, DOCX, etc.), read the path from <PARSED_SANDBOX_PATH> instead of the binary. ' +
      'Output is truncated to fit context. Use offset to continue reading large files.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to file in the sandbox working directory, or an absolute user filesystem path',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description: 'Line number to start reading from (1-indexed). Defaults to 1.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: READ_FILE_MAX_LINES,
          description: `Max number of lines to read. Defaults to ${READ_FILE_DEFAULT_LINES}, max ${READ_FILE_MAX_LINES}.`,
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const readInput = input as { file_path: string; offset?: number; limit?: number }
      if (isAbsolutePath(readInput.file_path)) {
        const status = await provider.getStatus().catch(() => null)
        const sandboxRoot = status?.workingDirectory
        if ((!sandboxRoot || !isInsideRoot(sandboxRoot, readInput.file_path)) && platform.fsRead) {
          const result = await platform.fsRead({
            filePath: readInput.file_path,
            offset: readInput.offset,
            limit: readInput.limit,
          })
          if (!result.success) return { error: result.error || `File not found: ${readInput.file_path}` }
          const hasMore = !!result.endLine && !!result.totalLines && result.endLine < result.totalLines
          return {
            file_path: readInput.file_path,
            content: truncateOutput(result.content ?? '', MAX_STDOUT_LENGTH),
            startLine: result.startLine,
            endLine: result.endLine,
            totalLines: result.totalLines,
            ...(hasMore
              ? {
                  hint: `[Showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Use offset=${(result.endLine ?? 0) + 1} to continue.]`,
                }
              : {}),
          }
        }
      }

      const setupResult = await ensureSandbox()
      if (!setupResult.success) {
        return { error: setupResult.error || 'Sandbox setup failed' }
      }

      const startLine = readInput.offset ?? 1
      const limit = readInput.limit ?? READ_FILE_DEFAULT_LINES
      const escapedPath = escapeSingleQuotes(readInput.file_path)
      // Coerce to safe integers
      const safeStart = Math.max(1, Math.floor(Number(startLine)))
      const safeLimit = Math.max(1, Math.floor(Number(limit)))

      // Use sed for line-based extraction + wc -l for total line count
      const safeEnd = safeStart + safeLimit - 1
      const result = await provider.exec({
        code: `FILE='${escapedPath}'; if [ ! -f "$FILE" ]; then exit 1; else TOTAL=$(wc -l < "$FILE" | tr -d ' '); echo "$TOTAL"; sed -n '${safeStart},${safeEnd}p' "$FILE"; fi`,
        language: 'bash',
        timeout: 10_000,
      })

      if (result.exitCode !== 0) {
        return { error: `File not found: ${readInput.file_path}` }
      }

      const stdout = result.stdout
      const newlineIdx = stdout.indexOf('\n')
      const totalLines = Number.parseInt(stdout.slice(0, newlineIdx).trim(), 10)
      // Remove trailing newline added by sed to avoid phantom empty line in split
      const rawContent = stdout.slice(newlineIdx + 1)
      const content = rawContent.endsWith('\n') ? rawContent.slice(0, -1) : rawContent
      const outputLines = content === '' ? 0 : content.split('\n').length

      if (safeStart > totalLines) {
        return { error: `Offset ${safeStart} is beyond end of file (${totalLines} lines total)` }
      }

      // Cap endLine to totalLines (sed may match beyond wc -l count for files without trailing newline)
      const endLine = Math.min(safeStart + outputLines - 1, totalLines)
      const hasMore = endLine < totalLines

      return {
        file_path: readInput.file_path,
        content: truncateOutput(content, MAX_STDOUT_LENGTH),
        startLine: safeStart,
        endLine,
        totalLines,
        ...(hasMore
          ? { hint: `[Showing lines ${safeStart}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]` }
          : {}),
      }
    },
  }

  const create_download: ToolSet[string] = {
    description:
      'Mark a file in the sandbox as downloadable. Returns metadata for rendering a download button. ' +
      'Use after generating files (PDFs, charts, spreadsheets, etc.) with code_execution.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file in the sandbox working directory',
        },
        display_name: {
          type: 'string',
          description: 'Display name for the download button',
        },
      },
      required: ['file_path', 'display_name'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const downloadInput = input as { file_path: string; display_name: string }
      // Verify the file exists and resolve to absolute path (so download survives app restart)
      const escapedPath = escapeSingleQuotes(downloadInput.file_path)
      const checkResult = await provider.exec({
        code: `test -f '${escapedPath}' && realpath '${escapedPath}' || echo "not_found"`,
        language: 'bash',
        timeout: 5000,
      })
      const resolved = checkResult.stdout.trim()
      if (!resolved || resolved === 'not_found') {
        return { error: `File not found: ${downloadInput.file_path}` }
      }

      return {
        downloadable: true,
        file_path: resolved,
        display_name: downloadInput.display_name,
        provider_type: provider.type,
      }
    },
  }

  const description = `
## Code Execution
You have access to a sandboxed environment for lightweight code execution and file processing. Use it primarily for concrete tasks such as calculating spreadsheet data, cleaning CSV/JSON files, extracting document information, creating simple charts, converting files, and producing downloadable outputs.
Uploaded files are described in <ATTACHMENT_FILE> tags. In sandbox mode, those tags include <SANDBOX_PATH> for the original file and, when available, <PARSED_SANDBOX_PATH> for extracted document text.

### Available Runtime
- Bash
- Node.js

Use the preinstalled runtime first:
- CSV/TSV/JSON/table calculations: use Node.js built-ins such as fs, path, stream, readline, URL, TextDecoder, Intl, crypto, zlib, and child_process when needed.
- XLSX, DOCX, PPTX, PDF, and image files: prefer <PARSED_SANDBOX_PATH> for extracted text. If direct binary manipulation requires unavailable libraries, explain the limitation or produce a text/CSV/HTML alternative.
- Charts and visual outputs: generate standalone HTML with inline SVG or Canvas. Keep JavaScript, CSS, and small data inline in the HTML instead of referencing sibling .js/.css/data files. Save the HTML file, then call create_download when the user needs the result. Do not rely on Python plotting libraries.
- File outputs: prefer CSV, JSON, Markdown, HTML, or other text-based formats that can be generated with Node.js or Bash.
- Python is not available in this code_execution tool; choose Node.js or Bash.

### Package Installation
Avoid installing packages. Most simple file-processing tasks should be completed with Node.js built-ins and shell tools.
If a package install seems necessary:
- First try an approach using the preinstalled runtime.
- Do not use sudo, apt, brew, or other system package managers.
- Be aware that network access, package indexes, npm scripts, native builds, or compiler toolchains may be unavailable, slow, or blocked in the sandbox.
- Installed packages, if any, are session-local and may be lost after the session.
- Explain the limitation to the user instead of spending tool calls on setup when the task is simple.

### read_file
Read file content from the sandbox with line-based pagination.
- Use \`offset\` (1-indexed line number) and \`limit\` (number of lines) to read large files in chunks.
- **Text files** (code, markdown, CSV, etc.): read the path in <SANDBOX_PATH> directly.
- **Document files** (PDF, DOCX, XLSX, PPTX, etc.): when <PARSED_SANDBOX_PATH> is present, read that file to get extracted text. The original binary at <SANDBOX_PATH> is also present if you need to process it with code_execution.
- Absolute paths outside the sandbox may read user filesystem files when the user provided or clearly requested that path. Use write_file/edit_file for modifications so the user can approve real filesystem changes.

### code_execution
Execute focused Node.js or Bash snippets. Keep scripts small and task-oriented:
- Use Node.js for most file-processing tasks.
- Read uploaded files from <SANDBOX_PATH> or <PARSED_SANDBOX_PATH>; do not guess alternate filenames.
- Prefer producing explicit result files for transformed data, reports, charts, or exports.
- Avoid long-running services, project scaffolding, dependency installation, and broad environment exploration.

### create_download
After generating a file with code_execution, use this to make it downloadable.
The user will see a download button in the chat.
`

  return {
    tools: {
      read_file,
      code_execution,
      create_download,
    },
    description,
  }
}
