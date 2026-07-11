import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import {
  copyFile as fsCopyFile,
  lstat as fsLstat,
  readFile as fsReadFile,
  realpath as fsRealpath,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
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
import { buildSandboxStdinScript, stripCodesignNoise } from './exec-script'
import { headTruncate, tailTruncate } from './truncate'

const log = getLogger('sandbox:manager')

type SandboxState = 'idle' | 'initialized'

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface SandboxStatus {
  state: SandboxState
  workingDirectory: string | null
  platform: string
  homeDirectory: string
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

/** True if `cmd` resolves on PATH (Windows `where`). Used only on win32. */
function which(cmd: string): boolean {
  try {
    return spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/**
 * Resolve a POSIX shell for the `bash` code-execution language on native Windows.
 * Native Windows has no bash, so we use any `bash` on PATH (Git Bash / MSYS) and
 * fall back to WSL's bash. The script is fed via stdin, so the shell's path format
 * (C:\ vs /mnt/c) never matters. Returns null when none is available.
 */
export function resolveWindowsBash(): { cmd: string; args: string[] } | null {
  if (which('bash')) return { cmd: 'bash', args: [] }
  if (which('wsl')) return { cmd: 'wsl', args: ['bash'] }
  return null
}

/**
 * On Windows, bash (Git Bash / WSL / Cygwin) reports POSIX-style paths from `realpath`
 * (`/c/...`, `/mnt/c/...`, `/cygdrive/c/...`). Convert them back to native Windows form so
 * artifact validation against Windows roots works (e.g. create_download). No-op for paths
 * already in Windows form, for relative paths, and on non-Windows platforms.
 */
export function normalizeWindowsShellPath(p: string): string {
  if (process.platform !== 'win32') return p
  const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(\/.*)?$/)
  if (!m) return p
  const rest = (m[2] ?? '').replace(/\//g, '\\')
  return `${m[1].toUpperCase()}:${rest || '\\'}`
}

/**
 * Terminate a spawned child and its descendants across platforms.
 * POSIX: signal the detached process group (negative pid). Windows: `taskkill /T`
 * since detached process-group signalling does not exist there.
 */
export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        // taskkill failing (e.g. process already gone) surfaces as an async 'error'
        // event; swallow it so it never crashes the main process.
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
        return
      } catch {
        // fall through to child.kill
      }
    }
    child.kill(signal)
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  } else {
    child.kill(signal)
  }
}

// True when a resolved absolute path is the filesystem root, the user's home, an ancestor
// of home, or a system dir — granting no-approval sandbox write to any of these would
// defeat the agent-mode approval model.
function isUnsafeResolvedPath(resolved: string): boolean {
  if (!resolved || resolved === path.parse(resolved).root) return true
  const home = homedir()
  // candidate is home itself or an ancestor of home (e.g. /Users, /home)
  if (home && (resolved === home || pathContains(resolved, home))) return true
  const systemRoots = [
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    '/System',
    '/Library',
    '/private',
    '/boot',
    '/dev',
    '/proc',
    '/opt',
    '/root',
  ]
  return systemRoots.some((sys) => resolved === sys || pathContains(sys, resolved))
}

// Reject overly-broad or sensitive roots from being granted no-approval sandbox write.
// Checks BOTH the lexical path and its symlink-resolved real target, so a safe-looking
// symlink (e.g. /tmp/project -> $HOME) cannot smuggle a sensitive root into allowWrite
// (buildConfig adds the realpath variant to allowWrite).
function isUnsafeUserWriteDir(dir: string): boolean {
  let resolved: string
  try {
    resolved = path.resolve(dir)
  } catch {
    return true
  }
  if (isUnsafeResolvedPath(resolved)) return true
  const real = safeRealpathSync(resolved)
  return real !== resolved && isUnsafeResolvedPath(real)
}

// True when `child` is `parent` or lives under it (lexical, after resolution).
function pathContains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function buildConfig(
  workDir: string,
  // Extra real directories the user granted write access to (sandbox working-directory
  // feature). buildConfig is macOS/Linux-only (Windows skips SRT), so these are POSIX paths.
  userWritePaths: string[] = []
): Omit<SandboxRuntimeConfig, 'network'> & {
  network: Omit<SandboxRuntimeConfig['network'], 'allowedDomains'>
} {
  // buildConfig is only used by the macOS/Linux SRT path; Windows skips SRT (see initSandbox).
  const isMacOS = process.platform === 'darwin'
  const tempWritePaths = [tmpdir(), '/tmp'].flatMap((p) => [p, safeRealpathSync(p)])
  const safeUserPaths = userWritePaths.filter((p) => {
    if (isUnsafeUserWriteDir(p)) {
      log.warn(`Refusing to grant sandbox write access to unsafe directory: ${p}`)
      return false
    }
    return true
  })
  // Both the lexical and symlink-resolved forms of each granted dir.
  const userWriteVariants = safeUserPaths.flatMap((p) => [p, safeRealpathSync(p)])
  const allowWrite = [...new Set([workDir, ...TASK_SANDBOX_EXTRA_WRITE_PATHS, ...tempWritePaths, ...userWriteVariants])]

  // Protect sensitive files (.env, etc.) inside granted dirs with ABSOLUTE deny paths.
  // The bare relative patterns in TASK_SANDBOX_DENY_WRITE_PATHS are resolved by
  // sandbox-runtime against the main-process cwd, so they do NOT cover the granted dirs;
  // we must anchor them explicitly (top-level + nested via glob).
  const userDenyWrite = userWriteVariants.flatMap((base) =>
    TASK_SANDBOX_DENY_WRITE_PATHS.flatMap((name) => [`${base}/${name}`, `${base}/**/${name}`])
  )
  const denyWrite = [...new Set([...TASK_SANDBOX_DENY_WRITE_PATHS, ...userDenyWrite])]

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
      denyWrite,
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

export async function initSandbox(
  workDir: string,
  sessionId?: string,
  userWritePaths: string[] = []
): Promise<{ success: boolean; error?: string }> {
  let session = getOrCreateSession(sessionId)

  if (session.state === 'initialized') {
    log.info(`Sandbox session ${sessionId || DEFAULT_SESSION} already initialized, resetting first`)
    await resetSandbox(sessionId)
    // resetSandbox deletes the session from the Map, so re-create it
    session = getOrCreateSession(sessionId)
  }

  // Native Windows path: @anthropic-ai/sandbox-runtime only runs on macOS/Linux. On Windows
  // we execute code natively with NO OS sandbox (see docs/technical/windows-sandbox.md), so
  // skip SRT entirely and just record the working directory.
  if (process.platform === 'win32') {
    session.workingDirectory = workDir
    session.state = 'initialized'
    log.info(`Sandbox session ${sessionId || DEFAULT_SESSION} initialized (native Windows, no OS isolation)`)
    return { success: true }
  }

  try {
    // Initialize the global SandboxManager once (shared across sessions).
    // Per-session config is passed via customConfig to wrapWithSandbox().
    if (!globalSandboxManager) {
      const { SandboxManager } = await import(getSandboxRuntimeImportTarget())
      globalSandboxManager = SandboxManager
    }

    const config = buildConfig(workDir, userWritePaths)
    log.info(
      `Initializing sandbox session=${sessionId || DEFAULT_SESSION} workDir=${workDir} platform=${process.platform} extraWritePaths=${userWritePaths.length}`
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

/**
 * Execute agent code inside the sandbox. The program is fed to the child via stdin (see
 * {@link buildSandboxStdinScript}), so the user's bytes never touch a host shell command line —
 * there is no shell escaping and no base64 round-trip.
 *
 * macOS/Linux: the spawn argv comes from SandboxManager.wrapWithSandboxArgv() and runs with
 * {shell:false}, applying SRT confinement. Windows: @anthropic-ai/sandbox-runtime does not run
 * there, so the program executes natively with NO OS sandbox (see
 * docs/technical/windows-sandbox.md) — the session working directory is the only scoping.
 */
export async function execCode(params: {
  code: string
  language: 'bash' | 'node'
  timeout?: number
  cwd?: string
  sessionId?: string
}): Promise<ExecResult> {
  const session = getSession(params.sessionId)
  if (!session || session.state !== 'initialized') {
    throw new Error('Sandbox not initialized. Call initSandbox first.')
  }
  const isWindows = process.platform === 'win32'
  const cwd = params.cwd ?? session.workingDirectory ?? undefined
  const timeout = params.timeout ?? 30_000

  // Session env overrides: point HOME/TMPDIR/cache at the working directory.
  const envOverrides: NodeJS.ProcessEnv = {}
  if (session.workingDirectory) {
    const cacheDir = path.join(session.workingDirectory, '.cache')
    mkdirSync(cacheDir, { recursive: true })
    envOverrides.XDG_CACHE_HOME = cacheDir
    envOverrides.TMPDIR = envOverrides.TMP = envOverrides.TEMP = session.workingDirectory
    // Point HOME at the working directory so `~`, `$HOME`, and os.homedir() resolve there.
    // Confinement is unaffected: SRT expands `~` in deny rules via the main process's
    // os.homedir() when it bakes the seatbelt policy, so the child's overridden HOME only
    // affects that child's own `~` expansion, never the deny rules (e.g. ~/.ssh stays denied).
    envOverrides.HOME = session.workingDirectory
  }

  // Resolve the program that reads the code from stdin.
  let cmd: string
  let args: string[]
  if (params.language === 'node') {
    // The bundled Electron binary runs as Node via ELECTRON_RUN_AS_NODE; with no script arg and
    // piped (non-TTY) stdin it executes the piped program.
    cmd = process.execPath
    args = []
    envOverrides.ELECTRON_RUN_AS_NODE = '1'
  } else if (isWindows) {
    // Native Windows has no bash; use Git Bash / WSL if present.
    const bash = resolveWindowsBash()
    if (!bash) {
      return {
        stdout: '',
        stderr: 'bash is not available on this Windows host. Install Git Bash or enable WSL, or use node.',
        exitCode: 127,
      }
    }
    cmd = bash.cmd
    args = bash.args
  } else {
    cmd = 'bash'
    args = []
  }

  // Build the spawn descriptor. macOS/Linux wrap the argv with the OS sandbox; Windows runs direct.
  let spawnCmd: string
  let spawnArgs: string[]
  let spawnEnv: NodeJS.ProcessEnv
  if (isWindows) {
    spawnCmd = cmd
    spawnArgs = args
    spawnEnv = { ...process.env, ...envOverrides }
  } else {
    const mgr = globalSandboxManager
    if (!mgr) {
      throw new Error('Sandbox not initialized. Call initSandbox first.')
    }
    // Per-session config is passed as customConfig so each session's allowWrite is respected.
    const customConfig = session.sandboxConfig as Parameters<typeof mgr.wrapWithSandboxArgv>[2]
    const innerCommand = [cmd, ...args].map((token) => shellQuote(token)).join(' ')
    const { argv, env: wrappedEnv } = await mgr.wrapWithSandboxArgv(innerCommand, undefined, customConfig)
    spawnCmd = argv[0]
    spawnArgs = argv.slice(1)
    // On macOS/Linux wrappedEnv is process.env with proxy vars baked in; layer overrides on top.
    spawnEnv = { ...wrappedEnv, ...envOverrides }
  }

  // Windows bash (especially WSL) must keep resolving `node` from its own PATH; a Windows
  // process.execPath is not executable inside WSL. macOS/Linux need the bundled-node shim.
  const script = buildSandboxStdinScript(params.code, params.language, process.execPath, !isWindows)
  const MAX_BUFFER_BYTES = 10 * 1024 * 1024 // 10MB cap to prevent OOM from runaway output

  return new Promise((resolve, reject) => {
    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutCapped = false
    let stderrCapped = false

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // POSIX needs its own process group so we can signal the whole tree via -pid.
      // On Windows the tree is killed via taskkill /T, so detaching is unnecessary.
      detached: !isWindows,
    })
    session.runningChild = child

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child, 'SIGTERM')
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 3_000)
    }, timeout)

    child.stdout.on('data', (chunk: Uint8Array) => {
      if (!stdoutCapped) {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_BUFFER_BYTES) stdoutCapped = true
        else stdoutChunks.push(chunk)
      }
    })
    child.stderr.on('data', (chunk: Uint8Array) => {
      if (!stderrCapped) {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_BUFFER_BYTES) stderrCapped = true
        else stderrChunks.push(chunk)
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
      let stderr = tailTruncate(stripCodesignNoise(Buffer.concat(stderrChunks).toString('utf-8')))
      const exitCode = timedOut ? 124 : (code ?? 1)
      if (stdoutCapped) stdout += `\n[Output truncated: exceeded ${MAX_BUFFER_BYTES / 1024 / 1024}MB buffer limit]`
      if (stderrCapped) stderr += `\n[Stderr truncated: exceeded ${MAX_BUFFER_BYTES / 1024 / 1024}MB buffer limit]`
      if (timedOut) stderr += `\n[Process timed out after ${timeout}ms]`
      resolve({ stdout, stderr, exitCode })
    })

    // Feed the program via stdin: node executes the piped script; bash runs the piped commands.
    child.stdin.on('error', () => {})
    child.stdin.write(script)
    child.stdin.end()
  })
}

export function killRunningCommand(sessionId?: string): { killed: boolean } {
  const session = getSession(sessionId)
  if (!session) return { killed: false }

  const child = session.runningChild
  if (child && !child.killed) {
    killProcessTree(child, 'SIGTERM')
    log.info(`Killed running sandbox command for session ${sessionId || DEFAULT_SESSION}`)
    return { killed: true }
  }
  return { killed: false }
}

// ─── File operations ─────────────────────────────────────────────────

/** Run a bash command string inside the sandbox — thin wrapper over execCode for internal file ops. */
async function execBashInSandbox(command: string, sessionId?: string): Promise<ExecResult> {
  return execCode({ code: command, language: 'bash', sessionId })
}

export async function readFile(
  filePath: string,
  sessionId?: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const result = await execBashInSandbox(`cat ${shellEscape(filePath)}`, sessionId)
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
    const result = await execBashInSandbox(`ls -la ${shellEscape(dirPath)}`, sessionId)
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
    const result = await execBashInSandbox(`grep -rn ${includeFlag} ${shellEscape(pattern)} ${target}`, sessionId)
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
    const result = await execBashInSandbox(`find ${shellEscape(dirPath)} ${nameFlag} -type f`, sessionId)
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
    homeDirectory: homedir(),
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
    // Native Windows runs code without an OS sandbox (see docs/technical/windows-sandbox.md).
    // The bundled Node runtime is always present, so `node` is available; the `bash` language
    // additionally needs Git Bash or WSL on PATH, which execCode checks at call time.
    return { available: true }
  }

  return { available: false, reason: `Unsupported platform: ${process.platform}` }
}

// ─── Temp directory management ───────────────────────────────────────

/**
 * Initialize a sandbox with a temporary directory for a given session.
 * Creates os.tmpdir()/chatbox-sandbox/<sessionId>/ as the working directory.
 */
export async function initSandboxWithTempDir(
  sessionId: string,
  userWritePaths: string[] = []
): Promise<{ success: boolean; workingDirectory?: string; error?: string }> {
  // Validate sessionId to prevent path traversal
  if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return { success: false, error: 'Invalid session ID' }
  }

  const tempBase = path.join(getSandboxTmpRoot(), sessionId)
  try {
    mkdirSync(tempBase, { recursive: true })
    const result = await initSandbox(tempBase, sessionId, userWritePaths)
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
 * Compute the deterministic working directory for a session's temp sandbox without
 * creating it or initializing the sandbox. Mirrors the tempBase path used by
 * initSandboxWithTempDir, so callers can tell the model its working directory before the
 * sandbox lazily initializes on first tool call. Returns null for invalid session ids.
 */
export function resolveSandboxWorkingDir(sessionId: string): string | null {
  if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return null
  }
  return path.join(getSandboxTmpRoot(), sessionId)
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
 * Transient sandbox working directories live in the OS temp dir and are reaped by
 * cleanupStaleSandboxDirs(). Persisted download artifacts live under userData so they
 * survive OS temp eviction and the 7-day cleanup, keeping create_download outputs
 * downloadable indefinitely. The path intentionally contains `chatbox-sandbox` so the
 * renderer's sandbox-path detection (preview gating) keeps working.
 */
export function getSandboxTmpRoot(): string {
  return path.join(tmpdir(), 'chatbox-sandbox')
}

export function getSandboxArtifactsRoot(): string {
  return path.join(app.getPath('userData'), 'chatbox-sandbox', 'artifacts')
}

/**
 * All directory roots that may legitimately contain sandbox files, with symlinks
 * resolved (macOS: /var → /private/var). Used by export/read/preview security checks.
 * The artifacts root is listed first so previews of persisted files resolve to the
 * durable copy rather than a same-named transient temp file.
 */
export function getSandboxAllowedRoots(): string[] {
  const roots = new Set<string>()
  // Persisted artifacts are always accessible (listed first so previews resolve to the
  // durable copy rather than a same-named transient temp file).
  roots.add(safeRealpathSync(getSandboxArtifactsRoot()))
  // Live sessions: scope to each session's own working directory (per-session isolation).
  let hasLiveSession = false
  for (const session of sessions.values()) {
    if (session.workingDirectory) {
      roots.add(safeRealpathSync(session.workingDirectory))
      hasLiveSession = true
    }
  }
  // Post-restart fallback only: the sessions Map is empty but temp dirs still exist on
  // disk. Add the shared temp root solely to recover those — never alongside live
  // sessions, so one active session can't read another's working directory.
  if (!hasLiveSession) {
    roots.add(safeRealpathSync(getSandboxTmpRoot()))
  }
  return [...roots]
}

/**
 * Extra roots the sandbox is allowed to write to beyond per-session working dirs
 * (e.g. /tmp and the OS temp dir). create_download may persist files produced here
 * too, since the sandbox can legitimately write outputs to them. Kept in sync with the
 * allowWrite list built in initSandbox() (TASK_SANDBOX_EXTRA_WRITE_PATHS + temp dirs).
 */
function getSandboxExtraWriteRoots(): string[] {
  if (process.platform === 'win32') return []
  const roots = new Set<string>()
  for (const p of [tmpdir(), '/tmp', ...TASK_SANDBOX_EXTRA_WRITE_PATHS]) {
    roots.add(p)
    roots.add(safeRealpathSync(p))
  }
  return [...roots]
}

/** Remove all persisted download artifacts for a session (called on session deletion). */
export function removeSessionArtifacts(sessionId: string): { success: boolean; error?: string } {
  if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return { success: false, error: 'Invalid session ID' }
  }
  try {
    const dir = path.join(getSandboxArtifactsRoot(), sessionId)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('removeSessionArtifacts failed:', msg)
    return { success: false, error: msg }
  }
}

/** Whether a session has any persisted download artifacts on disk. */
export function hasSessionArtifacts(sessionId: string): boolean {
  if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return false
  }
  try {
    const dir = path.join(getSandboxArtifactsRoot(), sessionId)
    return existsSync(dir) && readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * Persist a sandbox file to durable storage under userData so it stays downloadable
 * even after the transient temp working directory is evicted or cleaned up.
 * Idempotent: a path that is already inside the artifacts root is returned as-is.
 * Returns the absolute path of the persisted copy.
 */
export async function persistSandboxArtifact(
  sandboxPath: string,
  sessionId: string,
  _displayName?: string
): Promise<{ success: boolean; artifactPath?: string; error?: string }> {
  // Validate sessionId to prevent path traversal
  if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    return { success: false, error: 'Invalid session ID' }
  }
  // On Windows the path may arrive in bash/POSIX form (e.g. /c/... from Git Bash realpath);
  // normalize to native Windows form before absolute/root validation.
  sandboxPath = normalizeWindowsShellPath(sandboxPath)
  if (!path.isAbsolute(sandboxPath)) {
    return { success: false, error: 'Artifact path must be absolute' }
  }
  try {
    // Security: the source must live inside a sandbox root (per-session working dir or
    // persisted artifacts) or a sandbox-writable temp location (/tmp, OS temp dir) — i.e.
    // somewhere the sandbox can legitimately produce files.
    const resolvedSource = safeRealpathSync(sandboxPath)
    const allowedRoots = [...getSandboxAllowedRoots(), ...getSandboxExtraWriteRoots()]
    const insideSandbox = allowedRoots.some(
      (root) => resolvedSource === root || resolvedSource.startsWith(root + path.sep)
    )
    if (!insideSandbox) {
      return { success: false, error: 'Access denied: path is outside the sandbox' }
    }
    if (!existsSync(resolvedSource)) {
      return { success: false, error: `File not found: ${sandboxPath}` }
    }

    // Already persisted — nothing to copy.
    const artifactsRoot = safeRealpathSync(getSandboxArtifactsRoot())
    if (resolvedSource === artifactsRoot || resolvedSource.startsWith(artifactsRoot + path.sep)) {
      return { success: true, artifactPath: resolvedSource }
    }

    // Group by a stable hash of the source path so distinct files that share a basename
    // (e.g. charts/report.html vs tables/report.html) don't overwrite each other, while
    // re-persisting the same source path updates the copy in place.
    const sourceKey = createHash('sha1').update(resolvedSource).digest('hex').slice(0, 12)
    const destDir = path.join(getSandboxArtifactsRoot(), sessionId, sourceKey)
    mkdirSync(destDir, { recursive: true })
    // Keep the original basename for the on-disk name. NOTE: _displayName is LLM-controlled
    // and intentionally NOT used here — do not wire it into the path without sanitizing
    // (path traversal). The download dialog uses display_name only as a save-as suggestion.
    const destPath = path.join(destDir, path.basename(resolvedSource))
    await fsCopyFile(resolvedSource, destPath)
    return { success: true, artifactPath: safeRealpathSync(destPath) }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('persistSandboxArtifact failed:', msg)
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
    // Security: only files inside a known sandbox root are allowed.
    let resolvedPath: string | null = null
    const sandboxRoots = getSandboxAllowedRoots()

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

const SANDBOX_ROOT = getSandboxTmpRoot()
const STALE_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Clean up stale sandbox temp directories older than 7 days.
 * Called on app startup. Only touches the transient temp root — persisted download
 * artifacts under userData (getSandboxArtifactsRoot) are intentionally never cleaned.
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
