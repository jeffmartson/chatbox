import { beforeEach, describe, expect, test, vi } from 'vitest'

const { filesystemMock, toastMock, documentSaverMock, loggerMock } = vi.hoisted(() => ({
  filesystemMock: {
    appendFile: vi.fn(),
    checkPermissions: vi.fn(),
    deleteFile: vi.fn(),
    downloadFile: vi.fn(),
    getUri: vi.fn(),
    mkdir: vi.fn(),
    requestPermissions: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
  },
  toastMock: {
    show: vi.fn(),
  },
  documentSaverMock: {
    saveFile: vi.fn(),
  },
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Cache: 'CACHE',
    Documents: 'DOCUMENTS',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: filesystemMock,
}))

vi.mock('@capacitor/share', () => ({
  Share: {
    share: vi.fn(),
  },
}))

vi.mock('@capacitor/toast', () => ({ Toast: toastMock }))
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/lib/utils', () => ({ getLogger: () => loggerMock }))
vi.mock('./android_document_saver', () => ({ AndroidDocumentSaver: documentSaverMock }))

import { AndroidFilterWriter, getRedactedUrlForLog, HandledExportError, isSaveCanceledError } from './filter_writer'
import MobileExporter from './mobile_exporter'

describe('AndroidFilterWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    filesystemMock.checkPermissions.mockResolvedValue({ publicStorage: 'granted' })
    filesystemMock.mkdir.mockResolvedValue(undefined)
    filesystemMock.writeFile.mockResolvedValue({ uri: 'cache://temporary-export' })
    filesystemMock.appendFile.mockResolvedValue(undefined)
    filesystemMock.deleteFile.mockResolvedValue(undefined)
    toastMock.show.mockResolvedValue(undefined)
    documentSaverMock.saveFile.mockResolvedValue({ uri: 'content://saved-export' })
  })

  test('creates the nested cache path before downloading a URL fallback', async () => {
    const documentsError = Object.assign(new Error('Missing parent directory'), {
      code: 'OS-PLUG-FILE-0011',
    })
    filesystemMock.downloadFile
      .mockRejectedValueOnce(documentsError)
      .mockResolvedValueOnce({ path: '/cache/chatbox_temp_exports/image.png' })

    await new AndroidFilterWriter().exportByUrl('image.png', 'https://example.com/image.png')

    expect(filesystemMock.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        data: '',
        directory: 'CACHE',
        recursive: true,
      })
    )
    const preparedPath = filesystemMock.writeFile.mock.calls[0][0].path
    expect(preparedPath).toMatch(/^chatbox_temp_exports\/.+-image\.png$/)
    expect(filesystemMock.downloadFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        directory: 'CACHE',
        path: preparedPath,
      })
    )
    expect(documentSaverMock.saveFile).toHaveBeenCalledWith({
      sourceUri: '/cache/chatbox_temp_exports/image.png',
      suggestedName: 'image.png',
      mimeType: 'image/png',
    })
    expect(toastMock.show).toHaveBeenCalledTimes(1)
    expect(toastMock.show).toHaveBeenCalledWith({ text: 'File saved to {{uri}}' })
    expect(filesystemMock.deleteFile).toHaveBeenCalledWith({ path: preparedPath, directory: 'CACHE' })
  })

  test('streams a large fallback to cache in bounded chunks', async () => {
    const firstChunk = 'a'.repeat(1024 * 1024)
    const finalChunk = 'tail'
    const dataCallback = async function* () {
      await Promise.resolve()
      yield firstChunk
      yield finalChunk
    }

    await new AndroidFilterWriter().exportStreamingFileWithSystemPicker('backup.json', dataCallback, 'application/json')

    expect(filesystemMock.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        data: firstChunk,
        directory: 'CACHE',
        encoding: 'utf8',
        recursive: true,
      })
    )
    const tempPath = filesystemMock.writeFile.mock.calls[0][0].path
    expect(filesystemMock.appendFile).toHaveBeenCalledWith({
      path: tempPath,
      data: finalChunk,
      directory: 'CACHE',
      encoding: 'utf8',
    })
    expect(documentSaverMock.saveFile).toHaveBeenCalledWith({
      sourceUri: 'cache://temporary-export',
      suggestedName: 'backup.json',
      mimeType: 'application/json',
    })
    expect(filesystemMock.deleteFile).toHaveBeenCalledWith({ path: tempPath, directory: 'CACHE' })
  })

  test('uses the native cancellation code without hiding malformed success results', () => {
    expect(isSaveCanceledError({ code: 'SAVE_CANCELED', message: 'localized cancellation' })).toBe(true)
    expect(isSaveCanceledError({ code: 'MISSING_TARGET_URI', message: 'Save failed: missing target uri' })).toBe(false)
  })

  test('redacts paths and credentials from exported URL logs', () => {
    const url = 'https://user:password@example.com/private/image.png?token=secret#fragment'

    expect(getRedactedUrlForLog(url)).toBe('https://example.com')
    expect(getRedactedUrlForLog('not a url')).toBe('invalid-url')
  })
})

describe('MobileExporter', () => {
  test('does not leak an already-notified Android export failure to fire-and-forget callers', async () => {
    vi.spyOn(AndroidFilterWriter.prototype, 'exportTextFile').mockRejectedValueOnce(
      new HandledExportError(new Error('fallback failed'))
    )

    await expect(new MobileExporter().exportTextFile('export.txt', 'content')).resolves.toBeUndefined()
  })
})
