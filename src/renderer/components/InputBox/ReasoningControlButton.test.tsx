// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { ModelProviderEnum, type ProviderModelInfo, type ProviderOptions } from '@shared/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import ReasoningControlButton from './ReasoningControlButton'

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
  useTranslation: () => ({
    t: (key: string, values?: { level?: string }) => (values?.level ? key.replace('{{level}}', values.level) : key),
  }),
}))

const model: ProviderModelInfo = { modelId: 'gpt-5.1' }
const highReasoning: ProviderOptions = { openai: { reasoningEffort: 'high' } }

function renderButton(compact: boolean) {
  return render(
    <MantineProvider>
      <ReasoningControlButton
        provider={ModelProviderEnum.OpenAIResponses}
        model={model}
        providerOptions={highReasoning}
        iconSize={22}
        compact={compact}
        onChange={vi.fn()}
      />
    </MantineProvider>
  )
}

describe('ReasoningControlButton', () => {
  test('shows a state icon instead of the level text in compact mode', () => {
    const view = renderButton(true)

    expect(screen.getByRole('button', { name: 'Thinking: High' })).toBeTruthy()
    expect(view.container.querySelector('[data-reasoning-level="high"]')).toBeTruthy()
    expect(view.container.querySelector('button')?.textContent).toBe('')
  })

  test('keeps the level text in regular mode', () => {
    renderButton(false)

    expect(screen.getByRole('button', { name: 'Thinking: High' }).textContent).toBe('High')
  })
})
