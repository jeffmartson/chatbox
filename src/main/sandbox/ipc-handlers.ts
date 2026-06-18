import { lstat as fsLstat, readFile as fsReadFile, realpath as fsRealpath } from 'node:fs/promises'
import path from 'node:path'
import { ipcMain } from 'electron'
import { shellQuote } from '../../shared/utils/shell'
import { getLogger } from '../util'
import {
  checkAvailability,
  copyBlobToSandbox,
  copyFileToSandbox,
  editFile,
  execCode,
  execCommand,
  exportFileFromSandbox,
  findFiles,
  getSandboxAllowedRoots,
  getStatus,
  grepFiles,
  hasSessionArtifacts,
  initSandbox,
  initSandboxWithTempDir,
  killRunningCommand,
  listDir,
  persistSandboxArtifact,
  readFile,
  removeSessionArtifacts,
  resetSandbox,
  writeFile,
} from './manager'
import { createSandboxHtmlPreviewUrl } from './preview-server'

const log = getLogger('sandbox:ipc-handlers')

export function registerSandboxIPCHandlers() {
  ipcMain.handle('sandbox:init', async (_event, params: { workingDirectory: string; sessionId?: string }) => {
    try {
      log.info(`sandbox:init workDir=${params.workingDirectory} session=${params.sessionId || 'default'}`)
      return await initSandbox(params.workingDirectory, params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:init failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(
    'sandbox:exec',
    async (_event, params: { command: string; timeout?: number; cwd?: string; sessionId?: string }) => {
      try {
        log.debug(
          `sandbox:exec command=${params.command.length > 200 ? `${params.command.slice(0, 200)}...` : params.command}`
        )
        return await execCommand(params.command, {
          timeout: params.timeout,
          cwd: params.cwd,
          sessionId: params.sessionId,
        })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:exec failed', msg)
        return { stdout: '', stderr: msg, exitCode: 1 }
      }
    }
  )

  // Native code execution path (Windows): runs code without an OS sandbox. The renderer
  // routes here on Windows instead of building a POSIX bash command for sandbox:exec.
  ipcMain.handle(
    'sandbox:exec-code',
    async (_event, params: { code: string; language: 'bash' | 'node'; timeout?: number; sessionId?: string }) => {
      try {
        log.debug(`sandbox:exec-code language=${params.language} bytes=${params.code.length}`)
        return await execCode(params)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:exec-code failed', msg)
        return { stdout: '', stderr: msg, exitCode: 1 }
      }
    }
  )

  ipcMain.handle('sandbox:read', async (_event, params: { filePath: string; sessionId?: string }) => {
    try {
      log.debug(`sandbox:read path=${params.filePath}`)
      return await readFile(params.filePath, params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:read failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('sandbox:write', async (_event, params: { filePath: string; content: string; sessionId?: string }) => {
    try {
      log.debug(`sandbox:write path=${params.filePath}`)
      return await writeFile(params.filePath, params.content, params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:write failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(
    'sandbox:edit',
    async (
      _event,
      params: {
        filePath: string
        search?: string
        replace?: string
        edits?: Array<{ search: string; replace: string }>
        sessionId?: string
      }
    ) => {
      try {
        log.debug(`sandbox:edit path=${params.filePath}`)
        return await editFile(params.filePath, params, params.sessionId)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:edit failed', msg)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle('sandbox:ls', async (_event, params: { dirPath: string; sessionId?: string }) => {
    try {
      log.debug(`sandbox:ls path=${params.dirPath}`)
      return await listDir(params.dirPath, params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:ls failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(
    'sandbox:grep',
    async (_event, params: { pattern: string; dirPath?: string; include?: string; sessionId?: string }) => {
      try {
        log.debug(`sandbox:grep pattern=${params.pattern}`)
        return await grepFiles(params.pattern, params.dirPath, { include: params.include }, params.sessionId)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:grep failed', msg)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle('sandbox:find', async (_event, params: { dirPath: string; pattern?: string; sessionId?: string }) => {
    try {
      log.debug(`sandbox:find dir=${params.dirPath}`)
      return await findFiles(params.dirPath, params.pattern, params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:find failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('sandbox:kill', (_event, params?: { sessionId?: string }) => {
    try {
      log.info('sandbox:kill')
      return killRunningCommand(params?.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:kill failed', msg)
      return { killed: false }
    }
  })

  ipcMain.handle('sandbox:reset', async (_event, params?: { sessionId?: string }) => {
    try {
      log.info(`sandbox:reset session=${params?.sessionId || 'default'}`)
      return await resetSandbox(params?.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:reset failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('sandbox:status', (_event, params?: { sessionId?: string }) => {
    return getStatus(params?.sessionId)
  })

  ipcMain.handle('sandbox:check-availability', async () => {
    try {
      return await checkAvailability()
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:check-availability failed', msg)
      return { available: false, reason: msg }
    }
  })

  ipcMain.handle('sandbox:init-temp', async (_event, params: { sessionId: string }) => {
    try {
      log.info(`sandbox:init-temp sessionId=${params.sessionId}`)
      return await initSandboxWithTempDir(params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:init-temp failed', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(
    'sandbox:copy-file',
    async (_event, params: { content: string; targetFilename: string; sessionId?: string }) => {
      try {
        log.debug(`sandbox:copy-file target=${params.targetFilename}`)
        return await copyFileToSandbox(params.content, params.targetFilename, params.sessionId)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:copy-file failed', msg)
        return { success: false, error: msg }
      }
    }
  )

  // Copy a blob from the store directly to the sandbox (avoids sending content through IPC)
  ipcMain.handle(
    'sandbox:copy-blob',
    async (_event, params: { blobKey: string; targetFilename: string; sessionId?: string }) => {
      try {
        log.debug(`sandbox:copy-blob key=${params.blobKey} target=${params.targetFilename}`)
        return await copyBlobToSandbox(params.blobKey, params.targetFilename, params.sessionId)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:copy-blob failed', msg)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle('sandbox:export-file', async (_event, params: { sandboxPath: string; suggestedName?: string }) => {
    try {
      log.debug(`sandbox:export-file path=${params.sandboxPath}`)
      return await exportFileFromSandbox(params.sandboxPath, params.suggestedName)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:export-file failed', msg)
      return { success: false, error: msg }
    }
  })

  // macOS/Linux only: the bash code-execution wrapper runs node via this command inside the
  // SRT sandbox. Windows uses native execCode (sandbox:exec-code) and never calls this.
  ipcMain.handle('sandbox:node-command', () => {
    const executable = shellQuote(process.execPath)
    return process.versions.electron ? `ELECTRON_RUN_AS_NODE=1 ${executable}` : executable
  })

  // Persist a generated file to durable storage (userData) so it stays downloadable
  // even after the transient temp working directory is evicted or cleaned up.
  ipcMain.handle(
    'sandbox:persist-artifact',
    async (_event, params: { sandboxPath: string; sessionId: string; displayName?: string }) => {
      try {
        log.debug(`sandbox:persist-artifact path=${params.sandboxPath}`)
        return await persistSandboxArtifact(params.sandboxPath, params.sessionId, params.displayName)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error('sandbox:persist-artifact failed', msg)
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle('sandbox:has-artifacts', (_event, params: { sessionId: string }) => {
    return { has: hasSessionArtifacts(params.sessionId) }
  })

  ipcMain.handle('sandbox:remove-artifacts', (_event, params: { sessionId: string }) => {
    try {
      log.debug(`sandbox:remove-artifacts session=${params.sessionId}`)
      return removeSessionArtifacts(params.sessionId)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('sandbox:remove-artifacts failed', msg)
      return { success: false, error: msg }
    }
  })

  // Read a file as base64 directly from disk (no sandbox init required).
  // Restricted to files within a known sandbox root (temp working dirs or persisted artifacts).
  ipcMain.handle('sandbox:read-file-base64', async (_event, params: { filePath: string }) => {
    try {
      const sandboxRoots = getSandboxAllowedRoots()
      // Check for symlinks before resolving — defense-in-depth
      const stat = await fsLstat(params.filePath)
      if (stat.isSymbolicLink()) {
        return { success: false, error: 'Access denied: symlinks not allowed' }
      }
      const resolved = await fsRealpath(params.filePath)
      const isInsideSandbox = sandboxRoots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep)
      )
      if (!isInsideSandbox) {
        return { success: false, error: 'Access denied: path outside sandbox directory' }
      }
      const buffer = await fsReadFile(resolved)
      return { success: true, base64: buffer.toString('base64') }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('sandbox:create-html-preview', async (_event, params: { filePath: string }) => {
    return await createSandboxHtmlPreviewUrl(params.filePath)
  })

  log.info('Sandbox IPC handlers registered')
}
