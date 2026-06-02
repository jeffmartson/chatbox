import { describe, expect, it } from 'vitest'
import { buildDetailsText } from './SkillsSpotlight'

describe('buildDetailsText', () => {
  it('should put source first, followed by description', () => {
    const result = buildDetailsText('anthropics/skills', '', 'A great skill', false)
    expect(result).toBe('anthropics/skills · A great skill')
  })

  it('should include translated description before original when translation enabled', () => {
    const result = buildDetailsText('obra/superpowers', '一个很棒的技能', 'A great skill', true)
    expect(result).toBe('obra/superpowers · 一个很棒的技能 · A great skill')
  })

  it('should fall back to original description when translation is disabled', () => {
    const result = buildDetailsText('vercel-labs/skills', '翻译', 'Original', false)
    expect(result).toBe('vercel-labs/skills · Original')
  })

  it('should handle empty translated description', () => {
    const result = buildDetailsText('some/repo', '', 'Description', true)
    expect(result).toBe('some/repo · Description')
  })

  it('should handle empty original description', () => {
    const result = buildDetailsText('some/repo', '', '', false)
    expect(result).toBe('some/repo')
  })
})
