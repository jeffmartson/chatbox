import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../util', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }))

import { spawnSync } from 'node:child_process'
import { normalizeWindowsShellPath, resolveWindowsBash, shellEscape } from './manager'

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
  const mockWhich = (present: string[]) => {
    ;(spawnSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((_cmd: string, args: string[]) => ({
      status: present.includes(args[0]) ? 0 : 1,
    }))
  }

  test('prefers bash on PATH', () => {
    mockWhich(['bash', 'wsl'])
    expect(resolveWindowsBash()).toEqual({ cmd: 'bash', args: [] })
  })

  test('falls back to wsl bash when bash is absent', () => {
    mockWhich(['wsl'])
    expect(resolveWindowsBash()).toEqual({ cmd: 'wsl', args: ['bash'] })
  })

  test('returns null when neither bash nor wsl is available', () => {
    mockWhich([])
    expect(resolveWindowsBash()).toBeNull()
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
