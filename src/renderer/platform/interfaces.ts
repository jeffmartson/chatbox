/** biome-ignore-all lint/suspicious/noExplicitAny: <any> */
import type { Config, Language, Settings, ShortcutSetting } from '@shared/types'
import type { ImageGenerationStorage } from '@/storage/ImageGenerationStorage'
import type { SessionMetaStorage } from '@/storage/SessionMetaStorage'
import type { TaskSessionStorage } from '@/storage/TaskSessionStorage'
import type { KnowledgeBaseController } from './knowledge-base/interface'
import type { SessionAttachmentRagController } from './session-attachment-rag/interface'

export type PlatformType = 'web' | 'desktop' | 'mobile'

export interface Storage {
  getStorageType(): string
  setStoreValue(key: string, value: any): Promise<void>
  getStoreValue(key: string): Promise<any>
  delStoreValue(key: string): Promise<void>
  getAllStoreValues(): Promise<{ [key: string]: any }>
  getAllStoreKeys(): Promise<string[]>
  setAllStoreValues(data: { [key: string]: any }): Promise<void>
}

export interface Platform extends Storage {
  type: PlatformType

  exporter: Exporter

  // 系统相关

  getVersion(): Promise<string>
  getPlatform(): Promise<string>
  getArch(): Promise<string>
  shouldUseDarkColors(): Promise<boolean>
  onSystemThemeChange(callback: () => void): () => void
  onWindowShow(callback: () => void): () => void
  onWindowFocused(callback: () => void): () => void
  onUpdateDownloaded(callback: () => void): () => void
  onUpdaterChecking?(callback: () => void): () => void
  onUpdaterAvailable?(callback: (data: { version: string }) => void): () => void
  onUpdaterNotAvailable?(callback: () => void): () => void
  onUpdaterProgress?(
    callback: (data: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void
  ): () => void
  onUpdaterDownloaded?(callback: (data: { version: string }) => void): () => void
  onUpdaterError?(callback: (data: { message: string }) => void): () => void
  checkForUpdate?(): Promise<{ started: boolean }>
  onNavigate?(callback: (path: string) => void): () => void
  openLink(url: string): Promise<void>
  getDeviceName(): Promise<string>
  getInstanceName(): Promise<string>
  getLocale(): Promise<Language>
  ensureShortcutConfig(config: ShortcutSetting): Promise<void>
  ensureProxyConfig(config: { proxy?: string }): Promise<void>
  relaunch(): Promise<void>

  // 数据配置

  getConfig(): Promise<Config>
  getSettings(): Promise<Settings>

  // Blob 存储

  getStoreBlob(key: string): Promise<string | null>
  setStoreBlob(key: string, value: string): Promise<void>
  delStoreBlob(key: string): Promise<void>
  listStoreBlobKeys(): Promise<string[]>

  // 追踪

  initTracking(): void
  trackingEvent(name: string, params: { [key: string]: string }): void

  // 通知
  shouldShowAboutDialogWhenStartUp(): Promise<boolean>

  appLog(level: string, message: string): Promise<void>

  // 日志导出与管理
  exportLogs(): Promise<string> // 返回日志内容
  clearLogs(): Promise<void> // 清空日志

  ensureAutoLaunch(enable: boolean): Promise<void>

  parseFileLocally(file: File): Promise<{ key?: string; isSupported: boolean; errorCode?: string }>
  getLocalFilePath(file: File): string
  readLocalFileContent?(filePath: string): Promise<string | null>
  fsRead?(params: { filePath: string; offset?: number; limit?: number }): Promise<{
    success: boolean
    content?: string
    startLine?: number
    endLine?: number
    totalLines?: number
    error?: string
  }>
  fsList?(params: { dirPath: string }): Promise<{ success: boolean; content?: string; error?: string }>
  fsSearch?(params: {
    pattern: string
    dirPath: string
    include?: string
  }): Promise<{ success: boolean; content?: string; error?: string }>
  fsWrite?(params: { filePath: string; content: string }): Promise<{ success: boolean; error?: string }>
  fsEdit?(params: {
    filePath: string
    search?: string
    replace?: string
    edits?: Array<{ search: string; replace: string }>
  }): Promise<{ success: boolean; error?: string }>

  // Parse file using MinerU service (Desktop only)
  parseFileWithMineru?(
    file: File,
    apiToken: string
  ): Promise<{ success: boolean; content?: string; error?: string; cancelled?: boolean }>

  // Cancel MinerU parsing task (Desktop only)
  cancelMineruParse?(filePath: string): Promise<{ success: boolean; error?: string }>

  // parseUrl(url: string): Promise<{ key: string, title: string }>

  isFullscreen(): Promise<boolean>
  setFullscreen(enabled: boolean): Promise<void>
  installUpdate(): Promise<void>

  getKnowledgeBaseController(): KnowledgeBaseController
  getSessionAttachmentRagController(): SessionAttachmentRagController

  getImageGenerationStorage(): ImageGenerationStorage

  getTaskSessionStorage(): TaskSessionStorage

  getSessionMetaStorage(): SessionMetaStorage

  // Sandbox operations (Desktop only)
  sandboxInit?(config: { workingDirectory: string; sessionId?: string }): Promise<{ success: boolean; error?: string }>
  sandboxExec?(params: {
    command: string
    timeout?: number
    sessionId?: string
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  // Native code execution (Windows): runs code without an OS sandbox.
  sandboxExecCode?(params: {
    code: string
    language: 'bash' | 'node'
    timeout?: number
    sessionId?: string
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  sandboxRead?(params: {
    filePath: string
    sessionId?: string
  }): Promise<{ success: boolean; content?: string; error?: string }>
  sandboxWrite?(params: {
    filePath: string
    content: string
    sessionId?: string
  }): Promise<{ success: boolean; error?: string }>
  sandboxEdit?(params: {
    filePath: string
    search?: string
    replace?: string
    edits?: Array<{ search: string; replace: string }>
    sessionId?: string
  }): Promise<{ success: boolean; error?: string }>
  sandboxLs?(params: {
    dirPath: string
    sessionId?: string
  }): Promise<{ success: boolean; content?: string; error?: string }>
  sandboxGrep?(params: {
    pattern: string
    dirPath?: string
    include?: string
    sessionId?: string
  }): Promise<{ success: boolean; content?: string; error?: string }>
  sandboxFind?(params: {
    dirPath: string
    pattern?: string
    sessionId?: string
  }): Promise<{ success: boolean; content?: string; error?: string }>
  sandboxKill?(params?: { sessionId?: string }): Promise<{ killed: boolean }>
  sandboxReset?(params?: { sessionId?: string }): Promise<{ success: boolean; error?: string }>
  sandboxStatus?(params?: {
    sessionId?: string
  }): Promise<{ state: string; workingDirectory?: string | null; platform?: string }>
  /** Resolve a session's sandbox working directory without initializing the sandbox. */
  sandboxResolveWorkingDir?(params: { sessionId: string }): Promise<{ workingDirectory: string | null }>
  sandboxCheckAvailability?(): Promise<{ available: boolean; reason?: string }>

  // Sandbox temp dir operations (Desktop only, for code execution)
  sandboxInitTemp?(params: {
    sessionId: string
  }): Promise<{ success: boolean; workingDirectory?: string; error?: string }>
  sandboxCopyFile?(params: {
    content: string
    targetFilename: string
    sessionId?: string
  }): Promise<{ success: boolean; sandboxPath?: string; error?: string }>
  sandboxCopyBlob?(params: {
    blobKey: string
    targetFilename: string
    sessionId?: string
  }): Promise<{ success: boolean; sandboxPath?: string; error?: string }>
  sandboxExportFile?(params: {
    sandboxPath: string
    suggestedName?: string
  }): Promise<{ success: boolean; localPath?: string; error?: string }>
  sandboxPersistArtifact?(params: {
    sandboxPath: string
    sessionId: string
    displayName?: string
  }): Promise<{ success: boolean; artifactPath?: string; error?: string }>
  sandboxHasArtifacts?(params: { sessionId: string }): Promise<{ has: boolean }>
  sandboxRemoveArtifacts?(params: { sessionId: string }): Promise<{ success: boolean; error?: string }>
  sandboxReadFileBase64?(params: { filePath: string }): Promise<{ success: boolean; base64?: string; error?: string }>
  sandboxCreateHtmlPreview?(params: { filePath: string }): Promise<{ success: boolean; url?: string; error?: string }>
  sandboxNodeCommand?(): Promise<string>

  // Directory dialog (Desktop only)
  openDirectoryDialog?(): Promise<{ canceled: boolean; path?: string }>

  // window controls
  minimize(): Promise<void>

  maximize(): Promise<void>

  unmaximize(): Promise<void>

  closeWindow(): Promise<void>

  isMaximized(): Promise<boolean>

  onMaximizedChange(callback: (isMaximized: boolean) => void): () => void
}

export interface Exporter {
  exportBlob: (filename: string, blob: Blob, encoding?: 'utf8' | 'ascii' | 'utf16') => Promise<void>
  exportTextFile: (filename: string, content: string) => Promise<void>
  exportImageFile: (basename: string, base64: string) => Promise<void>
  exportByUrl: (filename: string, url: string) => Promise<void>
  exportStreamingJson: (filename: string, dataCallback: () => AsyncGenerator<string, void, unknown>) => Promise<void>
}
