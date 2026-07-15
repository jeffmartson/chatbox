import type { CopilotDetail, Message, MessageFile, Session, SessionMetaRecord, Settings } from '@shared/types'
import type { BackupResourceEntry, BackupWarning } from './types'

export interface ResourceReference {
  storageKey: string
  kind: BackupResourceEntry['kind']
  sessionId?: string
  mimeType?: string
  filename?: string
}

type LegacyMessage = Message & { pictures?: Array<{ storageKey?: string }> }

function addReference(references: ResourceReference[], reference: ResourceReference | undefined) {
  if (reference?.storageKey) references.push(reference)
}

function collectMessageReferences(
  message: Message,
  sessionId: string,
  references: ResourceReference[],
  warnings: BackupWarning[]
) {
  for (const picture of (message as LegacyMessage).pictures ?? []) {
    addReference(
      references,
      picture.storageKey ? { storageKey: picture.storageKey, kind: 'image', sessionId } : undefined
    )
  }
  for (const file of message.files ?? []) {
    addReference(
      references,
      file.storageKey
        ? {
            storageKey: file.storageKey,
            kind: 'parsed-attachment',
            sessionId,
            mimeType: 'text/plain',
            filename: file.name,
          }
        : undefined
    )
    addReference(
      references,
      file.rawStorageKey
        ? {
            storageKey: file.rawStorageKey,
            kind: 'raw-attachment',
            sessionId,
            mimeType: file.fileType,
            filename: file.name,
          }
        : undefined
    )
    if (file.localPath && !file.rawStorageKey) {
      warnings.push({
        code: 'external-resource-skipped',
        itemType: 'resource',
        itemId: file.name,
        message: `External file was not included because it is not managed by Chatbox: ${file.name}`,
      })
    }
  }
  for (const link of message.links ?? []) {
    addReference(
      references,
      link.storageKey
        ? { storageKey: link.storageKey, kind: 'parsed-link', sessionId, mimeType: 'text/plain' }
        : undefined
    )
  }
  for (const part of message.contentParts ?? []) {
    if (part.type === 'image') {
      addReference(references, { storageKey: part.storageKey, kind: 'image', sessionId })
    } else if (part.type === 'tool-call' && part.resultStorageKey) {
      addReference(references, {
        storageKey: part.resultStorageKey,
        kind: 'tool-result',
        sessionId,
        mimeType: 'text/plain',
      })
    }
  }
}

function visitSessionMessages(session: Session, callback: (message: Message) => void) {
  for (const message of session.messages) callback(message)
  for (const thread of session.threads ?? []) {
    for (const message of thread.messages) callback(message)
  }
  for (const fork of Object.values(session.messageForksHash ?? {})) {
    for (const list of fork.lists) {
      for (const message of list.messages) callback(message)
    }
  }
}

export function collectSessionResourceReferences(session: Session): {
  references: ResourceReference[]
  warnings: BackupWarning[]
} {
  const references: ResourceReference[] = []
  const warnings: BackupWarning[] = []
  visitSessionMessages(session, (message) => collectMessageReferences(message, session.id, references, warnings))
  addReference(
    references,
    session.assistantAvatarKey
      ? { storageKey: session.assistantAvatarKey, kind: 'avatar', sessionId: session.id }
      : undefined
  )
  if (session.backgroundImage?.type === 'storage-key') {
    addReference(references, {
      storageKey: session.backgroundImage.storageKey,
      kind: 'background',
      sessionId: session.id,
    })
  }
  return { references, warnings }
}

export function collectGlobalResourceReferences(settings?: Partial<Settings>, copilots?: CopilotDetail[]) {
  const references: ResourceReference[] = []
  for (const storageKey of [
    settings?.userAvatarKey,
    settings?.defaultAssistantAvatarKey,
    settings?.backgroundImageKey,
  ]) {
    addReference(references, storageKey ? { storageKey, kind: 'background' } : undefined)
  }
  for (const copilot of copilots ?? []) {
    for (const source of [copilot.avatar, copilot.backgroundImage, ...(copilot.screenshots ?? [])]) {
      if (source?.type === 'storage-key') {
        addReference(references, { storageKey: source.storageKey, kind: 'copilot-image' })
      }
    }
  }
  return references
}

function remapKey(value: string | undefined, resourceKeyMap: ReadonlyMap<string, string>): string | undefined {
  return value ? (resourceKeyMap.get(value) ?? value) : value
}

function resetRagState(file: MessageFile) {
  delete file.sessionAttachmentId
  delete file.sessionAttachmentAvailability
  delete file.sessionAttachmentIndexStatus
  delete file.sessionAttachmentBlockedReason
  delete file.sessionAttachmentWarningReason
  delete file.sessionAttachmentStatus
  delete file.sessionAttachmentChunkCount
  delete file.sessionAttachmentTotalChunks
  delete file.sessionAttachmentEmbeddedChunks
  delete file.sessionAttachmentIndexingStage
}

export function prepareSessionForBackup(session: Session): Session {
  const prepared = JSON.parse(JSON.stringify(session)) as Session
  visitSessionFiles(prepared, (file) => {
    delete file.localPath
    if (file.ragMode === 'session-retrieval') resetRagState(file)
  })
  return prepared
}

function remapMessage(message: Message, resourceKeyMap: ReadonlyMap<string, string>) {
  const legacyMessage = message as LegacyMessage
  for (const picture of legacyMessage.pictures ?? []) picture.storageKey = remapKey(picture.storageKey, resourceKeyMap)
  for (const file of message.files ?? []) {
    file.storageKey = remapKey(file.storageKey, resourceKeyMap)
    file.rawStorageKey = remapKey(file.rawStorageKey, resourceKeyMap)
    if (file.ragMode === 'session-retrieval') resetRagState(file)
  }
  for (const link of message.links ?? []) link.storageKey = remapKey(link.storageKey, resourceKeyMap)
  for (const part of message.contentParts ?? []) {
    if (part.type === 'image') {
      part.storageKey = remapKey(part.storageKey, resourceKeyMap) ?? part.storageKey
    } else if (part.type === 'tool-call') {
      part.resultStorageKey = remapKey(part.resultStorageKey, resourceKeyMap)
    }
  }
}

export function remapSessionResourceKeys(session: Session, resourceKeyMap: ReadonlyMap<string, string>): Session {
  const remapped = JSON.parse(JSON.stringify(session)) as Session
  remapped.assistantAvatarKey = remapKey(remapped.assistantAvatarKey, resourceKeyMap)
  if (remapped.backgroundImage?.type === 'storage-key') {
    remapped.backgroundImage.storageKey =
      remapKey(remapped.backgroundImage.storageKey, resourceKeyMap) ?? remapped.backgroundImage.storageKey
  }
  visitSessionMessages(remapped, (message) => remapMessage(message, resourceKeyMap))
  return remapped
}

export function remapSessionMetaResourceKeys(
  meta: SessionMetaRecord,
  resourceKeyMap: ReadonlyMap<string, string>
): SessionMetaRecord {
  const remapped = { ...meta }
  remapped.assistantAvatarKey = remapKey(remapped.assistantAvatarKey, resourceKeyMap)
  if (remapped.backgroundImage?.type === 'storage-key') {
    remapped.backgroundImage = {
      ...remapped.backgroundImage,
      storageKey: remapKey(remapped.backgroundImage.storageKey, resourceKeyMap) ?? remapped.backgroundImage.storageKey,
    }
  }
  return remapped
}

export function remapSettingsResourceKeys(settings: Partial<Settings>, resourceKeyMap: ReadonlyMap<string, string>) {
  const remapped = { ...settings }
  remapped.userAvatarKey = remapKey(remapped.userAvatarKey, resourceKeyMap)
  remapped.defaultAssistantAvatarKey = remapKey(remapped.defaultAssistantAvatarKey, resourceKeyMap)
  remapped.backgroundImageKey = remapKey(remapped.backgroundImageKey, resourceKeyMap)
  return remapped
}

function remapImageSource(source: CopilotDetail['avatar'], resourceKeyMap: ReadonlyMap<string, string>) {
  if (source?.type !== 'storage-key') return source
  return { ...source, storageKey: remapKey(source.storageKey, resourceKeyMap) ?? source.storageKey }
}

export function remapCopilotResourceKeys(copilots: CopilotDetail[], resourceKeyMap: ReadonlyMap<string, string>) {
  return copilots.map((copilot) => ({
    ...copilot,
    avatar: remapImageSource(copilot.avatar, resourceKeyMap),
    backgroundImage: remapImageSource(copilot.backgroundImage, resourceKeyMap),
    screenshots: copilot.screenshots?.map((source) => remapImageSource(source, resourceKeyMap) ?? source),
  }))
}

export function visitSessionFiles(session: Session, callback: (file: MessageFile, message: Message) => void) {
  visitSessionMessages(session, (message) => {
    for (const file of message.files ?? []) callback(file, message)
  })
}
