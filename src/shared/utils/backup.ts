import type { Settings } from '../types'

/**
 * Strip sensitive data from settings before writing a backup
 * (`chatbox-backup-*.zip`). License runtime state is always dropped;
 * license key and provider credentials are kept only when `includeKeys` is set.
 * Shared by the desktop/Web export (settings/general.tsx) and the native backup.
 */
export function cleanSettingsForBackup(settings: Settings, includeKeys: boolean): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...settings }
  delete cleaned.licenseDetail
  delete cleaned.licenseInstances
  if (!includeKeys) {
    delete cleaned.licenseKey
    if (settings.providers) {
      cleaned.providers = Object.fromEntries(
        Object.entries(settings.providers).map(([id, provider]) => {
          const cleanedProvider: Record<string, unknown> = { ...provider }
          delete cleanedProvider.apiKey
          delete cleanedProvider.accessKey
          delete cleanedProvider.secretKey
          delete cleanedProvider.sessionToken
          return [id, cleanedProvider]
        })
      )
    }
  }
  return cleaned
}

export function getBackupFilename(exportedAt: Date): string {
  const year = exportedAt.getFullYear()
  const month = exportedAt.getMonth() + 1
  const day = exportedAt.getDate()
  return `chatbox-backup-${year}-${month}-${day}.zip`
}
