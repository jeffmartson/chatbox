import type { AgentModeEntry } from '@shared/types'
import { describe, expect, test, vi } from 'vitest'

const platformMock = vi.hoisted(() => ({ type: 'desktop' as string }))
vi.mock('@/platform', () => ({ default: platformMock }))

import { getAgentModeUIState } from './agentModeState'

function createEntry(value: AgentModeEntry['value']): AgentModeEntry {
  return { value, locked: false, lockReason: null }
}

describe('getAgentModeUIState', () => {
  test('keeps auto when the model supports agent mode on desktop', () => {
    platformMock.type = 'desktop'
    expect(getAgentModeUIState(createEntry('auto'), true)).toEqual({
      effectiveValue: 'auto',
      capabilitiesDisabled: false,
      modelUnsupported: false,
    })
  })

  test('treats unsupported auto mode as effectively off', () => {
    platformMock.type = 'desktop'
    expect(getAgentModeUIState(createEntry('auto'), false)).toEqual({
      effectiveValue: 'off',
      capabilitiesDisabled: true,
      modelUnsupported: true,
    })
  })

  test('treats unsupported on mode as effectively off', () => {
    platformMock.type = 'desktop'
    expect(getAgentModeUIState(createEntry('on'), false)).toEqual({
      effectiveValue: 'off',
      capabilitiesDisabled: true,
      modelUnsupported: true,
    })
  })

  test('keeps explicit off disabled', () => {
    platformMock.type = 'desktop'
    expect(getAgentModeUIState(createEntry('off'), true)).toEqual({
      effectiveValue: 'off',
      capabilitiesDisabled: true,
      modelUnsupported: false,
    })
  })

  test('forces off on mobile even when model supports agent mode', () => {
    platformMock.type = 'mobile'
    expect(getAgentModeUIState(createEntry('auto'), true)).toEqual({
      effectiveValue: 'off',
      capabilitiesDisabled: true,
      modelUnsupported: false,
    })
  })

  test('forces off on web even when agent mode is on', () => {
    platformMock.type = 'web'
    expect(getAgentModeUIState(createEntry('on'), true)).toEqual({
      effectiveValue: 'off',
      capabilitiesDisabled: true,
      modelUnsupported: false,
    })
  })
})
