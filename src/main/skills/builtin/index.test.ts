import { describe, expect, it } from 'vitest'
import { builtinSkills } from './index'

describe('builtinSkills', () => {
  it('only includes practical built-in skills', () => {
    expect(builtinSkills.map((item) => item.metadata.name)).toEqual(['data-analysis', 'chatbox-product-info'])
  })

  it('includes Chatbox product information skill', () => {
    const skill = builtinSkills.find((item) => item.metadata.name === 'chatbox-product-info')

    expect(skill).toBeDefined()
    expect(skill?.metadata.description).toContain('pricing')
    expect(skill?.body).toContain('https://chatboxai.app/llms.txt')
    expect(skill?.body).toContain('https://chatboxai.app/pricing.md')
  })

  it('keeps data analysis aligned with the sandbox harness', () => {
    const skill = builtinSkills.find((item) => item.metadata.name === 'data-analysis')

    expect(skill).toBeDefined()
    expect(skill?.body).toContain('code_execution')
    expect(skill?.body).toContain('Node.js or Bash')
    expect(skill?.body).toContain('create_download')
    expect(skill?.body).toContain('Python, pandas, matplotlib, R, and system package managers are not available')
  })
})
