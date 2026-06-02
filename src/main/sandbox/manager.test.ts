import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../util', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { shellEscape } from './manager'

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
