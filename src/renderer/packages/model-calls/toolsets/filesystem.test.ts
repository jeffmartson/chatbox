import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SandboxProvider } from '@shared/sandbox-provider'

const fsWrite = vi.fn(async (..._args: unknown[]) => ({ success: true }))
const fsEdit = vi.fn(async (..._args: unknown[]) => ({ success: true }))

vi.mock('@/platform', () => ({
  default: {
    type: 'web',
    fsWrite: (...args: unknown[]) => fsWrite(...args),
    fsEdit: (...args: unknown[]) => fsEdit(...args),
  },
}))

const requestFileMutationApproval = vi.fn(async (..._args: unknown[]) => true)
vi.mock('@/packages/user-exec-approval', () => ({
  requestFileMutationApproval: (...args: unknown[]) => requestFileMutationApproval(...args),
}))

import { buildFilesystemTools } from './filesystem'

const exec = vi.fn(async (..._args: unknown[]) => ({ stdout: '', stderr: '', exitCode: 0 }))

// Provider whose sandbox root never contains the tested absolute paths, so non-/tmp paths
// take the real-filesystem branch where approval would normally be requested. /tmp paths
// are routed through the sandbox (provider.exec) instead.
const provider = {
  init: async () => ({ success: true }),
  getStatus: async () => ({ workingDirectory: '/sandbox/root' }),
  exec: (...args: unknown[]) => exec(...args),
} as unknown as SandboxProvider

function getTools() {
  return buildFilesystemTools({ sessionId: 'session-id', provider }).tools
}

async function execute(tool: unknown, input: unknown) {
  const executable = tool as {
    execute: (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>
  }
  return executable.execute(input, { toolCallId: 'tool-call-id', messages: [] })
}

describe('filesystem write to sandbox-writable temp (/tmp)', () => {
  beforeEach(() => {
    fsWrite.mockClear()
    fsEdit.mockClear()
    exec.mockClear()
    requestFileMutationApproval.mockClear()
  })

  test('writing under /tmp goes through the sandbox without approval or real-fs write', async () => {
    const result = await execute(getTools().write_file, { file_path: '/tmp/output.txt', content: 'hello' })
    expect(requestFileMutationApproval).not.toHaveBeenCalled()
    expect(fsWrite).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, file_path: '/tmp/output.txt' })
  })

  test('editing under /tmp goes through the sandbox without approval or real-fs edit', async () => {
    const result = await execute(getTools().edit_file, {
      file_path: '/tmp/output.txt',
      old_text: 'a',
      new_text: 'b',
    })
    expect(requestFileMutationApproval).not.toHaveBeenCalled()
    expect(fsEdit).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, file_path: '/tmp/output.txt', edits: 1 })
  })

  test('a /tmp-prefixed sibling path is not treated as sandbox-writable', async () => {
    await execute(getTools().write_file, { file_path: '/tmpfoo/output.txt', content: 'hello' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
  })

  test('a /tmp path that escapes via .. is not sandbox-writable (requires approval)', async () => {
    // path.resolve() on the main side collapses '..', so the real write target is outside
    // /tmp — it must not be routed through the sandbox nor skip approval.
    await execute(getTools().write_file, { file_path: '/tmp/../Users/alice/.zshrc', content: 'evil' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
  })

  test('on Windows, /tmp is not sandbox-writable (sandbox does not whitelist it there)', async () => {
    const original = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true,
    })
    try {
      await execute(getTools().write_file, { file_path: '/tmp/output.txt', content: 'hello' })
      expect(exec).not.toHaveBeenCalled()
      expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
    }
  })

  test('writing other absolute paths still requires approval and uses the real fs', async () => {
    await execute(getTools().write_file, { file_path: '/Users/someone/secret.txt', content: 'hello' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
    expect(fsWrite).toHaveBeenCalledTimes(1)
  })
})
