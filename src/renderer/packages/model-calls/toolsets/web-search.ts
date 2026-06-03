import { ChatboxAIAPIError } from '@shared/models/errors'
import { jsonSchema, type ToolSet } from 'ai'
import * as remote from '@/packages/remote'
import { getParseLinkProvider, webSearchExecutor } from '@/packages/web-search'
import platform from '@/platform'
import * as settingActions from '@/stores/settingActions'

const webSearchDescription = `
Use web_search to search the web when doing so would genuinely improve your answer.

## web_search
Search the web when the question benefits from fresh, real-time, or source-specific information — e.g. current events, recent releases, live data, or facts you aren't confident about. For questions you can already answer well from your own knowledge, answer directly. Use short, concise queries (English preferred).
`

const parseLinkDescription = `
## parse_link
Extract readable content from a specific URL — typically one the user shared or that a prior search returned.
`

export function getToolSetDescription(options: { includeParseLink: boolean }) {
  return options.includeParseLink ? `${webSearchDescription}${parseLinkDescription}` : webSearchDescription
}

export const webSearchTool: ToolSet[string] = {
  description:
    'Search the web for information. Use it when fresh, real-time, or source-specific data would improve the answer (current events, recent releases, live data, facts you are unsure about). For questions you can answer confidently from your own knowledge, answer directly instead. Use short, concise queries (English preferred).',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'the search query' },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  execute: async (input, { abortSignal }) => {
    const searchInput = input as { query: string }
    return await webSearchExecutor({ query: searchInput.query }, { abortSignal })
  },
}

const DEFAULT_PARSE_LINK_MAX_CHARS = 12_000

export const parseLinkTool: ToolSet[string] = {
  description:
    'Parses the readable content of a web page. Use this when you need detailed information from a specific URL — typically one the user shared or that was returned by a prior search.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The URL to parse. Always include the schema, e.g. https://example.com',
      },
      maxLength: {
        type: 'integer',
        minimum: 500,
        maximum: 50_000,
        description: 'Optional maximum number of characters to return from the parsed content.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  }),
  execute: async (input, { abortSignal }) => {
    const parseInput = input as { url: string; maxLength?: number }
    const maxLength = parseInput.maxLength ?? DEFAULT_PARSE_LINK_MAX_CHARS
    const normalizedMaxLength = Math.min(Math.max(maxLength, 500), 50_000)

    const searchProvider = settingActions.getExtensionSettings().webSearch.provider

    // Chatbox AI (build-in) path: requires a license key (any tier — backend has no Pro gate).
    if (searchProvider === 'build-in') {
      const licenseKey = settingActions.getLicenseKey()
      if (!licenseKey) {
        throw ChatboxAIAPIError.fromCodeName(
          'parse_link via Chatbox AI requires a license key, but none is configured',
          'chatbox_search_license_key_required'
        )
      }
      const parsed = await remote.parseUserLinkPro({ licenseKey, url: parseInput.url, abortSignal })
      const storedContent = await platform.getStoreBlob(parsed.storageKey)
      if (storedContent == null) {
        const technical = `parse_link storage blob missing for URL ${parseInput.url} (storageKey: ${parsed.storageKey})`
        throw ChatboxAIAPIError.fromCodeName(technical, 'parse_link_failed') ?? new Error(technical)
      }
      const content = storedContent.trim()
      const truncatedContent = content.slice(0, normalizedMaxLength)
      return {
        url: parseInput.url,
        title: parsed.title,
        content: truncatedContent,
        originalLength: content.length,
        truncated: content.length > truncatedContent.length,
      }
    }

    // Third-party provider path (e.g. Tavily). Throws if API key missing or extraction fails.
    const provider = getParseLinkProvider()
    if (!provider) {
      const technical = `parse_link is not supported by the configured search provider "${searchProvider}"`
      throw ChatboxAIAPIError.fromCodeName(technical, 'parse_link_not_supported') ?? new Error(technical)
    }
    const result = await provider.parseLink(parseInput.url, abortSignal)
    if (!result) {
      const technical = `parse_link returned no result for URL ${parseInput.url} (provider: ${searchProvider})`
      throw ChatboxAIAPIError.fromCodeName(technical, 'parse_link_failed') ?? new Error(technical)
    }
    const truncatedContent = result.content.slice(0, normalizedMaxLength)
    return {
      url: result.url,
      title: result.title,
      content: truncatedContent,
      originalLength: result.content.length,
      truncated: result.content.length > truncatedContent.length,
    }
  },
}

export default {
  description: getToolSetDescription({ includeParseLink: true }),
  tools: {
    web_search: webSearchTool,
    parse_link: parseLinkTool,
  },
}
