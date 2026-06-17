/**
 * Sandbox provider abstraction for code execution.
 * Desktop uses local sandbox, Mobile/Web use cloud sandbox.
 */

export const DEFAULT_EXEC_TIMEOUT = 120_000

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SandboxProvider {
  type: 'local' | 'cloud'

  /** Initialize sandbox for a session, creating a temp working directory */
  init(sessionId: string): Promise<{ success: boolean; error?: string }>

  /** Reset/destroy the sandbox */
  reset(): Promise<void>

  /** Get current sandbox status */
  getStatus(): Promise<{ initialized: boolean; sessionId?: string; workingDirectory?: string | null }>

  /** Copy a file into the sandbox working directory */
  copyFileIn(content: string, targetFilename: string): Promise<{ success: boolean; error?: string }>

  /** Copy a file from the blob store into the sandbox (avoids sending content through IPC) */
  copyBlobIn(blobKey: string, targetFilename: string): Promise<{ success: boolean; error?: string }>

  /** Read a file from the sandbox */
  readFileOut(sandboxPath: string): Promise<{ success: boolean; content?: string; error?: string }>

  /** Export a file from sandbox to user's filesystem (triggers save dialog on desktop) */
  exportFile(
    sandboxPath: string,
    suggestedName?: string
  ): Promise<{ success: boolean; localPath?: string; error?: string }>

  /**
   * Persist a generated file to durable storage so it stays downloadable indefinitely,
   * even after the transient sandbox working directory is evicted or cleaned up.
   * Returns the persisted absolute path; callers should fall back to the original path
   * if persistence is unsupported or fails.
   */
  persistArtifact(
    sandboxPath: string,
    displayName?: string
  ): Promise<{ success: boolean; artifactPath?: string; error?: string }>

  /** Execute code in the sandbox */
  exec(params: { code: string; language: 'bash' | 'node'; timeout?: number }): Promise<SandboxExecResult>

  /** Check if the sandbox is available on this platform */
  checkAvailability(): Promise<{ available: boolean; reason?: string }>
}
