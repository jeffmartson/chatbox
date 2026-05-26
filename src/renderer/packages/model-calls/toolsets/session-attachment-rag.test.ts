import { beforeEach, describe, expect, test, vi } from 'vitest'

const queryMock = vi.fn()
const getAttachmentsMock = vi.fn()
const getSessionRagConfigMock = vi.fn()
const getLicenseKeyMock = vi.fn()
const getSettingsMock = vi.fn()

vi.mock('@/platform', () => ({
  default: {
    getSessionAttachmentRagController: () => ({
      getAttachments: getAttachmentsMock,
      query: queryMock,
      readParents: vi.fn(),
    }),
  },
}))

vi.mock('@/packages/remote', () => ({
  getSessionRagConfig: getSessionRagConfigMock,
}))

vi.mock('@/stores/settingActions', () => ({
  getLicenseKey: getLicenseKeyMock,
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: getSettingsMock,
  },
}))

describe('session attachment RAG toolset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAttachmentsMock.mockResolvedValue([
      {
        id: 1,
        filename: 'large.pdf',
        status: 'ready',
      },
    ])
    getLicenseKeyMock.mockReturnValue(undefined)
    getSessionRagConfigMock.mockResolvedValue(undefined)
    getSettingsMock.mockReturnValue({
      defaultRerankModel: {
        provider: 'cohere',
        model: 'rerank-v3.5',
      },
    })
    queryMock.mockResolvedValue([])
  })

  test('uses local default rerank model when remote session RAG rerank model is unavailable', async () => {
    const { getToolSet } = await import('./session-attachment-rag')
    const toolset = await getToolSet([1])
    const executeQuery = toolset.tools.query_session_attachment.execute
    expect(executeQuery).toBeDefined()

    await executeQuery?.(
      { query: 'budget summary', limit: 3 },
      {
        toolCallId: 'call-1',
        messages: [],
      }
    )

    expect(queryMock).toHaveBeenCalledWith({
      attachmentIds: [1],
      query: 'budget summary',
      plan: {
        recallTopK: 20,
        finalTopK: 3,
        rerank: {
          enabled: true,
          model: 'cohere:rerank-v3.5',
        },
      },
    })
  })

  test('local default rerank model wins over remote session RAG rerank model', async () => {
    getSessionRagConfigMock.mockResolvedValue({
      capabilities: {
        session_attachment_rerank: true,
      },
      models: {
        rerank: 'chatbox-ai:rerank',
      },
    })

    const { getToolSet } = await import('./session-attachment-rag')
    const toolset = await getToolSet([1])
    const executeQuery = toolset.tools.query_session_attachment.execute
    expect(executeQuery).toBeDefined()

    await executeQuery?.(
      { query: 'budget summary' },
      {
        toolCallId: 'call-1',
        messages: [],
      }
    )

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          rerank: {
            enabled: true,
            model: 'cohere:rerank-v3.5',
          },
        }),
      })
    )
  })
})
