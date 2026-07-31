// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { getThemeDesign } from './useAppTheme'

describe('getThemeDesign', () => {
  it('uses the interface brand color for MUI primary controls', () => {
    expect(getThemeDesign('light', 'en').palette?.primary).toEqual({ main: '#228be6' })
    expect(getThemeDesign('dark', 'en').palette?.primary).toEqual({ main: '#4dabf7' })
  })
})
