import type { CopilotDetail, Session, Settings } from '@shared/types'
import { base64ToBytes, bytesToBase64, decodeStoredBlob, sha256Checksum } from './codec'
import {
  remapCopilotResourceKeys,
  remapSessionMetaResourceKeys,
  remapSessionResourceKeys,
  remapSettingsResourceKeys,
} from './resources'
import { BackupStorageKey, backupSessionStorageKey } from './storage-keys'
import {
  type BackupManifest,
  BackupManifestSchema,
  type BackupMetaStorage,
  type BackupProgress,
  type BackupResourceEntry,
  type BackupStorage,
  type BackupWarning,
} from './types'
import { readZipFileEntries } from './zip'

const MANIFEST_PATH = 'manifest.json'
const MAX_JSON_ENTRY_BYTES = 128 * 1024 * 1024

interface StagedEntry {
  path: string
  size: number
  checksum: Awaited<ReturnType<typeof sha256Checksum>>
  tempKey?: string
  value?: unknown
}

interface ResourceWritePlan {
  resource: BackupResourceEntry
  tempKey: string
  targets: Array<{ originalKey: string; targetKey: string; needsWrite: boolean }>
}

interface PreviousValue {
  key: string
  existed: boolean
  rollbackKey?: string
}

export interface BackupImportOptions {
  storage: BackupStorage
  metaStorage: BackupMetaStorage
  signal?: AbortSignal
  onProgress?: (progress: BackupProgress) => void
  rehydrateSession?: (
    session: Session
  ) => Promise<{ session: Session; warnings: BackupWarning[]; rollback?: () => Promise<void> }>
}

export interface BackupImportResult {
  manifest: BackupManifest
  warnings: BackupWarning[]
  restoredSessionCount: number
  restoredResourceCount: number
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Operation canceled', 'AbortError')
  }
}

function isSession(value: unknown): value is Session {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'name' in value &&
      typeof value.name === 'string' &&
      'messages' in value &&
      Array.isArray(value.messages)
  )
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  if (bytes.length > MAX_JSON_ENTRY_BYTES) throw new Error(`Backup JSON entry is too large: ${path}`)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

function isResourcePath(path: string) {
  return path.startsWith('resources/') || /^sessions\/[^/]+\/resources\/.+/.test(path)
}

function isSessionPath(path: string) {
  return /^sessions\/[^/]+\/session\.json$/.test(path)
}

function validateManifestEntries(manifest: BackupManifest, stagedEntries: Map<string, StagedEntry>) {
  const missingResources = manifest.warnings.filter((warning) => warning.code === 'resource-read-failed')
  if (missingResources.length > 0) {
    throw new Error(`Backup is incomplete: ${missingResources.length} managed resource(s) could not be exported`)
  }
  const descriptors = [
    manifest.data.settings,
    manifest.data.copilots,
    manifest.data.sessionSettings,
    ...manifest.sessions,
    ...manifest.resources,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  const expectedPaths = new Set<string>([MANIFEST_PATH])
  for (const descriptor of descriptors) {
    if (expectedPaths.has(descriptor.path)) throw new Error(`Manifest contains a duplicate path: ${descriptor.path}`)
    expectedPaths.add(descriptor.path)
    const staged = stagedEntries.get(descriptor.path)
    if (!staged) throw new Error(`Backup entry is missing: ${descriptor.path}`)
    if (staged.size !== descriptor.size) throw new Error(`Backup entry size mismatch: ${descriptor.path}`)
    if (staged.checksum.value !== descriptor.checksum.value) {
      throw new Error(`Backup entry checksum mismatch: ${descriptor.path}`)
    }
  }
  for (const path of stagedEntries.keys()) {
    if (!expectedPaths.has(path)) throw new Error(`Backup contains an entry not listed in manifest: ${path}`)
  }
  if (expectedPaths.size !== stagedEntries.size) throw new Error('Backup manifest entry list is incomplete')

  const resourceIds = new Set<string>()
  const resourceKeys = new Set<string>()
  const sessionIds = new Set<string>()
  for (const session of manifest.sessions) {
    if (sessionIds.has(session.id)) throw new Error(`Duplicate session id in manifest: ${session.id}`)
    sessionIds.add(session.id)
    if (session.meta.id !== session.id) throw new Error(`Session metadata id does not match: ${session.id}`)
  }
  for (const resource of manifest.resources) {
    if (resourceIds.has(resource.id)) throw new Error(`Duplicate resource id in manifest: ${resource.id}`)
    resourceIds.add(resource.id)
    const ownResourceKeys = new Set<string>()
    for (const key of resource.originalStorageKeys) {
      if (ownResourceKeys.has(key)) throw new Error(`Resource contains a duplicate storage key: ${resource.id}`)
      ownResourceKeys.add(key)
      if (resourceKeys.has(key)) throw new Error(`Duplicate resource storage key in manifest: ${key}`)
      resourceKeys.add(key)
    }
    const ownSessionIds = new Set<string>()
    for (const sessionId of resource.sessionIds) {
      if (ownSessionIds.has(sessionId)) throw new Error(`Resource contains a duplicate session id: ${resource.id}`)
      ownSessionIds.add(sessionId)
      if (!sessionIds.has(sessionId)) throw new Error(`Resource references an unknown session: ${sessionId}`)
    }
    if (resource.scope === 'session' && resource.sessionIds.length !== 1) {
      throw new Error(`Session-scoped resource must reference exactly one session: ${resource.id}`)
    }
    if (resource.scope === 'global' && resource.sessionIds.length !== 0) {
      throw new Error(`Global resource must not reference a session: ${resource.id}`)
    }
  }
  const resourcesById = new Map(manifest.resources.map((resource) => [resource.id, resource]))
  const sessionsById = new Map(manifest.sessions.map((session) => [session.id, session]))
  for (const session of manifest.sessions) {
    const ownResourceIds = new Set<string>()
    for (const resourceId of session.resourceIds) {
      if (ownResourceIds.has(resourceId)) throw new Error(`Session contains a duplicate resource id: ${session.id}`)
      ownResourceIds.add(resourceId)
      if (!resourceIds.has(resourceId)) throw new Error(`Session references an unknown resource: ${resourceId}`)
      if (!resourcesById.get(resourceId)?.sessionIds.includes(session.id)) {
        throw new Error(`Session/resource mapping is inconsistent: ${session.id}/${resourceId}`)
      }
    }
  }
  for (const resource of manifest.resources) {
    for (const sessionId of resource.sessionIds) {
      const session = sessionsById.get(sessionId)
      if (!session?.resourceIds.includes(resource.id)) {
        throw new Error(`Resource/session mapping is inconsistent: ${resource.id}/${sessionId}`)
      }
    }
  }
  if (
    manifest.stats.sessionCount !== manifest.sessions.length ||
    manifest.stats.resourceCount !== manifest.resources.length ||
    manifest.stats.warningCount !== manifest.warnings.length
  ) {
    throw new Error('Backup manifest statistics do not match its entries')
  }
}

async function readStagedResource(storage: BackupStorage, plan: Pick<ResourceWritePlan, 'resource' | 'tempKey'>) {
  const base64 = await storage.getBlob(plan.tempKey)
  if (base64 === null) throw new Error(`Staged resource is missing: ${plan.resource.path}`)
  return decodeStoredBlob(base64ToBytes(base64), plan.resource.encoding, plan.resource.mimeType)
}

async function findAvailableCollisionKey(storage: BackupStorage, originalKey: string, reserved: Set<string>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let candidatePrefix = 'resource:imported'
    for (const prefix of ['picture:', 'file:', 'link:', 'parseFile-', 'parseUrl-']) {
      if (originalKey.startsWith(prefix)) {
        candidatePrefix = `${prefix}imported`
        break
      }
    }
    const candidate = `${candidatePrefix}:${globalThis.crypto.randomUUID()}`
    if (!reserved.has(candidate) && (await storage.getBlob(candidate)) === null) return candidate
  }
  throw new Error(`Could not allocate a resource key for: ${originalKey}`)
}

async function createResourcePlans(
  manifest: BackupManifest,
  stagedEntries: Map<string, StagedEntry>,
  storage: BackupStorage
) {
  const plans: ResourceWritePlan[] = []
  const resourceKeyMap = new Map<string, string>()
  const reserved = new Set<string>()
  for (const resource of manifest.resources) {
    const staged = stagedEntries.get(resource.path)
    if (!staged?.tempKey) throw new Error(`Resource was not staged: ${resource.path}`)
    const restoredValue = await readStagedResource(storage, { resource, tempKey: staged.tempKey })
    const targets: ResourceWritePlan['targets'] = []
    for (const originalKey of resource.originalStorageKeys) {
      const existingValue = await storage.getBlob(originalKey)
      let targetKey = originalKey
      let needsWrite = existingValue === null
      if (existingValue !== null && existingValue !== restoredValue) {
        targetKey = await findAvailableCollisionKey(storage, originalKey, reserved)
        needsWrite = true
      }
      if (reserved.has(targetKey)) {
        targetKey = await findAvailableCollisionKey(storage, originalKey, reserved)
        needsWrite = true
      }
      reserved.add(targetKey)
      resourceKeyMap.set(originalKey, targetKey)
      targets.push({ originalKey, targetKey, needsWrite })
    }
    plans.push({ resource, tempKey: staged.tempKey, targets })
  }
  return { plans, resourceKeyMap }
}

export async function isZipBackupFile(file: File): Promise<boolean> {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return (
    signature.length === 4 &&
    signature[0] === 0x50 &&
    signature[1] === 0x4b &&
    ((signature[2] === 0x03 && signature[3] === 0x04) ||
      (signature[2] === 0x05 && signature[3] === 0x06) ||
      (signature[2] === 0x07 && signature[3] === 0x08))
  )
}

export async function importBackupArchive(file: File, options: BackupImportOptions): Promise<BackupImportResult> {
  const importId = globalThis.crypto.randomUUID()
  const tempPrefix = `__chatbox_backup_import:${importId}`
  const stagedEntries = new Map<string, StagedEntry>()
  const tempStoreKeys: string[] = []
  const tempBlobKeys: string[] = []
  const previousValues: PreviousValue[] = []
  const changedMetaIds: string[] = []
  const previousMeta = new Map<string, Awaited<ReturnType<BackupMetaStorage['getById']>>>()
  const newResourceKeys: string[] = []
  const importWarnings: BackupWarning[] = []
  const rehydrationRollbacks: Array<() => Promise<void>> = []
  let stagedSessionCount = 0
  let stagedResourceCount = 0
  let commitStarted = false

  const cleanupTemps = async () => {
    for (const key of tempStoreKeys) await options.storage.removeItem(key).catch(() => undefined)
    for (const key of tempBlobKeys) await options.storage.delBlob(key).catch(() => undefined)
  }

  const rollback = async () => {
    for (const rollbackRehydration of rehydrationRollbacks.reverse()) {
      await rollbackRehydration().catch(() => undefined)
    }
    for (const metaId of changedMetaIds.reverse()) {
      const previous = previousMeta.get(metaId)
      if (previous) {
        const existing = await options.metaStorage.getById(metaId).catch(() => null)
        if (existing) await options.metaStorage.update(metaId, previous).catch(() => null)
        else await options.metaStorage.create(previous).catch(() => undefined)
      } else {
        await options.metaStorage.delete(metaId).catch(() => undefined)
      }
    }
    for (const previous of previousValues.reverse()) {
      if (previous.existed && previous.rollbackKey) {
        const value = await options.storage.getItem<unknown>(previous.rollbackKey, null)
        await options.storage.setItemNow(previous.key, value).catch(() => undefined)
      } else {
        await options.storage.removeItem(previous.key).catch(() => undefined)
      }
    }
    for (const key of newResourceKeys.reverse()) await options.storage.delBlob(key).catch(() => undefined)
  }

  try {
    options.onProgress?.({ phase: 'reading', current: 0, total: file.size })
    let readBytes = 0
    await readZipFileEntries(
      file,
      async (entry) => {
        throwIfAborted(options.signal)
        readBytes += entry.compressedSize ?? entry.uncompressedSize
        options.onProgress?.({
          phase: 'reading',
          current: Math.min(readBytes, file.size),
          total: file.size,
          label: entry.path,
        })
        const checksum = await sha256Checksum(entry.data)
        const staged: StagedEntry = { path: entry.path, size: entry.uncompressedSize, checksum }
        if (
          entry.path === MANIFEST_PATH ||
          entry.path === 'settings.json' ||
          entry.path === 'copilots.json' ||
          entry.path === 'session-settings.json'
        ) {
          staged.value = parseJson(entry.data, entry.path)
        } else if (isSessionPath(entry.path)) {
          const value = parseJson(entry.data, entry.path)
          if (!isSession(value)) throw new Error(`Invalid session entry: ${entry.path}`)
          const tempKey = `${tempPrefix}:session:${stagedSessionCount++}`
          await options.storage.setItemNow(tempKey, value)
          tempStoreKeys.push(tempKey)
          staged.tempKey = tempKey
        } else if (isResourcePath(entry.path)) {
          const tempKey = `${tempPrefix}:resource:${stagedResourceCount++}`
          await options.storage.setBlob(tempKey, bytesToBase64(entry.data))
          tempBlobKeys.push(tempKey)
          staged.tempKey = tempKey
        } else {
          throw new Error(`Unsupported backup entry: ${entry.path}`)
        }
        stagedEntries.set(entry.path, staged)
      },
      {
        signal: options.signal,
        limits: { maxEntryUncompressedBytes: MAX_JSON_ENTRY_BYTES },
      }
    )

    options.onProgress?.({ phase: 'validating', current: 0, total: 1 })
    const manifestValue = stagedEntries.get(MANIFEST_PATH)?.value
    const manifest = BackupManifestSchema.parse(manifestValue)
    validateManifestEntries(manifest, stagedEntries)
    const { plans: resourcePlans, resourceKeyMap } = await createResourcePlans(manifest, stagedEntries, options.storage)
    options.onProgress?.({ phase: 'validating', current: 1, total: 1 })

    const existingStoreKeys = new Set(await options.storage.getAllKeys())
    const changedKeys = [
      ...manifest.sessions.map((session) => backupSessionStorageKey(session.id)),
      ...(manifest.data.settings ? [BackupStorageKey.Settings] : []),
      ...(manifest.data.copilots ? [BackupStorageKey.MyCopilots] : []),
      ...(manifest.data.sessionSettings
        ? [BackupStorageKey.ChatSessionSettings, BackupStorageKey.PictureSessionSettings]
        : []),
    ]
    for (const key of new Set(changedKeys)) {
      const existed = existingStoreKeys.has(key)
      const previous: PreviousValue = { key, existed }
      if (existed) {
        const rollbackKey = `${tempPrefix}:rollback:${tempStoreKeys.length}`
        const value = await options.storage.getItem<unknown>(key, null)
        await options.storage.setItemNow(rollbackKey, value)
        tempStoreKeys.push(rollbackKey)
        previous.rollbackKey = rollbackKey
      }
      previousValues.push(previous)
    }

    commitStarted = true
    let completedResources = 0
    for (const plan of resourcePlans) {
      throwIfAborted(options.signal)
      const value = await readStagedResource(options.storage, plan)
      for (const target of plan.targets) {
        if (!target.needsWrite) continue
        newResourceKeys.push(target.targetKey)
        await options.storage.setBlob(target.targetKey, value)
      }
      completedResources++
      options.onProgress?.({
        phase: 'restoring',
        current: completedResources,
        total: resourcePlans.length + manifest.sessions.length,
        label: plan.resource.filename,
      })
    }

    for (let index = 0; index < manifest.sessions.length; index++) {
      throwIfAborted(options.signal)
      const descriptor = manifest.sessions[index]
      const tempKey = stagedEntries.get(descriptor.path)?.tempKey
      if (!tempKey) throw new Error(`Session was not staged: ${descriptor.path}`)
      const stagedSession = await options.storage.getItem<Session | null>(tempKey, null)
      if (!isSession(stagedSession) || stagedSession.id !== descriptor.id) {
        throw new Error(`Session id does not match manifest: ${descriptor.path}`)
      }
      let session = remapSessionResourceKeys(stagedSession, resourceKeyMap)
      if (options.rehydrateSession) {
        const rehydrated = await options.rehydrateSession(session)
        session = rehydrated.session
        importWarnings.push(...rehydrated.warnings)
        if (rehydrated.rollback) rehydrationRollbacks.push(rehydrated.rollback)
      }
      await options.storage.setItemNow(backupSessionStorageKey(session.id), session)

      const meta = remapSessionMetaResourceKeys(descriptor.meta, resourceKeyMap)
      const existingMeta = await options.metaStorage.getById(session.id)
      previousMeta.set(session.id, existingMeta)
      changedMetaIds.push(session.id)
      if (existingMeta) await options.metaStorage.update(session.id, meta)
      else await options.metaStorage.create(meta)
      options.onProgress?.({
        phase: 'restoring',
        current: resourcePlans.length + index + 1,
        total: resourcePlans.length + manifest.sessions.length,
        label: session.name,
      })
    }

    if (manifest.data.settings) {
      const value = stagedEntries.get(manifest.data.settings.path)?.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings entry')
      await options.storage.setItemNow(
        BackupStorageKey.Settings,
        remapSettingsResourceKeys(value as Partial<Settings>, resourceKeyMap)
      )
    }
    if (manifest.data.copilots) {
      const value = stagedEntries.get(manifest.data.copilots.path)?.value
      if (!Array.isArray(value)) throw new Error('Invalid copilots entry')
      await options.storage.setItemNow(
        BackupStorageKey.MyCopilots,
        remapCopilotResourceKeys(value as CopilotDetail[], resourceKeyMap)
      )
    }
    if (manifest.data.sessionSettings) {
      const value = stagedEntries.get(manifest.data.sessionSettings.path)?.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session settings entry')
      const sessionSettings = value as Record<string, unknown>
      for (const key of [BackupStorageKey.ChatSessionSettings, BackupStorageKey.PictureSessionSettings]) {
        if (key in sessionSettings) await options.storage.setItemNow(key, sessionSettings[key])
      }
    }

    await cleanupTemps()
    return {
      manifest,
      warnings: [...manifest.warnings, ...importWarnings],
      restoredSessionCount: manifest.sessions.length,
      restoredResourceCount: manifest.resources.length,
    }
  } catch (error) {
    if (commitStarted) await rollback()
    await cleanupTemps()
    throw error
  }
}
