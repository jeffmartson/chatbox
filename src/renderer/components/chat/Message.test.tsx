import { MessageRoleEnum } from '@shared/types'
import { describe, expect, test } from 'vitest'
import { shouldRightAlignMessage } from './message-layout'
import { getMessageRoleClass } from './message-role-class'

describe('Message role classes', () => {
  test('maps each message role to its semantic class', () => {
    expect(getMessageRoleClass(MessageRoleEnum.User)).toBe('user-msg')
    expect(getMessageRoleClass(MessageRoleEnum.Assistant)).toBe('assistant-msg')
    expect(getMessageRoleClass(MessageRoleEnum.System)).toBe('system-msg')
    expect(getMessageRoleClass(MessageRoleEnum.Tool)).toBe('tool-msg')
  })
})

describe('Message layout alignment', () => {
  test('keeps user messages left-aligned in classic layout', () => {
    expect(shouldRightAlignMessage('left', MessageRoleEnum.User)).toBe(false)
  })

  test('right-aligns user messages only in bubble layout', () => {
    expect(shouldRightAlignMessage('bubble', MessageRoleEnum.User)).toBe(true)
    expect(shouldRightAlignMessage('bubble', MessageRoleEnum.Assistant)).toBe(false)
  })

  test('does not right-align system or tool messages in any layout', () => {
    expect(shouldRightAlignMessage('left', MessageRoleEnum.System)).toBe(false)
    expect(shouldRightAlignMessage('bubble', MessageRoleEnum.System)).toBe(false)
    expect(shouldRightAlignMessage('left', MessageRoleEnum.Tool)).toBe(false)
    expect(shouldRightAlignMessage('bubble', MessageRoleEnum.Tool)).toBe(false)
  })
})
