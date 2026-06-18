import type { SandboxExecResult, SandboxProvider } from '@shared/sandbox-provider'
import { DEFAULT_EXEC_TIMEOUT } from '@shared/sandbox-provider'
import { shellQuote } from '@shared/utils/shell'
import platform from '@/platform'

/**
 * Local sandbox provider for Desktop (Electron).
 * Uses IPC to communicate with the main process sandbox manager.
 */
export class LocalSandboxProvider implements SandboxProvider {
  type = 'local' as const

  private sessionId: string | null = null
  private initialized = false

  async init(sessionId: string): Promise<{ success: boolean; error?: string }> {
    if (!platform.sandboxInitTemp) {
      return { success: false, error: 'Sandbox not available on this platform' }
    }

    const result = await platform.sandboxInitTemp({ sessionId })
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

  async getStatus(): Promise<{ initialized: boolean; sessionId?: string; workingDirectory?: string | null }> {
    if (platform.sandboxStatus && this.sessionId) {
      const status = await platform.sandboxStatus({ sessionId: this.sessionId })
      return {
        initialized: this.initialized,
        sessionId: this.sessionId ?? undefined,
        workingDirectory: status.workingDirectory,
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

  async exec(params: { code: string; language: 'bash' | 'node'; timeout?: number }): Promise<SandboxExecResult> {
    const timeout = params.timeout ?? DEFAULT_EXEC_TIMEOUT

    // Native Windows has no POSIX shell and the SRT sandbox does not run there, so route the
    // raw code to the native executor (no OS isolation — see docs/technical/windows-sandbox.md)
    // instead of building a bash/base64 command for the SRT path.
    if (isWindowsRenderer() && platform.sandboxExecCode) {
      return platform.sandboxExecCode({
        code: params.code,
        language: params.language,
        timeout,
        sessionId: this.sessionId ?? undefined,
      })
    }

    if (!platform.sandboxExec) {
      return { stdout: '', stderr: 'Sandbox not available on this platform', exitCode: 1 }
    }

    // For multi-line code or code with special characters, use base64 encoding
    // to avoid all shell escaping issues
    const encoded = btoa(unescape(encodeURIComponent(params.code)))

    let command: string
    switch (params.language) {
      case 'bash':
        command = buildBashExecutionCommand(encoded, await getNodeCommand())
        break
      case 'node':
        command = buildNodeExecutionCommand(encoded, await getNodeCommand())
        break
    }

    return platform.sandboxExec({ command, timeout, sessionId: this.sessionId ?? undefined })
  }

  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    if (!platform.sandboxCheckAvailability) {
      return { available: false, reason: 'Sandbox not available on this platform' }
    }
    return platform.sandboxCheckAvailability()
  }
}

// Mirrors getOS() === 'Windows' without importing navigator.ts (keeps this hot path light).
function isWindowsRenderer(): boolean {
  return typeof navigator !== 'undefined' && (navigator.userAgent ?? '').includes('Windows')
}

async function getNodeCommand(): Promise<string> {
  if (platform.sandboxNodeCommand) {
    return platform.sandboxNodeCommand()
  }
  return shellQuote('node')
}

function buildNodeShellFunction(nodeCommand: string): string {
  return `node() { ERR_FILE="./.chatbox-node-stderr.$$"; rm -f "$ERR_FILE"; ${nodeCommand} "$@" 2>"$ERR_FILE"; STATUS=$?; if [ -s "$ERR_FILE" ]; then grep -v 'ERROR:codesign_util\\.cc(109).*SecCodeCheckValidity' "$ERR_FILE" >&2 || true; fi; rm -f "$ERR_FILE"; return $STATUS; }`
}

export function buildBashExecutionCommand(encodedCode: string, nodeCommand: string): string {
  const script = [buildNodeShellFunction(nodeCommand), `eval "$(echo '${encodedCode}' | base64 -d)"`].join('; ')
  return `bash -c ${shellQuote(script)}`
}

export function buildNodeExecutionCommand(encodedCode: string, nodeCommand: string): string {
  // Packaged Electron can emit a macOS code-signing self-check warning on stderr
  // when launched as Node. Filter only that runtime noise and preserve user stderr.
  return [buildNodeShellFunction(nodeCommand), `echo '${encodedCode}' | base64 -d | node`, 'exit $?'].join('; ')
}
