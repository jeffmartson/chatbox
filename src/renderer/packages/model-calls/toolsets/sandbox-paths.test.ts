import { describe, expect, test } from 'vitest'
import { remapPhantomHomePath } from './sandbox-paths'

describe('remapPhantomHomePath', () => {
  test('rewrites /home/user paths to relative', () => {
    expect(remapPhantomHomePath('/home/user/report.txt')).toBe('report.txt')
    expect(remapPhantomHomePath('/home/user/sub/dir/file.csv')).toBe('sub/dir/file.csv')
    expect(remapPhantomHomePath('/home/user')).toBe('.')
  })

  test('rewrites /home/sandbox paths to relative', () => {
    expect(remapPhantomHomePath('/home/sandbox/out.json')).toBe('out.json')
  })

  test('rewrites ~ paths to relative', () => {
    expect(remapPhantomHomePath('~')).toBe('.')
    expect(remapPhantomHomePath('~/notes.md')).toBe('notes.md')
  })

  test('leaves relative paths unchanged', () => {
    expect(remapPhantomHomePath('report.txt')).toBe('report.txt')
    expect(remapPhantomHomePath('./sub/file.txt')).toBe('./sub/file.txt')
  })

  test('leaves genuine absolute paths unchanged', () => {
    expect(remapPhantomHomePath('/tmp/scratch.txt')).toBe('/tmp/scratch.txt')
    expect(remapPhantomHomePath('/Users/alice/Documents/a.txt')).toBe('/Users/alice/Documents/a.txt')
    expect(remapPhantomHomePath('/home/alice/a.txt')).toBe('/home/alice/a.txt')
  })

  test('does not partial-match similar prefixes', () => {
    // /home/username should NOT be treated as /home/user
    expect(remapPhantomHomePath('/home/username/a.txt')).toBe('/home/username/a.txt')
  })

  test('handles empty input', () => {
    expect(remapPhantomHomePath('')).toBe('')
  })
})
