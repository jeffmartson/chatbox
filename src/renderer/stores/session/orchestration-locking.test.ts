import { beforeEach, describe, expect, it, vi } from 'vitest'

const { withSessionGenerationLockMock } = vi.hoisted(() => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  }
  ;(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage
  ;(globalThis as unknown as { window: { localStorage: typeof storage } }).window = { localStorage: storage }
  return { withSessionGenerationLockMock: vi.fn(() => Promise.resolve()) }
})

vi.mock('./generation-lock', () => ({
  withSessionGenerationLock: withSessionGenerationLockMock,
}))
vi.mock('../chatStore', () => ({}))

import { continuePausedToolCall, retryFromLastToolCallAfterApiError, stopPausedToolCall } from './orchestration'

describe('paused tool-call generation entry-point locking', () => {
  beforeEach(() => {
    withSessionGenerationLockMock.mockClear()
  })

  it.each([
    ['approval denial', stopPausedToolCall],
    ['approval continuation', continuePausedToolCall],
    ['API retry', retryFromLastToolCallAfterApiError],
  ])('serializes %s with other generation work', async (_name, run) => {
    await run('session-1', 'message-1', 'tool-1')

    expect(withSessionGenerationLockMock).toHaveBeenCalledOnce()
    expect(withSessionGenerationLockMock).toHaveBeenCalledWith('session-1', expect.any(Function))
  })
})
