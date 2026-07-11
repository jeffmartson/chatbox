import { beforeEach, describe, expect, test, vi } from 'vitest'

// Mock the platform module so we can observe how exec() delegates to sandboxExecCode.
const sandboxExecCode = vi.fn()
const sandboxStatus = vi.fn()
vi.mock('@/platform', () => ({
  default: {
    get sandboxExecCode() {
      return sandboxExecCodeRef.current
    },
    get sandboxStatus() {
      return sandboxStatus
    },
  },
}))

// Indirection so individual tests can toggle sandboxExecCode presence.
const sandboxExecCodeRef: { current: typeof sandboxExecCode | undefined } = { current: sandboxExecCode }

import { LocalSandboxProvider } from './local-provider'

beforeEach(() => {
  sandboxExecCode.mockReset()
  sandboxStatus.mockReset()
  sandboxExecCodeRef.current = sandboxExecCode
})

describe('LocalSandboxProvider.getStatus', () => {
  test('returns the host home directory before the sandbox is initialized', async () => {
    sandboxStatus.mockResolvedValue({
      state: 'idle',
      workingDirectory: null,
      platform: 'linux',
      homeDirectory: '/home/user',
    })
    const provider = new LocalSandboxProvider()

    await expect(provider.getStatus()).resolves.toEqual({
      initialized: false,
      sessionId: undefined,
      workingDirectory: null,
      homeDirectory: '/home/user',
    })
    expect(sandboxStatus).toHaveBeenCalledWith({ sessionId: undefined })
  })
})

describe('LocalSandboxProvider.exec', () => {
  test('forwards raw code/language to sandboxExecCode without any encoding', async () => {
    sandboxExecCode.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })
    const provider = new LocalSandboxProvider()

    const code = "console.log('héllo');\nprocess.exit(0)"
    const result = await provider.exec({ code, language: 'node', timeout: 5_000 })

    expect(sandboxExecCode).toHaveBeenCalledTimes(1)
    const arg = sandboxExecCode.mock.calls[0][0]
    // Code is passed verbatim — no base64, no shell wrapping.
    expect(arg.code).toBe(code)
    expect(arg.language).toBe('node')
    expect(arg.timeout).toBe(5_000)
    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 })
  })

  test('returns an error result when the platform has no sandbox executor', async () => {
    sandboxExecCodeRef.current = undefined
    const provider = new LocalSandboxProvider()

    const result = await provider.exec({ code: 'echo hi', language: 'bash' })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Sandbox not available')
  })
})
