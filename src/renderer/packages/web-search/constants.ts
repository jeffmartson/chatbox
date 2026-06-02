export const WEB_SEARCH_PROVIDERS = [
  { value: 'build-in', label: 'Chatbox AI' },
  { value: 'bing', label: 'Bing Search' },
  { value: 'tavily', label: 'Tavily' },
] as const

export type WebSearchProviderValue = (typeof WEB_SEARCH_PROVIDERS)[number]['value']
