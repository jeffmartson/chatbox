import type { Session } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { collectSessionResourceReferences, prepareSessionForBackup, remapSessionResourceKeys } from './resources'

function createSession(): Session {
  return {
    id: 'session-1',
    name: 'Backup test',
    messages: [
      {
        id: 'message-1',
        role: 'user',
        contentParts: [
          { type: 'text', text: 'hello' },
          { type: 'image', storageKey: 'picture:shared' },
        ],
        files: [
          {
            id: 'file-1',
            name: 'report.pdf',
            fileType: 'application/pdf',
            storageKey: 'file:parsed',
            rawStorageKey: 'file:raw',
            ragMode: 'session-retrieval',
            sessionAttachmentId: 42,
            sessionAttachmentAvailability: 'allowed',
            sessionAttachmentIndexStatus: 'ready',
            sessionAttachmentChunkCount: 2,
            localPath: '/Users/example/report.pdf',
          },
        ],
        links: [{ id: 'link-1', url: 'https://example.com', title: 'Example', storageKey: 'link:parsed' }],
      },
    ],
    threads: [
      {
        id: 'thread-1',
        name: 'Earlier',
        createdAt: 1,
        messages: [
          {
            id: 'message-2',
            role: 'assistant',
            contentParts: [
              {
                type: 'tool-call',
                state: 'result',
                toolCallId: 'tool-1',
                toolName: 'search',
                resultStorageKey: 'tool:result',
              },
            ],
          },
        ],
      },
    ],
    assistantAvatarKey: 'picture:avatar',
    backgroundImage: { type: 'storage-key', storageKey: 'picture:background' },
  }
}

describe('backup resource graph', () => {
  it('collects managed resources from messages, threads, attachments, and session decoration', () => {
    const collected = collectSessionResourceReferences(createSession())
    expect(new Set(collected.references.map((reference) => reference.storageKey))).toEqual(
      new Set([
        'picture:shared',
        'file:parsed',
        'file:raw',
        'link:parsed',
        'tool:result',
        'picture:avatar',
        'picture:background',
      ])
    )
  })

  it('remaps every managed reference and clears non-portable RAG state', () => {
    const remapped = remapSessionResourceKeys(
      createSession(),
      new Map([
        ['picture:shared', 'picture:restored'],
        ['file:parsed', 'file:parsed:restored'],
        ['file:raw', 'file:raw:restored'],
        ['link:parsed', 'link:restored'],
        ['tool:result', 'tool:restored'],
        ['picture:avatar', 'picture:avatar:restored'],
        ['picture:background', 'picture:background:restored'],
      ])
    )
    expect(remapped.messages[0].contentParts[1]).toMatchObject({ storageKey: 'picture:restored' })
    expect(remapped.messages[0].files?.[0]).toMatchObject({
      storageKey: 'file:parsed:restored',
      rawStorageKey: 'file:raw:restored',
    })
    expect(remapped.messages[0].files?.[0].sessionAttachmentId).toBeUndefined()
    expect(remapped.threads?.[0].messages[0].contentParts[0]).toMatchObject({ resultStorageKey: 'tool:restored' })
    expect(remapped.assistantAvatarKey).toBe('picture:avatar:restored')
  })

  it('removes local paths and derived RAG state from serialized sessions', () => {
    const prepared = prepareSessionForBackup(createSession())
    const file = prepared.messages[0].files?.[0]
    expect(file).toMatchObject({ ragMode: 'session-retrieval' })
    expect(file?.localPath).toBeUndefined()
    expect(file?.sessionAttachmentId).toBeUndefined()
    expect(file?.sessionAttachmentAvailability).toBeUndefined()
    expect(file?.sessionAttachmentIndexStatus).toBeUndefined()
    expect(file?.sessionAttachmentChunkCount).toBeUndefined()
  })
})
