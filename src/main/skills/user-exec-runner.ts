import { spawn } from 'node:child_process'
import os from 'node:os'
import type { UserExecApprovalSource } from '@shared/types/user-exec'
import { buildOperationFinishLog, buildOperationStartLog, createOperationId } from '../operation-log'
import { getLogger } from '../util'

const log = getLogger('skills:user-exec')

export interface UserExecParams {
  command: string
  timeout?: number
  sessionId?: string
  toolCallId?: string
  approvalSource?: UserExecApprovalSource
}

export interface UserExecResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

interface UserExecEntry {
  command: string
  promise: Promise<UserExecResult>
  completedAt?: number
}

interface UserExecRunnerOptions {
  completedTtlMs?: number
  maxCompletedEntries?: number
  now?: () => number
}

const DEFAULT_COMPLETED_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_COMPLETED_ENTRIES = 32

async function executeUserExecCommand(params: UserExecParams): Promise<UserExecResult> {
  const { command, timeout, sessionId, toolCallId, approvalSource } = params

  try {
    if (!command || typeof command !== 'string') throw new Error('Command is required')

    const homeDir = os.homedir()
    const timeoutMs = timeout || 120_000
    const maxOutputBytes = 1024 * 1024 // 1MB
    const operationId = createOperationId()
    const startedAt = Date.now()

    log.info(
      buildOperationStartLog({
        operationId,
        kind: 'user_exec',
        sessionId,
        toolCallId,
        // Renderer approval metadata is audit-only. Missing values remain visible
        // instead of silently looking like a known authorization path.
        approvalSource: approvalSource ?? 'unknown',
        cwd: homeDir,
        timeoutMs,
        command,
      })
    )

    return await new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false

      const resolveOnce = (result: UserExecResult) => {
        if (settled) return
        settled = true
        const finishLog = buildOperationFinishLog({
          operationId,
          success: result.success,
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          timedOut: result.exitCode === null && result.stderr.includes('timed out'),
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutBytes,
          stderrBytes,
        })
        if (result.success) log.info(finishLog)
        else log.warn(finishLog)
        resolve(result)
      }

      const child = spawn('bash', ['-lc', command], {
        cwd: homeDir,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })

      child.stdout.on('data', (data: Buffer) => {
        stdoutBytes += data.byteLength
        if (stdoutBytes <= maxOutputBytes) stdout += data.toString()
      })
      child.stderr.on('data', (data: Buffer) => {
        stderrBytes += data.byteLength
        if (stderrBytes <= maxOutputBytes) stderr += data.toString()
      })
      child.on('error', (error) => {
        log.error('skills:user-exec spawn error', error)
        resolveOnce({ success: false, stdout, stderr: stderr || error.message, exitCode: null })
      })
      child.on('close', (code, signal) => {
        resolveOnce(
          signal === 'SIGTERM'
            ? { success: false, stdout, stderr: stderr || 'Command timed out', exitCode: null }
            : { success: code === 0, stdout, stderr, exitCode: code }
        )
      })

      setTimeout(() => {
        if (settled || child.killed) return
        child.kill('SIGTERM')
        resolveOnce({
          success: false,
          stdout,
          stderr: stderr || `Command timed out (${timeoutMs / 1000}s)`,
          exitCode: null,
        })
      }, timeoutMs)
    })
  } catch (error) {
    log.error('skills:user-exec failed', error)
    return {
      success: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Unknown error',
      exitCode: null,
    }
  }
}

export function createUserExecRunner(
  execute: (params: UserExecParams) => Promise<UserExecResult>,
  options: UserExecRunnerOptions = {}
) {
  const completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS
  const maxCompletedEntries = options.maxCompletedEntries ?? DEFAULT_MAX_COMPLETED_ENTRIES
  const now = options.now ?? Date.now
  const entries = new Map<string, UserExecEntry>()

  function pruneCompletedEntries(): void {
    const currentTime = now()
    for (const [key, entry] of entries) {
      if (entry.completedAt !== undefined && currentTime - entry.completedAt >= completedTtlMs) {
        entries.delete(key)
      }
    }

    const completedEntries = [...entries.entries()]
      .filter((entry): entry is [string, UserExecEntry & { completedAt: number }] => entry[1].completedAt !== undefined)
      .sort((a, b) => a[1].completedAt - b[1].completedAt)
    for (const [key] of completedEntries.slice(0, Math.max(0, completedEntries.length - maxCompletedEntries))) {
      entries.delete(key)
    }
  }

  return {
    run(params: UserExecParams): Promise<UserExecResult> {
      if (!params.toolCallId) return execute(params)

      pruneCompletedEntries()
      const key = `${params.sessionId ?? ''}:${params.toolCallId}`
      const existing = entries.get(key)
      if (existing) {
        if (existing.command !== params.command) {
          return Promise.resolve({
            success: false,
            stdout: '',
            stderr: `Tool call ${params.toolCallId} was reused with a different command`,
            exitCode: null,
          })
        }
        return existing.promise
      }

      const entry: UserExecEntry = {
        command: params.command,
        promise: Promise.resolve().then(() => execute(params)),
      }
      entries.set(key, entry)
      const markCompleted = () => {
        entry.completedAt = now()
        pruneCompletedEntries()
      }
      void entry.promise.then(markCompleted, markCompleted)
      return entry.promise
    },
  }
}

export function createDefaultUserExecRunner() {
  return createUserExecRunner(executeUserExecCommand)
}
