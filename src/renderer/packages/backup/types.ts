import { SessionMetaRecordSchema } from '@shared/types'
import { z } from 'zod'

export const BACKUP_FORMAT = 'chatbox-backup'
export const BACKUP_FORMAT_VERSION = 2

const BackupIdentifierSchema = z.string().min(1).max(1024)
const BackupPathSchema = z.string().min(1).max(4096)

export const BackupExportItemSchema = z.enum(['setting', 'key', 'conversations', 'copilot'])
export type BackupExportItem = z.infer<typeof BackupExportItemSchema>

export const BackupChecksumSchema = z.object({
  algorithm: z.literal('sha256'),
  value: z.string().regex(/^[a-f0-9]{64}$/),
})
export type BackupChecksum = z.infer<typeof BackupChecksumSchema>

export const BackupJsonEntrySchema = z.object({
  path: BackupPathSchema,
  size: z.number().int().nonnegative(),
  checksum: BackupChecksumSchema,
})
export type BackupJsonEntry = z.infer<typeof BackupJsonEntrySchema>

export const BackupSessionEntrySchema = BackupJsonEntrySchema.extend({
  id: BackupIdentifierSchema,
  meta: SessionMetaRecordSchema,
  resourceIds: z.array(BackupIdentifierSchema).max(50_000),
})
export type BackupSessionEntry = z.infer<typeof BackupSessionEntrySchema>

export const BackupResourceEntrySchema = BackupJsonEntrySchema.extend({
  id: BackupIdentifierSchema,
  originalStorageKeys: z.array(BackupIdentifierSchema).min(1).max(50_000),
  sessionIds: z.array(BackupIdentifierSchema).max(50_000),
  scope: z.enum(['session', 'shared', 'global']),
  encoding: z.enum(['utf8', 'data-url-base64']),
  mimeType: z.string().min(1),
  kind: z.enum([
    'image',
    'parsed-attachment',
    'raw-attachment',
    'parsed-link',
    'tool-result',
    'avatar',
    'background',
    'copilot-image',
  ]),
  filename: z.string().optional(),
})
export type BackupResourceEntry = z.infer<typeof BackupResourceEntrySchema>

export const BackupWarningSchema = z.object({
  code: z.enum(['session-read-failed', 'resource-read-failed', 'external-resource-skipped', 'rag-rebuild-failed']),
  itemType: z.enum(['session', 'resource']),
  itemId: z.string().optional(),
  message: z.string(),
})
export type BackupWarning = z.infer<typeof BackupWarningSchema>

export const BackupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: z.string().datetime(),
  application: z.object({
    name: z.literal('Chatbox'),
    version: z.string(),
    platform: z.string(),
  }),
  exportItems: z.array(BackupExportItemSchema),
  sourceConfigVersion: z.number().int().nonnegative().optional(),
  data: z.object({
    settings: BackupJsonEntrySchema.optional(),
    copilots: BackupJsonEntrySchema.optional(),
    sessionSettings: BackupJsonEntrySchema.optional(),
  }),
  sessions: z.array(BackupSessionEntrySchema).max(50_000),
  resources: z.array(BackupResourceEntrySchema).max(50_000),
  warnings: z.array(BackupWarningSchema).max(50_000),
  stats: z.object({
    sessionCount: z.number().int().nonnegative(),
    resourceCount: z.number().int().nonnegative(),
    deduplicatedResourceCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }),
})
export type BackupManifest = z.infer<typeof BackupManifestSchema>

export interface BackupProgress {
  phase: 'preparing' | 'sessions' | 'resources' | 'packing' | 'reading' | 'validating' | 'restoring'
  current: number
  total: number
  label?: string
}

export interface BackupStorage {
  getAllKeys(): Promise<string[]>
  getItem<T>(key: string, initialValue: T): Promise<T>
  setItemNow<T>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  getBlob(key: string): Promise<string | null>
  setBlob(key: string, value: string): Promise<void>
  delBlob(key: string): Promise<void>
}

export interface BackupMetaStorage {
  getAllIncludingHidden(): Promise<z.infer<typeof SessionMetaRecordSchema>[]>
  getById(id: string): Promise<z.infer<typeof SessionMetaRecordSchema> | null>
  create(record: z.infer<typeof SessionMetaRecordSchema>): Promise<void>
  update(
    id: string,
    updates: Partial<z.infer<typeof SessionMetaRecordSchema>>
  ): Promise<z.infer<typeof SessionMetaRecordSchema> | null>
  delete(id: string): Promise<void>
}
