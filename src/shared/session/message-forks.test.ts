import { describe, expect, test } from 'vitest'
import type { Message, Session } from '../types'
import {
  buildCreateInactiveForkPatch,
  buildSwitchForkToPatch,
  findMessageContext,
  findMessageLocation,
} from './message-forks'

function message(id: string, role: Message['role']): Message {
  return { id, role, contentParts: [] }
}

describe('buildCreateInactiveForkPatch', () => {
  test('adds an alternative without changing the active conversation', () => {
    const pivot = message('user-1', 'user')
    const currentReply = message('assistant-current', 'assistant')
    const candidate = { ...message('assistant-candidate', 'assistant'), generating: true }
    const session: Session = {
      id: 'session-1',
      name: 'Session',
      messages: [pivot, currentReply],
    }

    const patch = buildCreateInactiveForkPatch(session, pivot.id, [candidate])

    expect(patch?.messages).toEqual(session.messages)
    const fork = patch?.messageForksHash?.[pivot.id]
    expect(fork?.position).toBe(0)
    expect(fork?.lists).toHaveLength(2)
    expect(fork?.lists[0].messages).toEqual([])
    expect(fork?.lists[1].messages).toEqual([candidate])
    expect(session.messageForksHash).toBeUndefined()
  })

  test('appends concurrent candidates to an existing fork', () => {
    const pivot = message('user-1', 'user')
    const currentReply = message('assistant-current', 'assistant')
    const existingAlternative = message('assistant-alt', 'assistant')
    const candidate = { ...message('assistant-candidate', 'assistant'), generating: true }
    const session: Session = {
      id: 'session-2',
      name: 'Session',
      messages: [pivot, currentReply],
      messageForksHash: {
        [pivot.id]: {
          position: 0,
          lists: [
            { id: 'current', messages: [] },
            { id: 'existing', messages: [existingAlternative] },
          ],
          createdAt: 1,
        },
      },
    }

    const patch = buildCreateInactiveForkPatch(session, pivot.id, [candidate])
    const fork = patch?.messageForksHash?.[pivot.id]

    expect(patch?.messages).toEqual(session.messages)
    expect(fork?.position).toBe(0)
    expect(fork?.lists.map((list) => list.messages)).toEqual([[], [existingAlternative], [candidate]])
  })

  test('does not create an empty active branch for an unanswered prompt', () => {
    const pivot = message('user-1', 'user')
    const session: Session = {
      id: 'session-3',
      name: 'Session',
      messages: [pivot],
    }

    expect(
      buildCreateInactiveForkPatch(session, pivot.id, [
        { ...message('assistant-candidate', 'assistant'), generating: true },
      ])
    ).toBeNull()
  })

  test('reconstructs context for messages in nested saved branches', () => {
    const rootUser = message('root-user', 'user')
    const currentReply = message('current-reply', 'assistant')
    const alternativeReply = message('alternative-reply', 'assistant')
    const nestedUser = message('nested-user', 'user')
    const nestedReply = message('nested-reply', 'assistant')
    const session: Session = {
      id: 'session-4',
      name: 'Session',
      messages: [rootUser, currentReply],
      messageForksHash: {
        [rootUser.id]: {
          position: 0,
          lists: [
            { id: 'root-current', messages: [] },
            { id: 'root-alternative', messages: [alternativeReply, nestedUser] },
          ],
          createdAt: 1,
        },
        [nestedUser.id]: {
          position: 0,
          lists: [
            { id: 'nested-current', messages: [] },
            { id: 'nested-alternative', messages: [nestedReply] },
          ],
          createdAt: 2,
        },
      },
    }

    expect(findMessageLocation(session, nestedReply.id)?.list).toEqual([nestedReply])
    expect(findMessageContext(session, nestedReply.id)?.list).toEqual([
      rootUser,
      alternativeReply,
      nestedUser,
      nestedReply,
    ])
  })
})

describe('buildSwitchForkToPatch', () => {
  test('switches directly to the selected saved branch', () => {
    const pivot = message('user-1', 'user')
    const currentReply = message('assistant-current', 'assistant')
    const alternativeReply = message('assistant-alternative', 'assistant')
    const selectedReply = message('assistant-selected', 'assistant')
    const selectedFollowUp = message('user-follow-up', 'user')
    const session: Session = {
      id: 'session-5',
      name: 'Session',
      messages: [pivot, currentReply],
      messageForksHash: {
        [pivot.id]: {
          position: 0,
          lists: [
            { id: 'current', messages: [] },
            { id: 'alternative', messages: [alternativeReply] },
            { id: 'selected', messages: [selectedReply, selectedFollowUp] },
          ],
          createdAt: 1,
        },
      },
    }

    const patch = buildSwitchForkToPatch(session, pivot.id, 2)

    expect(patch?.messages).toEqual([pivot, selectedReply, selectedFollowUp])
    expect(patch?.messageForksHash?.[pivot.id]).toMatchObject({
      position: 2,
      lists: [
        { id: 'current', messages: [currentReply] },
        { id: 'alternative', messages: [alternativeReply] },
        { id: 'selected', messages: [] },
      ],
    })
  })

  test('ignores the active branch and invalid positions', () => {
    const pivot = message('user-1', 'user')
    const currentReply = message('assistant-current', 'assistant')
    const session: Session = {
      id: 'session-6',
      name: 'Session',
      messages: [pivot, currentReply],
      messageForksHash: {
        [pivot.id]: {
          position: 0,
          lists: [
            { id: 'current', messages: [] },
            { id: 'alternative', messages: [message('assistant-alternative', 'assistant')] },
          ],
          createdAt: 1,
        },
      },
    }

    expect(buildSwitchForkToPatch(session, pivot.id, 0)).toBeNull()
    expect(buildSwitchForkToPatch(session, pivot.id, 2)).toBeNull()
    expect(buildSwitchForkToPatch(session, pivot.id, 0.5)).toBeNull()
  })
})
