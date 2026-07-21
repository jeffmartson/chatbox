import { describe, expect, it } from 'vitest'
import { localFilePathToUrl } from './local-file-url'

describe('localFilePathToUrl', () => {
  it('creates a valid file URL for a Windows drive path', () => {
    expect(localFilePathToUrl('C:\\Users\\Alice\\chatbox-sandbox\\screenshot.png')).toBe(
      'file:///C:/Users/Alice/chatbox-sandbox/screenshot.png'
    )
  })

  it('encodes reserved characters in local file paths', () => {
    expect(localFilePathToUrl('C:\\Users\\Alice Smith\\chatbox-sandbox\\shot #1.png')).toBe(
      'file:///C:/Users/Alice%20Smith/chatbox-sandbox/shot%20%231.png'
    )
  })

  it('preserves POSIX file URL behavior', () => {
    expect(localFilePathToUrl('/tmp/chatbox-sandbox/screenshot.png')).toBe('file:///tmp/chatbox-sandbox/screenshot.png')
  })

  it('creates a valid file URL for a Windows UNC path', () => {
    expect(localFilePathToUrl('\\\\server\\share\\chatbox-sandbox\\screenshot.png')).toBe(
      'file://server/share/chatbox-sandbox/screenshot.png'
    )
  })
})
