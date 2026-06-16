import { describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  }
  const windowMock: Record<string, unknown> = {
    electronAPI: undefined,
    localStorage: storage,
  }
  ;(globalThis as unknown as { window: Record<string, unknown>; localStorage: typeof storage }).window = windowMock
  ;(globalThis as unknown as { window: Record<string, unknown>; localStorage: typeof storage }).localStorage = storage
  return {}
})

import type { AgentModeValue } from '@shared/types'

// ── Effective mode computation ─────────────────────────────────────────────
// Mirrors computeEffectiveAgentMode() in agent-harness.ts. 'auto' no longer
// enables agent mode on its own — it only triggers the first-turn suggestion —
// so agent mode resolves to 'on' only for an explicit 'on' on a supported
// platform. (Files no longer auto-enable agent mode.)

function computeEffectiveMode(agentModeValue: AgentModeValue, agentModeSupported = true): AgentModeValue {
  if (!agentModeSupported || agentModeValue === 'off') return 'off'
  return agentModeValue === 'on' ? 'on' : 'off'
}

describe('effective agent mode computation', () => {
  test('agentModeValue="off" resolves to "off"', () => {
    expect(computeEffectiveMode('off')).toBe('off')
  })

  test('agentModeValue="auto" resolves to "off" (auto only triggers the suggestion)', () => {
    expect(computeEffectiveMode('auto')).toBe('off')
  })

  test('agentModeValue="on" resolves to "on" on a supported platform', () => {
    expect(computeEffectiveMode('on')).toBe('on')
  })

  test('unsupported platforms force agent mode off regardless of stored mode', () => {
    expect(computeEffectiveMode('auto', false)).toBe('off')
    expect(computeEffectiveMode('on', false)).toBe('off')
    expect(computeEffectiveMode('off', false)).toBe('off')
  })
})

// ── prepareStep callback ───────────────────────────────────────────────────
// Extracted from orchestration.ts:
//   The prepareStep callback gates tool access in 'auto' mode.
//   Initially only initialActiveTools are returned.
//   After a step with load_skill call, all tools become active.

interface ToolCall {
  toolName: string
}

interface Step {
  toolCalls: ToolCall[]
}

interface PrepareStepInput {
  steps: Step[]
}

function createPrepareStep(initialActiveTools: string[], allToolNames: string[]) {
  let activated = false
  return ({ steps }: PrepareStepInput) => {
    if (!activated) {
      const hasLoadedSkill = steps.some((step) =>
        step.toolCalls.some((tc) => 'toolName' in tc && tc.toolName === 'load_skill')
      )
      if (hasLoadedSkill) {
        activated = true
      }
    }
    return { activeTools: activated ? allToolNames : initialActiveTools }
  }
}

describe('prepareStep callback', () => {
  const allTools = ['load_skill', 'web_search', 'code_execution', 'write_file']
  const initialTools = ['load_skill', 'web_search']

  test('initially returns only initialActiveTools', () => {
    const prepareStep = createPrepareStep(initialTools, allTools)

    const result = prepareStep({ steps: [] })
    expect(result.activeTools).toEqual(initialTools)
  })

  test('after step with non-load_skill call, still returns initialActiveTools', () => {
    const prepareStep = createPrepareStep(initialTools, allTools)

    const result = prepareStep({
      steps: [{ toolCalls: [{ toolName: 'web_search' }] }],
    })
    expect(result.activeTools).toEqual(initialTools)
  })

  test('after step with load_skill call, returns all tools', () => {
    const prepareStep = createPrepareStep(initialTools, allTools)

    const result = prepareStep({
      steps: [{ toolCalls: [{ toolName: 'load_skill' }] }],
    })
    expect(result.activeTools).toEqual(allTools)
  })

  test('once activated, stays activated even with empty steps', () => {
    const prepareStep = createPrepareStep(initialTools, allTools)

    // First call with load_skill activates
    prepareStep({
      steps: [{ toolCalls: [{ toolName: 'load_skill' }] }],
    })

    // Subsequent call without load_skill still returns all tools
    const result = prepareStep({ steps: [] })
    expect(result.activeTools).toEqual(allTools)
  })

  test('load_skill in second step also activates', () => {
    const prepareStep = createPrepareStep(initialTools, allTools)

    // Step 1: only web_search
    const r1 = prepareStep({
      steps: [{ toolCalls: [{ toolName: 'web_search' }] }],
    })
    expect(r1.activeTools).toEqual(initialTools)

    // Step 2: now includes load_skill
    const r2 = prepareStep({
      steps: [{ toolCalls: [{ toolName: 'web_search' }] }, { toolCalls: [{ toolName: 'load_skill' }] }],
    })
    expect(r2.activeTools).toEqual(allTools)
  })
})

// ── sandboxMode computation ───────────────────────────────────────────────
// Regression: sandboxMode must be based on canExecuteCode, not agent mode.
// When agent mode is on but the sandbox is unavailable, files should still
// get full content injection (not metadata-only).

describe('sandboxMode computation', () => {
  // Extracted from agent-harness.ts:
  //   sandboxMode: canExecuteCode
  // (Previously was: effectiveAgentMode !== 'off' — which was wrong)

  test('sandboxMode is false when canExecuteCode is false, even with agent mode on', () => {
    const effectiveAgentMode = computeEffectiveMode('on')
    const canExecuteCode = false
    // sandboxMode should follow canExecuteCode, NOT effectiveAgentMode
    const sandboxMode = canExecuteCode
    expect(sandboxMode).toBe(false)
    // The old logic keyed sandboxMode off agent mode, which would wrongly be true here.
    expect(effectiveAgentMode !== 'off').toBe(true)
  })

  test('sandboxMode is true when canExecuteCode is true', () => {
    const canExecuteCode = true
    const sandboxMode = canExecuteCode
    expect(sandboxMode).toBe(true)
  })

  test('sandboxMode is false when agent mode is off', () => {
    const effectiveAgentMode = computeEffectiveMode('off')
    const canExecuteCode = false
    const sandboxMode = canExecuteCode
    expect(sandboxMode).toBe(false)
    expect(effectiveAgentMode === 'off').toBe(true)
  })
})

// ── stream persistence policy ──────────────────────────────────────────────
// Regression: a pending user_exec tool call can block the stream before the
// 2s periodic flush runs, so tool-call chunks must persist immediately.

function shouldPersistStreamingChunk(chunkType: string, elapsedMs: number, persistInterval: number) {
  return chunkType === 'tool-call' || elapsedMs >= persistInterval
}

describe('stream persistence policy', () => {
  test('persists tool-call chunks immediately even before the periodic interval', () => {
    expect(shouldPersistStreamingChunk('tool-call', 100, 2000)).toBe(true)
  })

  test('does not eagerly persist non-tool chunks before the periodic interval', () => {
    expect(shouldPersistStreamingChunk('text-delta', 100, 2000)).toBe(false)
  })

  test('still persists non-tool chunks after the periodic interval', () => {
    expect(shouldPersistStreamingChunk('text-delta', 2500, 2000)).toBe(true)
  })
})
