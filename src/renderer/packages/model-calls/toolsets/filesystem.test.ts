import { SANDBOX_EXEC_ERROR_CODES, type SandboxExecResult, type SandboxProvider } from '@shared/sandbox-provider'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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

const trackAgentModeFullAccessBypass = vi.fn()
vi.mock('@/analytics/agent-mode', () => ({
  trackAgentModeFullAccessBypass: (...args: unknown[]) => trackAgentModeFullAccessBypass(...args),
}))

import { buildFilesystemTools } from './filesystem'

const exec = vi.fn(async (..._args: unknown[]): Promise<SandboxExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }))

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
  return await executable.execute(input, { toolCallId: 'tool-call-id', messages: [] })
}

async function toModelOutput(tool: unknown, output: unknown) {
  const mapper = tool as {
    toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown> | unknown
  }
  return await mapper.toModelOutput({ toolCallId: 'tool-call-id', input: {}, output })
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

  test('write_file maps structured results to readable model text', async () => {
    await expect(
      toModelOutput(getTools().write_file, { success: true, file_path: '/tmp/output.txt' })
    ).resolves.toEqual({
      type: 'text',
      value: 'Status: success\nAction: write_file\nPath: /tmp/output.txt',
    })
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

  test('edit_file maps structured results to readable model text', async () => {
    await expect(
      toModelOutput(getTools().edit_file, { success: true, file_path: '/tmp/output.txt', edits: 2 })
    ).resolves.toEqual({
      type: 'text',
      value: 'Status: success\nAction: edit_file\nPath: /tmp/output.txt\nEdits applied: 2',
    })
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

  test('preserves a real /home/user path and routes it through approval', async () => {
    const realHomeProvider = {
      ...provider,
      getStatus: async () => ({ workingDirectory: '/sandbox/root', homeDirectory: '/home/user' }),
    } as unknown as SandboxProvider
    const tools = buildFilesystemTools({ sessionId: 'session-id', provider: realHomeProvider }).tools

    await execute(tools.write_file, { file_path: '/home/user/report.txt', content: 'hello' })

    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
    expect(fsWrite).toHaveBeenCalledWith({ filePath: '/home/user/report.txt', content: 'hello' })
  })
})

describe('user-granted working directories (like /tmp)', () => {
  beforeEach(() => {
    fsWrite.mockClear()
    exec.mockClear()
    requestFileMutationApproval.mockClear()
    trackAgentModeFullAccessBypass.mockClear()
  })

  function toolsWithWorkingDir() {
    return buildFilesystemTools({
      sessionId: 'session-id',
      provider,
      userWorkingDirectories: ['/Users/me/project'],
    }).tools
  }

  test('writing inside a granted dir goes through the sandbox without approval', async () => {
    const result = await execute(toolsWithWorkingDir().write_file, {
      file_path: '/Users/me/project/out.txt',
      content: 'hi',
    })
    expect(requestFileMutationApproval).not.toHaveBeenCalled()
    expect(fsWrite).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, file_path: '/Users/me/project/out.txt' })
  })

  test('a sibling path outside the granted dir still requires approval', async () => {
    await execute(toolsWithWorkingDir().write_file, { file_path: '/Users/me/project-evil/out.txt', content: 'x' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
  })

  test('.. traversal out of the granted dir cannot spoof a match', async () => {
    await execute(toolsWithWorkingDir().write_file, { file_path: '/Users/me/project/../secret.txt', content: 'x' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
  })

  test('binding the filesystem root does not exempt every absolute path from approval', async () => {
    const tools = buildFilesystemTools({ sessionId: 'session-id', provider, userWorkingDirectories: ['/'] }).tools
    await execute(tools.write_file, { file_path: '/etc/passwd', content: 'x' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).toHaveBeenCalledTimes(1)
  })

  test('full access writes absolute paths without approval', async () => {
    const tools = buildFilesystemTools({ sessionId: 'session-id', provider, fullAccess: true }).tools
    await execute(tools.write_file, { file_path: '/Users/me/project/out.txt', content: 'x' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).not.toHaveBeenCalled()
    expect(fsWrite).toHaveBeenCalledTimes(1)
    expect(trackAgentModeFullAccessBypass).toHaveBeenCalledWith({ tool: 'write_file' })
  })

  test('full access edits absolute paths without approval', async () => {
    const tools = buildFilesystemTools({ sessionId: 'session-id', provider, fullAccess: true }).tools
    await execute(tools.edit_file, { file_path: '/Users/me/project/out.txt', old_text: 'a', new_text: 'b' })
    expect(exec).not.toHaveBeenCalled()
    expect(requestFileMutationApproval).not.toHaveBeenCalled()
    expect(fsEdit).toHaveBeenCalledTimes(1)
    expect(trackAgentModeFullAccessBypass).toHaveBeenCalledWith({ tool: 'edit_file' })
  })

  test('full access bypass is tracked even when the write fails', async () => {
    fsWrite.mockResolvedValueOnce({ success: false, error: 'permission denied' } as never)
    const tools = buildFilesystemTools({ sessionId: 'session-id', provider, fullAccess: true }).tools
    await execute(tools.write_file, { file_path: '/etc/hosts', content: 'x' })
    expect(trackAgentModeFullAccessBypass).toHaveBeenCalledWith({ tool: 'write_file' })
  })

  test('bypass is not tracked for pre-approved calls or working-directory writes', async () => {
    const approvedTools = buildFilesystemTools({ sessionId: 'session-id', provider, fullAccess: true }).tools
    const executable = approvedTools.write_file as {
      execute: (input: unknown, options: { toolCallId: string; messages: []; approved?: boolean }) => Promise<unknown>
    }
    await executable.execute(
      { file_path: '/Users/me/project/out.txt', content: 'x' },
      { toolCallId: 'tool-call-id', messages: [], approved: true }
    )
    expect(trackAgentModeFullAccessBypass).not.toHaveBeenCalled()

    // Working-directory paths are sandbox-routed before the bypass check.
    const wdTools = buildFilesystemTools({
      sessionId: 'session-id',
      provider,
      fullAccess: true,
      userWorkingDirectories: ['/Users/me/granted'],
    }).tools
    await execute(wdTools.write_file, { file_path: '/Users/me/granted/out.txt', content: 'x' })
    expect(trackAgentModeFullAccessBypass).not.toHaveBeenCalled()
  })
})

describe('search_files sandbox grep command', () => {
  beforeEach(() => {
    exec.mockClear()
  })

  function lastGrepCode(): string {
    const call = exec.mock.calls.at(-1)?.[0] as { code: string } | undefined
    return call?.code ?? ''
  }

  test('literal search uses fixed-string (-F) flag and excludes heavy dirs', async () => {
    await execute(getTools().search_files, { path: '/tmp/project', query: 'foo(bar)' })
    const code = lastGrepCode()
    expect(code).toContain('grep -RInF')
    expect(code).not.toContain('-RInE')
    expect(code).toContain("--exclude-dir='node_modules'")
    expect(code).toContain("--exclude-dir='.git'")
    expect(code).toContain('-m 50')
    expect(code).toContain('head -100')
    // pattern passed via -e and shell-quoted
    expect(code).toContain("-e 'foo(bar)'")
  })

  test('regex search uses extended-regex (-E) flag', async () => {
    await execute(getTools().search_files, { path: '/tmp/project', query: 'foo.*bar', regex: true })
    const code = lastGrepCode()
    expect(code).toContain('grep -RInE')
    expect(code).not.toContain('-RInF')
  })

  test('include filter is forwarded as --include', async () => {
    await execute(getTools().search_files, { path: '/tmp/project', query: 'x', include: '*.ts' })
    expect(lastGrepCode()).toContain("--include='*.ts'")
  })

  test('search_files maps content objects to plain model text', async () => {
    await expect(toModelOutput(getTools().search_files, { content: 'src/a.ts:1:match' })).resolves.toEqual({
      type: 'text',
      value: 'src/a.ts:1:match',
    })
  })

  test('search_files maps empty content to a no-matches result', async () => {
    await expect(toModelOutput(getTools().search_files, { content: '' })).resolves.toEqual({
      type: 'text',
      value: 'No matches found.',
    })
  })

  test('preserves Bash availability errors for the UI and model', async () => {
    exec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'bash is not available',
      exitCode: 127,
      errorCode: SANDBOX_EXEC_ERROR_CODES.BASH_NOT_AVAILABLE,
    })

    const tool = getTools().search_files
    const result = await execute(tool, { path: '/tmp/project', query: 'needle' })

    expect(result).toEqual({
      error: 'bash is not available',
      errorCode: SANDBOX_EXEC_ERROR_CODES.BASH_NOT_AVAILABLE,
    })
    await expect(toModelOutput(tool, result)).resolves.toEqual({
      type: 'text',
      value: 'Error code: BASH_NOT_AVAILABLE\n\nError: bash is not available',
    })
  })
})

describe('list_files model output', () => {
  test('list_files maps empty content to an empty-directory result', async () => {
    await expect(toModelOutput(getTools().list_files, { content: '' })).resolves.toEqual({
      type: 'text',
      value: 'Directory is empty.',
    })
  })

  test('preserves Bash availability errors for the UI and model', async () => {
    exec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'bash is not available',
      exitCode: 127,
      errorCode: SANDBOX_EXEC_ERROR_CODES.BASH_NOT_AVAILABLE,
    })

    const tool = getTools().list_files
    const result = await execute(tool, { path: '/tmp/project' })

    expect(result).toEqual({
      error: 'bash is not available',
      errorCode: SANDBOX_EXEC_ERROR_CODES.BASH_NOT_AVAILABLE,
    })
    await expect(toModelOutput(tool, result)).resolves.toEqual({
      type: 'text',
      value: 'Error code: BASH_NOT_AVAILABLE\n\nError: bash is not available',
    })
  })
})
