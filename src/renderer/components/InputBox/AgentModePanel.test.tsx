/**
 * @vitest-environment jsdom
 */

import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn(
    (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })
  ),
})

HTMLElement.prototype.scrollTo = vi.fn()

const mocks = vi.hoisted(() => {
  const settingsState = {
    extension: {
      webSearch: {
        provider: 'build-in',
        tavilyApiKey: '',
      },
    },
    licenseKey: '',
    skills: {
      enabledSkillNames: [],
    },
    setSettings: vi.fn(),
  }
  const uiState = {
    newSessionState: {},
    setAgentModeSmartSwitchingDefault: vi.fn(),
    setNewSessionState: vi.fn(),
  }
  const agentModeEntry = {
    value: 'on' as 'auto' | 'on' | 'off',
    locked: false,
    lockReason: null,
  }
  const knowledgeBases: Array<{ id: number; name: string }> = []
  const trackWebSearchClickMock = vi.fn()

  return { agentModeEntry, knowledgeBases, settingsState, trackWebSearchClickMock, uiState }
})

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/analytics/agent-mode', () => ({
  trackAgentModeSelect: vi.fn(),
  trackCodeExecutionClick: vi.fn(),
  trackSmartSwitchingClick: vi.fn(),
  trackWebSearchClick: mocks.trackWebSearchClickMock,
}))

vi.mock('@/hooks/knowledge-base', () => ({
  useKnowledgeBases: () => ({ data: mocks.knowledgeBases }),
}))

vi.mock('@/hooks/mcp', () => ({
  useMCPServerStatus: () => undefined,
  useToggleMCPServer: () => vi.fn(),
}))

vi.mock('@/modals/Settings', () => ({
  navigateToSettings: vi.fn(),
}))

vi.mock('@/packages/navigator', () => ({
  getOS: () => 'macOS',
}))

vi.mock('@/packages/skills/controller', () => ({
  skillsController: {
    discoverSkills: vi.fn(() => new Promise(() => {})),
  },
  subscribeSkillsChanged: () => vi.fn(),
}))

vi.mock('@/platform', () => ({
  default: { type: 'desktop', openDirectoryDialog: vi.fn() },
}))

vi.mock('@/stores/chatStore', () => ({
  updateSession: vi.fn(),
  useSession: () => ({ session: undefined }),
  useSessionSettings: () => ({ sessionSettings: {} }),
}))

vi.mock('@/stores/premiumActions', () => ({
  useAutoValidate: () => false,
}))

vi.mock('@/stores/session/agent-mode', () => ({
  setSessionAgentMode: vi.fn(),
  useSessionAgentMode: () => mocks.agentModeEntry,
}))

vi.mock('@/stores/settingsStore', () => ({
  useMcpSettings: () => ({ servers: [], enabledBuiltinServers: [] }),
  useSettingsStore: (selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState),
}))

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mocks.uiState) => unknown) => selector(mocks.uiState),
}))

import AgentModePanel from './AgentModePanel'

const defaultProps: ComponentProps<typeof AgentModePanel> = {
  sessionId: 'new',
  modelSupportsAgentMode: true,
  webBrowsingMode: false,
  onWebBrowsingChange: vi.fn(),
  onKnowledgeBaseSelect: vi.fn(),
  onSkillSelect: vi.fn(),
  onClose: vi.fn(),
}

function renderPanel(props: Partial<ComponentProps<typeof AgentModePanel>> = {}) {
  return render(
    <MantineProvider>
      <AgentModePanel {...defaultProps} {...props} />
    </MantineProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.agentModeEntry.value = 'on'
  mocks.knowledgeBases.splice(0)
})

describe('AgentModePanel submenu hover behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('cancels a delayed submenu switch when the pointer leaves the target row', () => {
    renderPanel()

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getAllByText('Skills')).toHaveLength(2)

    const mcpRow = screen.getByRole('button', { name: 'MCP' })
    fireEvent.mouseEnter(mcpRow)
    fireEvent.mouseLeave(mcpRow, { relatedTarget: mcpRow.parentElement })

    act(() => vi.advanceTimersByTime(180))

    expect(screen.getAllByText('MCP')).toHaveLength(1)
    expect(screen.getAllByText('Skills')).toHaveLength(2)
  })

  test('clears a pending switch when Escape closes the submenu', () => {
    renderPanel()

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Skills' }))
    const mcpRow = screen.getByRole('button', { name: 'MCP' })
    fireEvent.mouseEnter(mcpRow)
    fireEvent.keyDown(mcpRow, { key: 'Escape' })

    act(() => vi.advanceTimersByTime(180))

    expect(screen.getAllByText('Skills')).toHaveLength(1)
    expect(screen.getAllByText('MCP')).toHaveLength(1)
  })

  test('keeps the submenu open while the pointer crosses the gap into it', () => {
    renderPanel()

    const skillsRow = screen.getByRole('button', { name: 'Skills' })
    fireEvent.mouseEnter(skillsRow)
    expect(screen.getAllByText('Skills')).toHaveLength(2)

    const panel = screen.getByRole('button', { name: 'Skills' }).closest('.relative')
    expect(panel).not.toBeNull()
    fireEvent.mouseLeave(panel as Element)

    act(() => vi.advanceTimersByTime(200))
    expect(screen.getAllByText('Skills')).toHaveLength(2)

    const subPanel = (panel as Element).querySelector('.absolute')
    expect(subPanel).not.toBeNull()
    fireEvent.mouseEnter(subPanel as Element)

    act(() => vi.advanceTimersByTime(300))
    expect(screen.getAllByText('Skills')).toHaveLength(2)
  })

  test('closes the submenu after the pointer stays outside the whole panel', () => {
    renderPanel()

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Skills' }))
    const panel = screen.getByRole('button', { name: 'Skills' }).closest('.relative')
    expect(panel).not.toBeNull()
    fireEvent.mouseLeave(panel as Element)

    act(() => vi.advanceTimersByTime(300))

    expect(screen.getAllByText('Skills')).toHaveLength(1)
  })
})

describe('AgentModePanel capability availability', () => {
  test('keeps Web Search and Knowledge Base enabled in Chat Mode', () => {
    mocks.agentModeEntry.value = 'off'
    renderPanel()

    expect(screen.getByRole('button', { name: 'Web Search' }).getAttribute('aria-disabled')).toBe('false')
    expect(screen.getByRole('button', { name: 'Knowledge Base' }).getAttribute('aria-disabled')).toBe('false')
    expect(screen.getByRole('button', { name: /^Code Execution/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Skills' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'MCP' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Working Directory' }).getAttribute('aria-disabled')).toBe('true')
  })

  test('tracks and updates Web Search from Chat Mode', () => {
    mocks.agentModeEntry.value = 'off'
    const onWebBrowsingChange = vi.fn()
    renderPanel({ onWebBrowsingChange })

    const webSearchRow = screen.getByRole('button', { name: 'Web Search' })
    const webSearchSwitch = webSearchRow.querySelector('input[type="checkbox"]')
    expect(webSearchSwitch).not.toBeNull()
    fireEvent.click(webSearchSwitch as HTMLInputElement)

    expect(onWebBrowsingChange).toHaveBeenCalledWith(true)
    expect(mocks.trackWebSearchClickMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat_mode', sessionId: 'new' }),
      true,
      'build-in'
    )
  })

  test('allows selecting a Knowledge Base from Chat Mode', () => {
    mocks.agentModeEntry.value = 'off'
    mocks.knowledgeBases.push({ id: 1, name: 'Product Docs' })
    const onKnowledgeBaseSelect = vi.fn()
    const onClose = vi.fn()
    renderPanel({ onKnowledgeBaseSelect, onClose })

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Knowledge Base' }))
    fireEvent.click(screen.getByText('Product Docs'))

    expect(onKnowledgeBaseSelect).toHaveBeenCalledWith({ id: 1, name: 'Product Docs' })
    expect(onClose).toHaveBeenCalled()
  })

  test('keeps all capability rows enabled in Work Mode', () => {
    renderPanel()

    for (const name of ['Web Search', 'Skills', 'MCP', 'Knowledge Base', 'Working Directory']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('false')
    }
    expect(screen.getByRole('button', { name: /^Code Execution/ }).getAttribute('aria-disabled')).toBe('false')
  })
})
