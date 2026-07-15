import type {
  SandboxExecLanguage,
  SandboxExecResult,
  SandboxProvider,
  SandboxSearchParams,
  SandboxSearchResult,
} from '@shared/sandbox-provider'
import { DEFAULT_EXEC_TIMEOUT } from '@shared/sandbox-provider'
import platform from '@/platform'

/**
 * Local sandbox provider for Desktop (Electron).
 * Uses IPC to communicate with the main process sandbox manager.
 */
export class LocalSandboxProvider implements SandboxProvider {
  type = 'local' as const

  private sessionId: string | null = null
  private initialized = false
  private extraWritableDirs: string[] = []

  setExtraWritableDirs(dirs: string[]): void {
    this.extraWritableDirs = dirs
  }

  async init(sessionId: string): Promise<{ success: boolean; error?: string }> {
    if (!platform.sandboxInitTemp) {
      return { success: false, error: 'Sandbox not available on this platform' }
    }

    const result = await platform.sandboxInitTemp({ sessionId, workingDirectories: this.extraWritableDirs })
    if (result.success) {
      this.sessionId = sessionId
      this.initialized = true
    }
    return result
  }

  async reset(): Promise<void> {
    if (platform.sandboxReset) {
      await platform.sandboxReset({ sessionId: this.sessionId ?? undefined })
    }
    this.initialized = false
    this.sessionId = null
  }

  async getStatus(): Promise<{
    initialized: boolean
    sessionId?: string
    workingDirectory?: string | null
    homeDirectory?: string
  }> {
    if (platform.sandboxStatus) {
      const status = await platform.sandboxStatus({ sessionId: this.sessionId ?? undefined })
      return {
        initialized: this.initialized,
        sessionId: this.sessionId ?? undefined,
        workingDirectory: status.workingDirectory,
        homeDirectory: status.homeDirectory,
      }
    }
    return { initialized: this.initialized, sessionId: this.sessionId ?? undefined }
  }

  async resolveWorkingDirectory(sessionId: string): Promise<string | null> {
    if (!platform.sandboxResolveWorkingDir) return null
    const result = await platform.sandboxResolveWorkingDir({ sessionId })
    return result.workingDirectory ?? null
  }

  async copyFileIn(content: string, targetFilename: string): Promise<{ success: boolean; error?: string }> {
    if (!platform.sandboxCopyFile) {
      return { success: false, error: 'Sandbox copy not available' }
    }
    return platform.sandboxCopyFile({ content, targetFilename, sessionId: this.sessionId ?? undefined })
  }

  async copyBlobIn(blobKey: string, targetFilename: string): Promise<{ success: boolean; error?: string }> {
    if (!platform.sandboxCopyBlob) {
      // sandboxCopyBlob is required for blob transfers - cannot fallback safely
      // (passing blobKey as content to copyFileIn would write the key string, not blob data)
      return { success: false, error: 'Blob transfer not supported on this platform' }
    }
    return platform.sandboxCopyBlob({ blobKey, targetFilename, sessionId: this.sessionId ?? undefined })
  }

  async readFileOut(sandboxPath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    if (!platform.sandboxRead) {
      return { success: false, error: 'Sandbox read not available' }
    }
    return platform.sandboxRead({ filePath: sandboxPath, sessionId: this.sessionId ?? undefined })
  }

  async exportFile(
    sandboxPath: string,
    suggestedName?: string
  ): Promise<{ success: boolean; localPath?: string; error?: string }> {
    if (!platform.sandboxExportFile) {
      return { success: false, error: 'Sandbox export not available' }
    }
    return platform.sandboxExportFile({ sandboxPath, suggestedName })
  }

  async persistArtifact(
    sandboxPath: string,
    displayName?: string
  ): Promise<{ success: boolean; artifactPath?: string; error?: string }> {
    if (!platform.sandboxPersistArtifact || !this.sessionId) {
      return { success: false, error: 'Sandbox persist not available' }
    }
    return platform.sandboxPersistArtifact({ sandboxPath, sessionId: this.sessionId, displayName })
  }

  async exec(params: { code: string; language: SandboxExecLanguage; timeout?: number }): Promise<SandboxExecResult> {
    const timeout = params.timeout ?? DEFAULT_EXEC_TIMEOUT
    if (!platform.sandboxExecCode) {
      return { stdout: '', stderr: 'Sandbox not available on this platform', exitCode: 1 }
    }
    // Code is sent raw; the main process feeds it to the sandboxed process via stdin — no base64
    // encoding and no shell escaping (see src/main/sandbox/manager.ts execCode).
    return platform.sandboxExecCode({
      code: params.code,
      language: params.language,
      timeout,
      sessionId: this.sessionId ?? undefined,
    })
  }

  async search(params: SandboxSearchParams): Promise<SandboxSearchResult> {
    if (!platform.sandboxSearch) {
      return { success: false, error: 'Sandbox search not available on this platform' }
    }
    return platform.sandboxSearch({ ...params, sessionId: this.sessionId ?? undefined })
  }

  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    if (!platform.sandboxCheckAvailability) {
      return { available: false, reason: 'Sandbox not available on this platform' }
    }
    return platform.sandboxCheckAvailability()
  }
}
