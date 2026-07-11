import { beforeEach, describe, expect, test, vi } from 'vitest'

// Mock the platform module so we can observe how exec() delegates to sandboxExecCode.
const sandboxExecCode = vi.fn()
vi.mock('@/platform', () => ({
  default: {
    get sandboxExecCode() {
      return sandboxExecCodeRef.current
    },
  },
}))

// Indirection so individual tests can toggle sandboxExecCode presence.
const sandboxExecCodeRef: { current: typeof sandboxExecCode | undefined } = { current: sandboxExecCode }

import { LocalSandboxProvider } from './local-provider'

beforeEach(() => {
  sandboxExecCode.mockReset()
  sandboxExecCodeRef.current = sandboxExecCode
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
