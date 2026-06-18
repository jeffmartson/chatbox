import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../util', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { shellEscape, toSandboxShellPath } from './manager'

const originalPlatform = process.platform
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
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

describe('toSandboxShellPath', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
  })

  test('rewrites a Windows-absolute path to its WSL mount form on win32', () => {
    setPlatform('win32')
    expect(toSandboxShellPath('C:\\Users\\alice\\file.txt')).toBe('/mnt/c/Users/alice/file.txt')
    expect(toSandboxShellPath('D:/data/out.csv')).toBe('/mnt/d/data/out.csv')
  })

  test('leaves relative and POSIX-absolute paths untouched on win32', () => {
    setPlatform('win32')
    expect(toSandboxShellPath('sub/dir/file.txt')).toBe('sub/dir/file.txt')
    expect(toSandboxShellPath('/tmp/file.txt')).toBe('/tmp/file.txt')
  })

  test('is a no-op on POSIX platforms', () => {
    setPlatform('linux')
    expect(toSandboxShellPath('C:\\Users\\alice')).toBe('C:\\Users\\alice')
    expect(toSandboxShellPath('/home/alice/file.txt')).toBe('/home/alice/file.txt')
  })
})
