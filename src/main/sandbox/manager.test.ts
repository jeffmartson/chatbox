import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SANDBOX_EXEC_ERROR_CODES } from '../../shared/sandbox-provider'

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../util', () => ({
  getLogger: () => logger,
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }))

import { spawn, spawnSync } from 'node:child_process'
import {
  execCode,
  findFiles,
  initSandbox,
  listDir,
  normalizeWindowsShellPath,
  readFile,
  resetSandbox,
  resolveWindowsBash,
  shellEscape,
} from './manager'

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('shellEscape', () => {
  test('wraps a simple string in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'")
  })

  test('escapes embedded single quotes', () => {
    const result = shellEscape("it's")
    // The standard shell-quote approach: end current quote, add escaped quote, restart quote
    expect(result).toBe("'it'\\''s'")
  })

  test('handles empty string', () => {
    expect(shellEscape('')).toBe("''")
  })

  test('handles shell special characters without interpreting them', () => {
    const specials = ['$HOME', '`whoami`', 'a;b', 'a|b', 'a&b', 'a>b', 'a<b']
    for (const s of specials) {
      const result = shellEscape(s)
      // Single-quoted strings prevent shell interpretation, so the value should be wrapped
      expect(result).toBe(`'${s}'`)
    }
  })

  test('handles strings with newlines', () => {
    const result = shellEscape('line1\nline2')
    expect(result).toBe("'line1\nline2'")
  })

  test('handles null bytes without crashing', () => {
    expect(() => shellEscape('a\0b')).not.toThrow()
    const result = shellEscape('a\0b')
    expect(typeof result).toBe('string')
  })

  test('handles string that is only single quotes', () => {
    const result = shellEscape("'''")
    // Each ' becomes '\'' so: '' + \' + '' + \' + '' + \' + ''
    expect(result).toBe("''\\'''\\'''\\'''")
  })

  test('handles spaces and tabs', () => {
    expect(shellEscape('hello world')).toBe("'hello world'")
    expect(shellEscape('hello\tworld')).toBe("'hello\tworld'")
  })
})

describe('resolveWindowsBash', () => {
  const mockShellAvailability = ({
    bash = false,
    wslStatus = 1,
    wslDistros = '',
  }: {
    bash?: boolean
    wslStatus?: number
    wslDistros?: string
  }) => {
    ;(spawnSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'bash' && args[0] === '--version') return { status: bash ? 0 : 1 }
      if (cmd === 'wsl' && args[0] === '--list') {
        return {
          status: wslStatus,
          stdout: Buffer.from(`\uFEFF${wslDistros}`, 'utf16le'),
        }
      }
      return { status: 1 }
    })
  }

  test('prefers bash on PATH', () => {
    mockShellAvailability({ bash: true, wslStatus: 0, wslDistros: 'Ubuntu\n' })
    expect(resolveWindowsBash()).toEqual({ cmd: 'bash', args: [] })
  })

  test('falls back to wsl bash when bash is absent and a distribution is installed', () => {
    mockShellAvailability({ wslStatus: 0, wslDistros: 'Ubuntu\n' })
    expect(resolveWindowsBash()).toEqual({ cmd: 'wsl', args: ['bash'] })
  })

  test('returns null when wsl exists without an installed distribution', () => {
    mockShellAvailability({ wslStatus: 0, wslDistros: '' })
    expect(resolveWindowsBash()).toBeNull()
  })

  test('returns null when neither bash nor wsl is available', () => {
    mockShellAvailability({})
    expect(resolveWindowsBash()).toBeNull()
  })
})

describe('execCode on Windows without Bash', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    vi.clearAllMocks()
  })

  test('returns a stable error code for localized UI handling', async () => {
    setPlatform('win32')
    ;(spawnSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) =>
      cmd === 'wsl' ? { status: 0, stdout: Buffer.alloc(0) } : { status: 1 }
    )
    const workDir = mkdtempSync(path.join(tmpdir(), 'chatbox-no-bash-'))
    const sessionId = 'no-bash-session'
    try {
      await initSandbox(workDir, sessionId)
      const result = await execCode({ code: 'echo hello', language: 'bash', sessionId })

      expect(result).toEqual({
        stdout: '',
        stderr: 'bash is not available on this Windows host. Install Git Bash or enable WSL, or use node.',
        exitCode: 127,
        errorCode: SANDBOX_EXEC_ERROR_CODES.BASH_NOT_AVAILABLE,
      })

      const operationResults = await Promise.all([
        readFile('report.txt', sessionId),
        listDir('.', sessionId),
        findFiles('.', '*.txt', sessionId),
      ])
      for (const operationResult of operationResults) {
        expect(operationResult).toMatchObject({
          success: false,
          errorCode: SANDBOX_EXEC_ERROR_CODES.BASH_NOT_AVAILABLE,
        })
      }
    } finally {
      await resetSandbox(sessionId)
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test('logs only one finish record when spawn emits error and close', async () => {
    setPlatform('win32')
    const workDir = mkdtempSync(path.join(tmpdir(), 'chatbox-spawn-error-'))
    const sessionId = 'spawn-error-session'
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
      killed: false,
      pid: 123,
    })
    ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child)

    try {
      await initSandbox(workDir, sessionId)
      const execution = execCode({ code: 'console.log("hello")', language: 'node', sessionId })
      child.emit('error', new Error('spawn failed'))
      child.emit('close', -2)

      await expect(execution).rejects.toThrow('spawn failed')
      const finishLogs = logger.warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.startsWith('agent_operation finish ')
      )
      expect(finishLogs).toHaveLength(1)
    } finally {
      await resetSandbox(sessionId)
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe('normalizeWindowsShellPath', () => {
  afterEach(() => setPlatform(originalPlatform))

  test('converts Git Bash, WSL and Cygwin paths to native Windows form on win32', () => {
    setPlatform('win32')
    expect(normalizeWindowsShellPath('/c/Users/a/out.txt')).toBe('C:\\Users\\a\\out.txt')
    expect(normalizeWindowsShellPath('/mnt/c/data/x.csv')).toBe('C:\\data\\x.csv')
    expect(normalizeWindowsShellPath('/cygdrive/d/y')).toBe('D:\\y')
    expect(normalizeWindowsShellPath('/c')).toBe('C:\\')
  })

  test('leaves already-Windows and non-drive POSIX paths unchanged on win32', () => {
    setPlatform('win32')
    expect(normalizeWindowsShellPath('C:\\foo\\bar')).toBe('C:\\foo\\bar')
    expect(normalizeWindowsShellPath('/home/alice/x')).toBe('/home/alice/x')
  })

  test('is a no-op on POSIX platforms', () => {
    setPlatform('linux')
    expect(normalizeWindowsShellPath('/c/x')).toBe('/c/x')
  })
})
