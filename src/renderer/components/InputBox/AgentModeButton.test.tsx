// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/', search: {} }),
}))

vi.mock('@/stores/session/agent-mode', () => ({
  useSessionAgentMode: () => ({ value: 'on', locked: false, lockReason: null }),
}))

vi.mock('@/platform', () => ({ default: { type: 'desktop' } }))

vi.mock('./AgentModePanel', () => ({ default: () => null }))

import AgentModeButton from './AgentModeButton'

function renderButton(modelSupportsAgentMode: boolean) {
  return render(
    <MantineProvider>
      <AgentModeButton
        sessionId="session-1"
        modelSupportsAgentMode={modelSupportsAgentMode}
        webBrowsingMode={false}
        onWebBrowsingChange={vi.fn()}
        onKnowledgeBaseSelect={vi.fn()}
        onSkillSelect={vi.fn()}
      />
    </MantineProvider>
  )
}

describe('AgentModeButton', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('is disabled and explains why when the selected model does not support agent tools', async () => {
    renderButton(false)

    const button = screen.getByRole('button', { name: 'Chat Mode' })
    expect(button).toHaveProperty('disabled', true)

    fireEvent.mouseEnter(button.parentElement as HTMLElement)

    expect(
      await screen.findByText(
        'This model is older and has limited capabilities, so it does not support more advanced features.'
      )
    ).toBeTruthy()
  })

  test('remains enabled for a model that supports agent tools', () => {
    renderButton(true)

    expect(screen.getByRole('button', { name: 'Work Mode' })).toHaveProperty('disabled', false)
  })

  test('shows the Web Search migration tip until the user dismisses it', () => {
    const view = renderButton(true)

    expect(screen.getByText('Web Search has moved')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByText('Web Search has moved')).toBeNull()
    expect(window.localStorage.getItem('chatbox.web-search-moved-tip-dismissed.v1')).toBe('true')

    view.unmount()
    renderButton(true)
    expect(screen.queryByText('Web Search has moved')).toBeNull()
  })
})
