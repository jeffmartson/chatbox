import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  }
  const windowMock: Record<string, unknown> = {
    electronAPI: undefined,
    localStorage: storage,
  }
  ;(globalThis as unknown as { window: Record<string, unknown>; localStorage: typeof storage }).window = windowMock
  ;(globalThis as unknown as { window: Record<string, unknown>; localStorage: typeof storage }).localStorage = storage
  return {}
})

vi.mock('@/platform', () => ({
  default: { type: 'web' },
}))

import type { AgentModeEntry } from '@shared/types'
import { uiStore } from '../../uiStore'
import { getSessionAgentMode } from '../utils'

const defaultEntry: AgentModeEntry = { value: 'auto', locked: false, lockReason: null }

beforeEach(() => {
  // Reset agent mode map before each test
  uiStore.setState({ sessionAgentModeMap: {} })
})

describe('setSessionAgentMode', () => {
  test('sets value for a session', () => {
    uiStore.getState().setSessionAgentMode('session-1', 'on')
    const entry = uiStore.getState().sessionAgentModeMap['session-1']
    expect(entry).toBeDefined()
    expect(entry.value).toBe('on')
  })

  test('default entry for unknown session is { value: "auto", locked: false, lockReason: null }', () => {
    // Before any explicit set, the map has no entry; getSessionAgentMode returns the default
    const entry = uiStore.getState().sessionAgentModeMap['unknown-session']
    expect(entry).toBeUndefined()

    // After setting a value, locked/lockReason default to false/null
    uiStore.getState().setSessionAgentMode('new-session', 'auto')
    const created = uiStore.getState().sessionAgentModeMap['new-session']
    expect(created).toEqual({ value: 'auto', locked: false, lockReason: null })
  })

  test('blocks setting "off" when locked', () => {
    // Lock the session first
    uiStore.getState().lockSessionAgentMode('session-locked', 'message_sent')
    const before = uiStore.getState().sessionAgentModeMap['session-locked']
    expect(before.value).toBe('on')
    expect(before.locked).toBe(true)

    // Try to set to 'off' — should be blocked
    uiStore.getState().setSessionAgentMode('session-locked', 'off')
    const after = uiStore.getState().sessionAgentModeMap['session-locked']
    expect(after.value).toBe('on')
    expect(after.locked).toBe(true)
  })

  test('blocks setting "auto" when locked (Issue 2A fix)', () => {
    uiStore.getState().lockSessionAgentMode('session-locked-2a', 'file_upload')
    const before = uiStore.getState().sessionAgentModeMap['session-locked-2a']
    expect(before.value).toBe('on')

    // Try to set to 'auto' — should be blocked
    uiStore.getState().setSessionAgentMode('session-locked-2a', 'auto')
    const after = uiStore.getState().sessionAgentModeMap['session-locked-2a']
    expect(after.value).toBe('on')
    expect(after.locked).toBe(true)
  })

  test('allows setting "on" when locked', () => {
    uiStore.getState().lockSessionAgentMode('session-locked-on', 'load_skill')

    // Setting to 'on' should succeed even when locked
    uiStore.getState().setSessionAgentMode('session-locked-on', 'on')
    const after = uiStore.getState().sessionAgentModeMap['session-locked-on']
    expect(after.value).toBe('on')
    expect(after.locked).toBe(true)
  })
})

describe('lockSessionAgentMode', () => {
  test('sets value="on", locked=true, and lockReason', () => {
    uiStore.getState().lockSessionAgentMode('session-lock', 'message_sent')
    const entry = uiStore.getState().sessionAgentModeMap['session-lock']
    expect(entry).toEqual({ value: 'on', locked: true, lockReason: 'message_sent' })
  })

  test.each(['message_sent', 'file_upload', 'load_skill'] as const)('with reason type: %s', (reason) => {
    uiStore.getState().lockSessionAgentMode(`session-${reason}`, reason)
    const entry = uiStore.getState().sessionAgentModeMap[`session-${reason}`]
    expect(entry.value).toBe('on')
    expect(entry.locked).toBe(true)
    expect(entry.lockReason).toBe(reason)
  })
})

describe('clearSessionAgentMode', () => {
  test('removes single session entry', () => {
    uiStore.getState().setSessionAgentMode('session-a', 'on')
    uiStore.getState().setSessionAgentMode('session-b', 'auto')

    uiStore.getState().clearSessionAgentMode('session-a')

    expect(uiStore.getState().sessionAgentModeMap['session-a']).toBeUndefined()
    expect(uiStore.getState().sessionAgentModeMap['session-b']).toBeDefined()
  })

  test('clears all entries when called without sessionId', () => {
    uiStore.getState().setSessionAgentMode('session-x', 'on')
    uiStore.getState().setSessionAgentMode('session-y', 'off')

    uiStore.getState().clearSessionAgentMode()

    expect(uiStore.getState().sessionAgentModeMap).toEqual({})
  })
})

describe('getSessionAgentMode (from utils.ts)', () => {
  test('returns default for unknown session', () => {
    const entry = getSessionAgentMode('nonexistent-session')
    expect(entry).toEqual(defaultEntry)
  })

  test('returns stored entry for known session', () => {
    uiStore.getState().lockSessionAgentMode('known-session', 'file_upload')
    const entry = getSessionAgentMode('known-session')
    expect(entry).toEqual({ value: 'on', locked: true, lockReason: 'file_upload' })
  })
})
