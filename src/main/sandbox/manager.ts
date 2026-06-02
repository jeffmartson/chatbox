import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import {
  copyFile as fsCopyFile,
  lstat as fsLstat,
  readFile as fsReadFile,
  realpath as fsRealpath,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { app } from 'electron'
import {
  TASK_SANDBOX_DENY_READ_PATHS,
  TASK_SANDBOX_DENY_WRITE_PATHS,
  TASK_SANDBOX_EXTRA_WRITE_PATHS,
} from '../../shared/task-sandbox'
import { shellQuote } from '../../shared/utils/shell'
import { getLogger } from '../util'
import { headTruncate, tailTruncate } from './truncate'

const log = getLogger('sandbox:manager')

type SandboxState = 'idle' | 'initialized'

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface ExecOptions {
  timeout?: number
  cwd?: string
}

interface SandboxStatus {
  state: SandboxState
  workingDirectory: string | null
  platform: string
}

// ─── Per-session sandbox instances ───────────────────────────────────

interface SandboxSession {
  state: SandboxState
  workingDirectory: string | null
  runningChild: ChildProcess | null
  /** Per-session sandbox config for wrapWithSandbox customConfig override */
  sandboxConfig: ReturnType<typeof buildConfig> | null
}

// Global SandboxManager ref — initialized once, shared across sessions
let globalSandboxManager: typeof import('@anthropic-ai/sandbox-runtime')['SandboxManager'] | null = null
let globalInitialized = false

const sessions = new Map<string, SandboxSession>()

const DEFAULT_SESSION = '__default__'

function getSession(sessionId?: string): SandboxSession | undefined {
  return sessions.get(sessionId || DEFAULT_SESSION)
}

function getOrCreateSession(sessionId?: string): SandboxSession {
  const id = sessionId || DEFAULT_SESSION
  let session = sessions.get(id)
  if (!session) {
    session = {
      state: 'idle',
      workingDirectory: null,
      runningChild: null,
      sandboxConfig: null,
    }
    sessions.set(id, session)
  }
  return session
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Resolve symlinks, falling back to path.normalize if the path doesn't exist. */
function safeRealpathSync(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.normalize(p)
  }
}

function toWSLPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/')
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`
  }
  return normalized
}

function buildConfig(workDir: string): Omit<SandboxRuntimeConfig, 'network'> & {
  network: Omit<SandboxRuntimeConfig['network'], 'allowedDomains'>
} {
  const isMacOS = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  const resolvedDir = isWindows ? toWSLPath(workDir) : workDir
  const tempWritePaths = isWindows ? [] : [tmpdir(), '/tmp'].flatMap((p) => [p, safeRealpathSync(p)])
  const allowWrite = [...new Set([resolvedDir, ...TASK_SANDBOX_EXTRA_WRITE_PATHS, ...tempWritePaths])]

  // WARN: `allowedDomains: ['*']` is NOT a wildcard — it's a literal match.
  // Omit `allowedDomains` so wrapWithSandbox generates `(allow network*)`.
  return {
    ...(isMacOS ? { ripgrep: { command: 'sh' } } : {}),
    network: {
      deniedDomains: [] as string[],
    },
    filesystem: {
      denyRead: [...TASK_SANDBOX_DENY_READ_PATHS],
      allowWrite,
      denyWrite: [...TASK_SANDBOX_DENY_WRITE_PATHS],
    },
  }
}

function getSandboxRuntimeImportTarget(): string {
  if (!app.isPackaged) {
    return '@anthropic-ai/sandbox-runtime'
  }

  const candidateEntries = [
    path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'sandbox-runtime',
      'dist',
      'index.js'
    ),
    path.join(
      process.resourcesPath,
      'app.asar',
      'node_modules',
      '@anthropic-ai',
      'sandbox-runtime',
      'dist',
      'index.js'
    ),
  ]

  for (const candidate of candidateEntries) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href
    }
  }

  return '@anthropic-ai/sandbox-runtime'
}

/** @deprecated Use shellQuote from '@shared/utils/shell' instead. Kept for backwards compat. */
export const shellEscape = shellQuote

/**
 * Validate that a resolved target path is inside the sandbox working directory.
 * Defense-in-depth: also checks for symlinks that could redirect writes outside the sandbox.
 */
export async function validateWritePath(
  resolved: string,
  workDir: string
): Promise<{ valid: boolean; error?: string }> {
  if (!resolved.startsWith(workDir + path.sep) && resolved !== workDir) {
    return { valid: false, error: 'Invalid path: outside sandbox' }
  }
  // Check if any component is a symlink pointing outside the sandbox
  if (existsSync(resolved)) {
    try {
      const stat = await fsLstat(resolved)
      if (stat.isSymbolicLink()) {
        const realTarget = await fsRealpath(resolved)
        if (!realTarget.startsWith(workDir + path.sep) && realTarget !== workDir) {
          return { valid: false, error: 'Invalid path: symlink target is outside sandbox' }
        }
      }
    } catch {
      // If lstat fails, the file doesn't exist yet — that's OK for new files
    }
  }
  return { valid: true }
}

/**
 * Write content to a file, handling data URLs (base64) and plain text.
 * Creates parent directories as needed.
 */
async function writeContentToFile(targetPath: string, content: string): Promise<void> {
  const parentDir = path.dirname(targetPath)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }
  if (content.startsWith('data:')) {
    const base64Match = content.match(/^data:[^;]*;base64,(.*)$/)
    if (base64Match) {
      const buffer = Buffer.from(base64Match[1], 'base64')
      await fsWriteFile(targetPath, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
    } else {
      const commaIndex = content.indexOf(',')
      await fsWriteFile(targetPath, commaIndex >= 0 ? content.slice(commaIndex + 1) : content, 'utf-8')
    }
  } else {
    await fsWriteFile(targetPath, content, 'utf-8')
  }
}

// ─── Sandbox lifecycle ───────────────────────────────────────────────

export async function initSandbox(workDir: string, sessionId?: string): Promise<{ success: boolean; error?: string }> {
  let session = getOrCreateSession(sessionId)

  if (session.state === 'initialized') {
    log.info(`Sandbox session ${sessionId || DEFAULT_SESSION} already initialized, resetting first`)
    await resetSandbox(sessionId)
    // resetSandbox deletes the session from the Map, so re-create it
    session = getOrCreateSession(sessionId)
  }

  try {
    // Initialize the global SandboxManager once (shared across sessions).
    // Per-session config is passed via customConfig to wrapWithSandbox().
    if (!globalSandboxManager) {
      const { SandboxManager } = await import(getSandboxRuntimeImportTarget())
      globalSandboxManager = SandboxManager
    }

    const config = buildConfig(workDir)
    log.info(
      `Initializing sandbox session=${sessionId || DEFAULT_SESSION} workDir=${workDir} platform=${process.platform}`
    )

    if (!globalInitialized && globalSandboxManager) {
      await globalSandboxManager.initialize(config as Parameters<typeof globalSandboxManager.initialize>[0])
      globalInitialized = true
    }

    session.sandboxConfig = config
    session.workingDirectory = workDir
    session.state = 'initialized'
    log.info(`Sandbox session ${sessionId || DEFAULT_SESSION} initialized successfully`)
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('Sandbox initialization failed:', msg)
    return { success: false, error: msg }
  }
}

export async function execCommand(
  command: string,
  options?: ExecOptions & { sessionId?: string }
): Promise<ExecResult> {
  const session = getSession(options?.sessionId)
  if (!session || session.state !== 'initialized' || !globalSandboxManager) {
    throw new Error('Sandbox not initialized. Call initSandbox first.')
  }

  // Pass per-session config as customConfig so each session's allowWrite is respected
  const customConfig = session.sandboxConfig as Parameters<typeof globalSandboxManager.wrapWithSandbox>[2]
  const wrappedCommand = await globalSandboxManager.wrapWithSandbox(command, undefined, customConfig)
  const cwd = options?.cwd ?? session.workingDirectory ?? undefined
  const timeout = options?.timeout ?? 30_000

  const MAX_BUFFER_BYTES = 10 * 1024 * 1024 // 10MB cap to prevent OOM from runaway output

  return new Promise((resolve, reject) => {
    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutCapped = false
    let stderrCapped = false

    const env = { ...process.env }
    if (session.workingDirectory) {
      const cacheDir = path.join(session.workingDirectory, '.cache')
      mkdirSync(cacheDir, { recursive: true })
      env.XDG_CACHE_HOME = cacheDir
      env.TMPDIR = session.workingDirectory
      env.TMP = session.workingDirectory
      env.TEMP = session.workingDirectory
    }

    const child = spawn(wrappedCommand, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
    })
    session.runningChild = child

    let timedOut = false
    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      } else {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        } else {
          child.kill('SIGKILL')
        }
      }, 3_000)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeout)

    child.stdout.on('data', (chunk: Uint8Array) => {
      if (!stdoutCapped) {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_BUFFER_BYTES) {
          stdoutCapped = true
        } else {
          stdoutChunks.push(chunk)
        }
      }
    })
    child.stderr.on('data', (chunk: Uint8Array) => {
      if (!stderrCapped) {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_BUFFER_BYTES) {
          stderrCapped = true
        } else {
          stderrChunks.push(chunk)
        }
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      session.runningChild = null
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      session.runningChild = null
      let stdout = tailTruncate(Buffer.concat(stdoutChunks).toString('utf-8'))
      let stderr = tailTruncate(Buffer.concat(stderrChunks).toString('utf-8'))
      const exitCode = timedOut ? 124 : (code ?? 1)

      if (stdoutCapped) {
        stdout += `\n[Output truncated: exceeded ${MAX_BUFFER_BYTES / 1024 / 1024}MB buffer limit]`
      }
      if (stderrCapped) {
        stderr += `\n[Stderr truncated: exceeded ${MAX_BUFFER_BYTES / 1024 / 1024}MB buffer limit]`
      }
      if (timedOut) {
        stderr += `\n[Process timed out after ${timeout}ms]`
      }
      resolve({ stdout, stderr, exitCode })
    })
  })
}

export function killRunningCommand(sessionId?: string): { killed: boolean } {
  const session = getSession(sessionId)
  if (!session) return { killed: false }

  const child = session.runningChild
  if (child && !child.killed) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    } else {
      child.kill('SIGTERM')
    }
    log.info(`Killed running sandbox command for session ${sessionId || DEFAULT_SESSION}`)
    return { killed: true }
  }
  return { killed: false }
}

// ─── File operations ─────────────────────────────────────────────────

export async function readFile(
  filePath: string,
  sessionId?: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const result = await execCommand(`cat ${shellEscape(filePath)}`, { sessionId })
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `Exit code ${result.exitCode}` }
    }
    return { success: true, content: headTruncate(result.stdout) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeFile(
  filePath: string,
  content: string,
  sessionId?: string
): Promise<{ success: boolean; error?: string }> {
  const session = getSession(sessionId)
  if (!session?.workingDirectory) {
    return { success: false, error: 'Sandbox not initialized' }
  }
  try {
    // Write directly via fs to avoid ARG_MAX limits with shell commands.
    // Resolve path relative to sandbox working directory.
    const resolved = path.resolve(session.workingDirectory, filePath)
    const validation = await validateWritePath(resolved, session.workingDirectory)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }
    const parentDir = path.dirname(resolved)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }
    await fsWriteFile(resolved, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function editFile(
  filePath: string,
  input: {
    search?: string
    replace?: string
    edits?: Array<{ search: string; replace: string }>
  },
  sessionId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const edits = input.edits?.length
      ? input.edits
      : input.search !== undefined && input.replace !== undefined
        ? [{ search: input.search, replace: input.replace }]
        : []
    if (edits.length === 0) {
      return { success: false, error: 'No edits provided' }
    }
    const session = getSession(sessionId)
    if (!session?.workingDirectory) {
      return { success: false, error: 'Sandbox not initialized' }
    }
    const resolved = path.resolve(session.workingDirectory, filePath)
    const validation = await validateWritePath(resolved, session.workingDirectory)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }
    let text = await fsReadFile(resolved, 'utf-8')
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]
      const first = text.indexOf(edit.search)
      if (first === -1) {
        return { success: false, error: `Edit ${index + 1}: search text not found` }
      }
      if (text.indexOf(edit.search, first + edit.search.length) !== -1) {
        return { success: false, error: `Edit ${index + 1}: search text is not unique` }
      }
      text = text.slice(0, first) + edit.replace + text.slice(first + edit.search.length)
    }
    await fsWriteFile(resolved, text, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function listDir(
  dirPath: string,
  sessionId?: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const result = await execCommand(`ls -la ${shellEscape(dirPath)}`, { sessionId })
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `Exit code ${result.exitCode}` }
    }
    return { success: true, content: headTruncate(result.stdout) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function grepFiles(
  pattern: string,
  dirPath?: string,
  options?: { include?: string },
  sessionId?: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const target = dirPath ? shellEscape(dirPath) : '.'
    const includeFlag = options?.include ? `--include=${shellEscape(options.include)}` : ''
    const result = await execCommand(`grep -rn ${includeFlag} ${shellEscape(pattern)} ${target}`, { sessionId })
    // grep returns exit code 1 when no matches found — not an error
    if (result.exitCode > 1) {
      return { success: false, error: result.stderr || `Exit code ${result.exitCode}` }
    }
    return { success: true, content: headTruncate(result.stdout) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function findFiles(
  dirPath: string,
  pattern?: string,
  sessionId?: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const nameFlag = pattern ? `-name ${shellEscape(pattern)}` : ''
    const result = await execCommand(`find ${shellEscape(dirPath)} ${nameFlag} -type f`, { sessionId })
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `Exit code ${result.exitCode}` }
    }
    return { success: true, content: headTruncate(result.stdout) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ─── Sandbox lifecycle (continued) ───────────────────────────────────

export async function resetSandbox(sessionId?: string): Promise<{ success: boolean; error?: string }> {
  const id = sessionId || DEFAULT_SESSION
  const session = sessions.get(id)
  if (!session) {
    return { success: true }
  }

  try {
    killRunningCommand(sessionId)
    sessions.delete(id)
    log.info(`Sandbox session ${id} reset`)
    return { success: true }
  } catch (error) {
    sessions.delete(id)
    const msg = error instanceof Error ? error.message : String(error)
    log.error('Sandbox reset error:', msg)
    return { success: false, error: msg }
  }
}

/** Reset all active sandbox sessions. Called on app quit to clean up. */
export async function resetAllSessions(): Promise<void> {
  const ids = [...sessions.keys()]
  for (const id of ids) {
    try {
      killRunningCommand(id)
      sessions.delete(id)
    } catch {
      sessions.delete(id)
    }
  }
  if (ids.length > 0) {
    log.info(`Cleaned up ${ids.length} sandbox session(s) on quit`)
  }
}

export function getStatus(sessionId?: string): SandboxStatus {
  const session = getSession(sessionId)
  return {
    state: session?.state ?? 'idle',
    workingDirectory: session?.workingDirectory ?? null,
    platform: process.platform,
  }
}

export async function checkAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (process.platform === 'darwin') {
    return { available: true }
  }

  if (process.platform === 'linux') {
    // Linux sandbox-runtime requires bubblewrap (bwrap) and socat
    try {
      if (!globalSandboxManager) {
        const { SandboxManager } = await import(getSandboxRuntimeImportTarget())
        globalSandboxManager = SandboxManager
      }
      const deps = globalSandboxManager!.checkDependencies()
      if (deps.errors.length > 0) {
        return { available: false, reason: `Missing Linux dependencies: ${deps.errors.join('; ')}` }
      }
      return { available: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { available: false, reason: `Dependency check failed: ${msg}` }
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
        const child = spawn('wsl', ['--status'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Uint8Array[] = []
        child.stdout.on('data', (c: Uint8Array) => chunks.push(c))
        child.on('error', reject)
        child.on('close', (code) => resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), exitCode: code ?? 1 }))
      })
      if (result.exitCode === 0) {
        return { available: true }
      }
      return { available: false, reason: 'wsl2_required' }
    } catch {
      return { available: false, reason: 'wsl2_required' }
    }
  }

  return { available: false, reason: `Unsupported platform: ${process.platform}` }
}

// ─── Temp directory management ───────────────────────────────────────

/**
 * Initialize a sandbox with a temporary directory for a given session.
 * Creates os.tmpdir()/chatbox-sandbox/<sessionId>/ as the working directory.
 */
export async function initSandboxWithTempDir(
  sessionId: string
): Promise<{ success: boolean; workingDirectory?: string; error?: string }> {
  // Validate sessionId to prevent path traversal
  if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return { success: false, error: 'Invalid session ID' }
  }

  const tempBase = path.join(tmpdir(), 'chatbox-sandbox', sessionId)
  try {
    mkdirSync(tempBase, { recursive: true })
    const result = await initSandbox(tempBase, sessionId)
    if (result.success) {
      return { success: true, workingDirectory: tempBase }
    }
    return result
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('initSandboxWithTempDir failed:', msg)
    return { success: false, error: msg }
  }
}

/**
 * Copy a file into the sandbox working directory.
 * Content can be a data URL (base64 encoded) or plain text.
 */
export async function copyFileToSandbox(
  content: string,
  targetFilename: string,
  sessionId?: string
): Promise<{ success: boolean; sandboxPath?: string; error?: string }> {
  const session = getSession(sessionId)
  if (!session?.workingDirectory) {
    return { success: false, error: 'Sandbox not initialized' }
  }

  const workDir = session.workingDirectory

  // Reject empty or invalid filenames
  if (!targetFilename || targetFilename === '.' || targetFilename === '..') {
    return { success: false, error: 'Invalid filename' }
  }

  // Prevent path traversal (with symlink check)
  const targetPath = path.resolve(workDir, targetFilename)
  const validation = await validateWritePath(targetPath, workDir)
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Invalid filename: path traversal detected' }
  }

  try {
    await writeContentToFile(targetPath, content)
    return { success: true, sandboxPath: targetPath }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('copyFileToSandbox failed:', msg)
    return { success: false, error: msg }
  }
}

/**
 * Copy a file from the blob store directly into the sandbox working directory.
 * Reads the blob from disk in the main process — avoids sending large content through IPC.
 */
export async function copyBlobToSandbox(
  blobKey: string,
  targetFilename: string,
  sessionId?: string
): Promise<{ success: boolean; sandboxPath?: string; error?: string }> {
  const session = getSession(sessionId)
  if (!session?.workingDirectory) {
    return { success: false, error: 'Sandbox not initialized' }
  }

  const workDir = session.workingDirectory

  // Reject empty or invalid filenames
  if (!targetFilename || targetFilename === '.' || targetFilename === '..') {
    return { success: false, error: 'Invalid filename' }
  }

  // Prevent path traversal (with symlink check)
  const targetPath = path.resolve(workDir, targetFilename)
  const validation = await validateWritePath(targetPath, workDir)
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Invalid filename: path traversal detected' }
  }

  try {
    // Read blob content directly from the store on disk
    const { getStoreBlob } = await import('../store-node')
    const content = await getStoreBlob(blobKey)
    if (!content) {
      return { success: false, error: `Blob not found for key: ${blobKey}` }
    }

    await writeContentToFile(targetPath, content)
    return { success: true, sandboxPath: targetPath }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('copyBlobToSandbox failed:', msg)
    return { success: false, error: msg }
  }
}

/**
 * Export a file from the sandbox to a user-chosen location.
 * Opens a save dialog and copies the file.
 */
export async function exportFileFromSandbox(
  sandboxPath: string,
  suggestedName?: string
): Promise<{ success: boolean; localPath?: string; error?: string }> {
  try {
    const { dialog } = await import('electron')

    // Resolve path relative to a sandbox session's working directory.
    // Security: only files inside a sandbox working directory are allowed.
    let resolvedPath: string | null = null

    // Collect sandbox roots with symlinks resolved (macOS: /var → /private/var)
    const sandboxRoots: string[] = []
    for (const session of sessions.values()) {
      if (session.workingDirectory) {
        sandboxRoots.push(safeRealpathSync(session.workingDirectory))
      }
    }
    // Fallback: after app restart sessions Map is empty but sandbox temp dirs still exist on disk.
    if (sandboxRoots.length === 0) {
      sandboxRoots.push(safeRealpathSync(path.join(tmpdir(), 'chatbox-sandbox')))
    }

    if (path.isAbsolute(sandboxPath)) {
      resolvedPath = safeRealpathSync(sandboxPath)
    } else {
      for (const session of sessions.values()) {
        if (session.workingDirectory) {
          const candidate = path.join(session.workingDirectory, sandboxPath)
          if (existsSync(candidate)) {
            resolvedPath = safeRealpathSync(candidate)
            break
          }
        }
      }
    }

    if (!resolvedPath) {
      return { success: false, error: 'Cannot resolve relative path: sandbox not initialized' }
    }

    // Security: ensure resolved path is inside a known sandbox working directory
    const isInsideSandbox = sandboxRoots.some(
      (root) => resolvedPath === root || resolvedPath!.startsWith(root + path.sep)
    )
    if (!isInsideSandbox) {
      return { success: false, error: 'Access denied: path is outside the sandbox' }
    }

    if (!existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${sandboxPath}` }
    }

    const defaultPath = suggestedName || path.basename(resolvedPath)
    const result = await dialog.showSaveDialog({
      defaultPath,
      title: 'Save File',
    })

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Save dialog cancelled' }
    }

    await fsCopyFile(resolvedPath, result.filePath)
    return { success: true, localPath: result.filePath }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('exportFileFromSandbox failed:', msg)
    return { success: false, error: msg }
  }
}

// ─── Temp directory cleanup ──────────────────────────────────────────

const SANDBOX_ROOT = path.join(tmpdir(), 'chatbox-sandbox')
const STALE_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Clean up stale sandbox temp directories older than 7 days.
 * Called on app startup.
 */
export function cleanupStaleSandboxDirs(): void {
  try {
    if (!existsSync(SANDBOX_ROOT)) return

    const now = Date.now()
    const entries = readdirSync(SANDBOX_ROOT)

    for (const entry of entries) {
      const dirPath = path.join(SANDBOX_ROOT, entry)
      try {
        const stat = statSync(dirPath)
        if (stat.isDirectory() && now - stat.mtimeMs > STALE_DIR_MAX_AGE_MS) {
          // Don't delete dirs belonging to active sessions
          if (!sessions.has(entry)) {
            rmSync(dirPath, { recursive: true, force: true })
            log.info(`Cleaned up stale sandbox dir: ${entry}`)
          }
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch (error) {
    log.error('Failed to clean up stale sandbox dirs:', error)
  }
}
