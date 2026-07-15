import type { Session, SessionMetaRecord } from '@shared/types'
import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { exportBackupArchive } from './export-backup'
import { importBackupArchive } from './import-backup'
import { backupSessionStorageKey } from './storage-keys'
import type { BackupMetaStorage, BackupStorage } from './types'

class MemoryStorage implements BackupStorage {
  readonly values = new Map<string, unknown>()
  readonly blobs = new Map<string, string>()

  getAllKeys(): Promise<string[]> {
    return Promise.resolve(Array.from(this.values.keys()))
  }
  getItem<T>(key: string, initialValue: T): Promise<T> {
    return Promise.resolve((this.values.has(key) ? this.values.get(key) : initialValue) as T)
  }
  setItemNow<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
    return Promise.resolve()
  }
  removeItem(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }
  getBlob(key: string): Promise<string | null> {
    return Promise.resolve(this.blobs.get(key) ?? null)
  }
  setBlob(key: string, value: string): Promise<void> {
    this.blobs.set(key, value)
    return Promise.resolve()
  }
  delBlob(key: string): Promise<void> {
    this.blobs.delete(key)
    return Promise.resolve()
  }
}

class DelayedMemoryStorage extends MemoryStorage {
  override async setItemNow<T>(key: string, value: T): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1))
    await super.setItemNow(key, value)
  }

  override async setBlob(key: string, value: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1))
    await super.setBlob(key, value)
  }
}

class MemoryMetaStorage implements BackupMetaStorage {
  readonly records = new Map<string, SessionMetaRecord>()

  getAllIncludingHidden(): Promise<SessionMetaRecord[]> {
    return Promise.resolve(Array.from(this.records.values()))
  }
  getById(id: string): Promise<SessionMetaRecord | null> {
    return Promise.resolve(this.records.get(id) ?? null)
  }
  create(record: SessionMetaRecord): Promise<void> {
    this.records.set(record.id, record)
    return Promise.resolve()
  }
  update(id: string, updates: Partial<SessionMetaRecord>): Promise<SessionMetaRecord | null> {
    const existing = this.records.get(id)
    if (!existing) return Promise.resolve(null)
    const updated = { ...existing, ...updates }
    this.records.set(id, updated)
    return Promise.resolve(updated)
  }
  delete(id: string): Promise<void> {
    this.records.delete(id)
    return Promise.resolve()
  }
}

class FailOnceMetaStorage extends MemoryMetaStorage {
  private shouldFail = true

  override async update(id: string, updates: Partial<SessionMetaRecord>) {
    const result = await super.update(id, updates)
    if (this.shouldFail) {
      this.shouldFail = false
      throw new Error('Injected metadata write failure')
    }
    return result
  }
}

function createSession(id: string): Session {
  return {
    id,
    name: `Session ${id}`,
    messages: [
      {
        id: `message-${id}`,
        role: 'user',
        contentParts: [
          { type: 'text', text: 'look' },
          { type: 'image', storageKey: 'picture:shared' },
        ],
      },
    ],
  }
}

function createMeta(session: Session, sortOrder: number): SessionMetaRecord {
  return { id: session.id, name: session.name, sortOrder, createdAt: sortOrder }
}

function createAttachmentSession(id: string): Session {
  return {
    id,
    name: `Attachment ${id}`,
    messages: [
      {
        id: `message-${id}`,
        role: 'user',
        contentParts: [{ type: 'text', text: 'read this' }],
        files: [
          {
            id: `file-${id}`,
            name: 'report.pdf',
            fileType: 'application/pdf',
            storageKey: 'file:parsed',
            rawStorageKey: 'file:raw',
            localPath: '/Users/example/report.pdf',
            ragMode: 'session-retrieval',
            sessionAttachmentId: 99,
            sessionAttachmentIndexStatus: 'ready',
          },
        ],
      },
    ],
  }
}

function combine(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

describe('ZIP backup round trip', () => {
  it('restores independent sessions and shared resources, remapping conflicting blob keys', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    for (const [index, id] of ['one', 'two'].entries()) {
      const session = createSession(id)
      source.values.set(backupSessionStorageKey(id), session)
      sourceMeta.records.set(id, createMeta(session, index + 1))
    }
    source.blobs.set('picture:shared', 'data:image/png;base64,AAECAw==')

    const chunks: Uint8Array[] = []
    const exported = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      exportedAt: new Date('2026-07-14T00:00:00.000Z'),
      storage: source,
      metaStorage: sourceMeta,
      application: { version: '1.22.0', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })
    expect(exported.manifest.sessions).toHaveLength(2)
    expect(exported.manifest.resources).toHaveLength(1)
    expect(exported.manifest.resources[0]).toMatchObject({ scope: 'shared', sessionIds: ['one', 'two'] })
    expect(new Set(exported.manifest.sessions.flatMap((session) => session.resourceIds))).toEqual(
      new Set([exported.manifest.resources[0].id])
    )

    const destination = new DelayedMemoryStorage()
    const destinationMeta = new MemoryMetaStorage()
    destination.blobs.set('picture:shared', 'data:image/png;base64,/w==')
    const archive = combine(chunks)
    const result = await importBackupArchive(
      new File([Uint8Array.from(archive).buffer], 'backup.zip', { type: 'application/zip' }),
      { storage: destination, metaStorage: destinationMeta }
    )

    expect(result.restoredSessionCount).toBe(2)
    expect(destination.blobs.get('picture:shared')).toBe('data:image/png;base64,/w==')
    const restoredOne = destination.values.get(backupSessionStorageKey('one')) as Session
    const restoredTwo = destination.values.get(backupSessionStorageKey('two')) as Session
    const restoredKey = restoredOne.messages[0].contentParts[1]
    expect(restoredKey).toMatchObject({ type: 'image' })
    if (restoredKey.type !== 'image') throw new Error('Expected an image part')
    expect(restoredKey.storageKey).not.toBe('picture:shared')
    expect(restoredTwo.messages[0].contentParts[1]).toMatchObject({ storageKey: restoredKey.storageKey })
    expect(destination.blobs.get(restoredKey.storageKey)).toBe('data:image/png;base64,AAECAw==')
    expect(destinationMeta.records.size).toBe(2)
  })

  it('round-trips parsed and raw attachments while dropping non-portable metadata', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const session = createAttachmentSession('files')
    source.values.set(backupSessionStorageKey(session.id), session)
    sourceMeta.records.set(session.id, createMeta(session, 1))
    source.blobs.set('file:parsed', 'parsed report')
    source.blobs.set('file:raw', 'data:application/pdf;base64,JVBERi0xLjQ=')
    const chunks: Uint8Array[] = []
    const exported = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })

    expect(exported.manifest.sessions[0].path).toBe('sessions/files/session.json')
    expect(exported.manifest.resources).toHaveLength(2)
    expect(new Set(exported.manifest.resources.map((resource) => resource.kind))).toEqual(
      new Set(['parsed-attachment', 'raw-attachment'])
    )

    const destination = new DelayedMemoryStorage()
    await importBackupArchive(new File([Uint8Array.from(combine(chunks)).buffer], 'backup.zip'), {
      storage: destination,
      metaStorage: new MemoryMetaStorage(),
    })
    const restored = destination.values.get(backupSessionStorageKey(session.id)) as Session
    const restoredFile = restored.messages[0].files?.[0]
    expect(restoredFile?.localPath).toBeUndefined()
    expect(restoredFile?.sessionAttachmentId).toBeUndefined()
    expect(restoredFile?.sessionAttachmentIndexStatus).toBeUndefined()
    expect(destination.blobs.get(restoredFile?.storageKey ?? '')).toBe('parsed report')
    expect(destination.blobs.get(restoredFile?.rawStorageKey ?? '')).toBe('data:application/pdf;base64,JVBERi0xLjQ=')
  })

  it('deduplicates identical resource content and preserves the resource graph', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const one = createSession('dedupe-one')
    const two = createSession('dedupe-two')
    const secondImage = two.messages[0].contentParts[1]
    if (secondImage.type !== 'image') throw new Error('Expected an image part')
    secondImage.storageKey = 'picture:copy'
    for (const [index, session] of [one, two].entries()) {
      source.values.set(backupSessionStorageKey(session.id), session)
      sourceMeta.records.set(session.id, createMeta(session, index + 1))
    }
    source.blobs.set('picture:shared', 'data:image/png;base64,AAECAw==')
    source.blobs.set('picture:copy', 'data:image/png;base64,AAECAw==')

    const exported = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const _chunk of dataCallback()) {
          // Consume the stream so the manifest is finalized.
        }
        return { boundedMemory: true }
      },
    })
    expect(exported.manifest.resources).toHaveLength(1)
    expect(exported.manifest.resources[0]).toMatchObject({
      scope: 'shared',
      originalStorageKeys: ['picture:shared', 'picture:copy'],
      sessionIds: ['dedupe-one', 'dedupe-two'],
    })
    expect(exported.manifest.stats.deduplicatedResourceCount).toBe(1)
    expect(exported.manifest.sessions.every((entry) => entry.resourceIds.length === 1)).toBe(true)
  })

  it('records missing managed resources instead of silently claiming a complete backup', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const session = createSession('missing')
    source.values.set(backupSessionStorageKey(session.id), session)
    sourceMeta.records.set(session.id, createMeta(session, 1))
    const chunks: Uint8Array[] = []
    const result = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })
    expect(result.manifest.warnings).toContainEqual(
      expect.objectContaining({ code: 'resource-read-failed', itemId: 'picture:shared' })
    )
    await expect(
      importBackupArchive(new File([Uint8Array.from(combine(chunks)).buffer], 'incomplete.zip'), {
        storage: new MemoryStorage(),
        metaStorage: new MemoryMetaStorage(),
      })
    ).rejects.toThrow('Backup is incomplete')
  })

  it('ignores null orphan session slots that do not have session metadata', async () => {
    const source = new MemoryStorage()
    source.values.set(backupSessionStorageKey('new'), null)
    const result = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: new MemoryMetaStorage(),
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const _chunk of dataCallback()) {
          // Consume the stream so the manifest is finalized.
        }
        return { boundedMemory: true }
      },
    })

    expect(result.manifest.sessions).toEqual([])
    expect(result.manifest.warnings).toEqual([])
  })

  it('rejects a resource checksum mismatch before changing destination data', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const session = createSession('checksum')
    source.values.set(backupSessionStorageKey(session.id), session)
    sourceMeta.records.set(session.id, createMeta(session, 1))
    source.blobs.set('picture:shared', 'data:image/png;base64,AAECAw==')
    const chunks: Uint8Array[] = []
    const exported = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })
    const entries = unzipSync(combine(chunks))
    entries[exported.manifest.resources[0].path] = new Uint8Array([4, 3, 2, 1])

    const destination = new MemoryStorage()
    const destinationMeta = new MemoryMetaStorage()
    await expect(
      importBackupArchive(
        new File([Uint8Array.from(zipSync(entries)).buffer], 'tampered.zip', { type: 'application/zip' }),
        { storage: destination, metaStorage: destinationMeta }
      )
    ).rejects.toThrow('checksum mismatch')
    expect(destination.values.has(backupSessionStorageKey(session.id))).toBe(false)
    expect(destinationMeta.records.size).toBe(0)
  })

  it('rejects a manifest with a missing resource entry', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const session = createSession('missing-entry')
    source.values.set(backupSessionStorageKey(session.id), session)
    sourceMeta.records.set(session.id, createMeta(session, 1))
    source.blobs.set('picture:shared', 'data:image/png;base64,AAECAw==')
    const chunks: Uint8Array[] = []
    const exported = await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })
    const entries = unzipSync(combine(chunks))
    delete entries[exported.manifest.resources[0].path]
    await expect(
      importBackupArchive(
        new File([Uint8Array.from(zipSync(entries)).buffer], 'missing.zip', { type: 'application/zip' }),
        { storage: new MemoryStorage(), metaStorage: new MemoryMetaStorage() }
      )
    ).rejects.toThrow('entry is missing')
  })

  it('rolls back sessions, metadata, resources, and temporary staging after a commit failure', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const importedSession = createSession('rollback')
    source.values.set(backupSessionStorageKey(importedSession.id), importedSession)
    sourceMeta.records.set(importedSession.id, createMeta(importedSession, 2))
    source.blobs.set('picture:shared', 'data:image/png;base64,AAECAw==')
    const chunks: Uint8Array[] = []
    await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })

    const destination = new MemoryStorage()
    const destinationMeta = new FailOnceMetaStorage()
    const previousSession: Session = { id: 'rollback', name: 'Previous', messages: [] }
    const previousMeta = createMeta(previousSession, 1)
    const rollbackRehydration = vi.fn(() => Promise.resolve())
    destination.values.set(backupSessionStorageKey(previousSession.id), previousSession)
    destinationMeta.records.set(previousSession.id, previousMeta)

    await expect(
      importBackupArchive(new File([Uint8Array.from(combine(chunks)).buffer], 'rollback.zip'), {
        storage: destination,
        metaStorage: destinationMeta,
        rehydrateSession: (session) => Promise.resolve({ session, warnings: [], rollback: rollbackRehydration }),
      })
    ).rejects.toThrow('Injected metadata write failure')
    expect(destination.values.get(backupSessionStorageKey(previousSession.id))).toEqual(previousSession)
    expect(destinationMeta.records.get(previousSession.id)).toEqual(previousMeta)
    expect(destination.blobs.has('picture:shared')).toBe(false)
    expect(Array.from(destination.values.keys()).some((key) => key.startsWith('__chatbox_backup_import:'))).toBe(false)
    expect(Array.from(destination.blobs.keys()).some((key) => key.startsWith('__chatbox_backup_import:'))).toBe(false)
    expect(rollbackRehydration).toHaveBeenCalledOnce()
  })

  it('cleans staged and newly written data when import is canceled during commit', async () => {
    const source = new MemoryStorage()
    const sourceMeta = new MemoryMetaStorage()
    const session = createSession('cancel')
    source.values.set(backupSessionStorageKey(session.id), session)
    sourceMeta.records.set(session.id, createMeta(session, 1))
    source.blobs.set('picture:shared', 'data:image/png;base64,AAECAw==')
    const chunks: Uint8Array[] = []
    await exportBackupArchive({
      exportItems: ['conversations'],
      includeKeys: false,
      storage: source,
      metaStorage: sourceMeta,
      application: { version: 'test', platform: 'test' },
      writeArchive: async (dataCallback) => {
        for await (const chunk of dataCallback()) chunks.push(chunk)
        return { boundedMemory: true }
      },
    })

    const destination = new MemoryStorage()
    const destinationMeta = new MemoryMetaStorage()
    const abortController = new AbortController()
    await expect(
      importBackupArchive(new File([Uint8Array.from(combine(chunks)).buffer], 'cancel.zip'), {
        storage: destination,
        metaStorage: destinationMeta,
        signal: abortController.signal,
        onProgress: (progress) => {
          if (progress.phase === 'restoring' && progress.current === 1) {
            abortController.abort(new DOMException('Canceled by test', 'AbortError'))
          }
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(destination.values.has(backupSessionStorageKey(session.id))).toBe(false)
    expect(destinationMeta.records.size).toBe(0)
    expect(destination.blobs.size).toBe(0)
  })
})
