import { describe, expect, it } from 'vitest'
import { INTERFACE_COLOR_PRESETS, withColorOpacity } from './theme-colors'

describe('INTERFACE_COLOR_PRESETS', () => {
  it('provides the requested Claude and Mist Blue presets', () => {
    expect(INTERFACE_COLOR_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))).toEqual([
      { id: 'claude-classic', label: 'Claude Classic' },
      { id: 'mist-blue', label: 'Mist Blue' },
    ])
  })

  it('provides complete light and dark palettes for every preset', () => {
    for (const preset of INTERFACE_COLOR_PRESETS) {
      expect(preset.colors.light).toEqual({
        backgroundPrimary: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        backgroundSecondary: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        backgroundTertiary: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        brand: expect.stringMatching(/^#[0-9a-f]{6}$/i),
      })
      expect(preset.colors.dark).toEqual({
        backgroundPrimary: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        backgroundSecondary: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        backgroundTertiary: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        brand: expect.stringMatching(/^#[0-9a-f]{6}$/i),
      })
    }
  })

  it('uses a 60% alpha channel for preset badge backgrounds', () => {
    expect(withColorOpacity('#d97757', 0.6)).toBe('#d9775799')
  })
})
