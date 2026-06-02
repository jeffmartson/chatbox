import { beforeEach, describe, expect, test, vi } from 'vitest'

// ── Hoisted mocks (environment + modules) ──────────────────────────────────

const {
  discoverSkillsMock,
  loadSkillMock,
  settingsState,
  getSettingsMock,
  isProMock,
  buildCodeExecutionToolsMock,
  getSessionAttachmentRagToolSetMock,
  skillsChangedListeners,
} = vi.hoisted(() => ({
  discoverSkillsMock: vi.fn(),
  loadSkillMock: vi.fn(),
  settingsState: {
    licenseKey: undefined as string | undefined,
    licenseDetail: undefined as unknown,
    licensePlanName: undefined as string | undefined,
    licenseActivationMethod: undefined as 'login' | 'manual' | undefined,
    hasExpiredLicense: false,
  },
  getSettingsMock: vi.fn(),
  isProMock: vi.fn(),
  buildCodeExecutionToolsMock: vi.fn(),
  getSessionAttachmentRagToolSetMock: vi.fn(),
  skillsChangedListeners: new Set<() => void>(),
}))

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

vi.mock('@/platform', () => ({
  default: { type: 'web' },
}))

vi.mock('@/packages/mcp/controller', () => ({
  mcpController: {
    getAvailableTools: () => ({}),
  },
}))

vi.mock('@/packages/skills/controller', () => ({
  subscribeSkillsChanged: (listener: () => void) => {
    skillsChangedListeners.add(listener)
    return () => skillsChangedListeners.delete(listener)
  },
  skillsController: {
    discoverSkills: discoverSkillsMock,
    loadSkill: loadSkillMock,
  },
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      ...settingsState,
      getSettings: getSettingsMock,
    }),
    setState: (patch: Record<string, unknown>) => {
      Object.assign(settingsState, patch)
    },
  },
}))

vi.mock('@/packages/remote', () => ({
  getLicenseDetailRealtime: vi.fn(),
}))

vi.mock('@/stores/settingActions', () => ({
  getExtensionSettings: () => ({
    webSearch: {
      provider: 'build-in',
    },
  }),
  isPro: isProMock,
}))

vi.mock('@/packages/model-calls/toolsets/code-execution', () => ({
  buildCodeExecutionTools: buildCodeExecutionToolsMock,
}))

vi.mock('@/packages/model-calls/toolsets/web-search', () => {
  const { tool } = require('ai')
  const { z } = require('zod')
  return {
    default: { description: 'web search toolset' },
    webSearchTool: tool({ description: 'web_search', inputSchema: z.object({}), execute: async () => ({}) }),
    parseLinkTool: tool({ description: 'parse_link', inputSchema: z.object({}), execute: async () => ({}) }),
  }
})

vi.mock('@/packages/model-calls/toolsets/file', () => ({
  default: {
    description: 'file toolset',
    tools: { read_file: { execute: async () => ({}) } },
  },
}))

vi.mock('@/packages/model-calls/toolsets/filesystem', () => ({
  buildFilesystemTools: () => ({
    description: 'filesystem toolset',
    tools: {
      list_files: { execute: async () => ({}) },
      search_files: { execute: async () => ({}) },
      write_file: { execute: async () => ({}) },
      edit_file: { execute: async () => ({}) },
    },
  }),
}))

vi.mock('@/packages/model-calls/toolsets/knowledge-base', () => ({
  getToolSet: async () => ({
    description: 'kb toolset',
    tools: { kb_search: { execute: async () => ({}) } },
  }),
}))

vi.mock('@/packages/model-calls/toolsets/session-attachment-rag', () => ({
  getToolSet: getSessionAttachmentRagToolSetMock,
}))

vi.mock('@/packages/model-calls/toolsets/sandbox', () => ({
  default: {
    description: 'sandbox toolset',
    tools: {
      sandbox_bash: { execute: async () => ({}) },
      sandbox_read: { execute: async () => ({}) },
      sandbox_write: { execute: async () => ({}) },
      sandbox_edit: { execute: async () => ({}) },
      sandbox_grep: { execute: async () => ({}) },
      sandbox_ls: { execute: async () => ({}) },
      sandbox_find: { execute: async () => ({}) },
    },
  },
}))

import type { ModelInterface } from '@shared/models/types'
import type { SandboxProvider } from '@shared/sandbox-provider'
import type { Message } from '@shared/types'
import { type BuildToolsOptions, buildToolsForSession } from '../tools-builder'

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockModel(overrides?: Partial<ModelInterface>): ModelInterface {
  return {
    isSupportToolUse: vi.fn().mockReturnValue(true),
    isSupportVision: vi.fn().mockReturnValue(true),
    isSupportSystemMessage: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as ModelInterface
}

function createMockSandboxProvider(): SandboxProvider {
  return {
    type: 'cloud',
    init: vi.fn().mockResolvedValue({ success: true }),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    copyFileIn: vi.fn().mockResolvedValue(undefined),
    checkAvailability: vi.fn().mockResolvedValue({ available: true }),
    destroy: vi.fn(),
  } as unknown as SandboxProvider
}

const sandboxToolNames = [
  'sandbox_bash',
  'sandbox_read',
  'sandbox_write',
  'sandbox_edit',
  'sandbox_grep',
  'sandbox_ls',
  'sandbox_find',
]

beforeEach(() => {
  vi.clearAllMocks()
  for (const listener of skillsChangedListeners) {
    listener()
  }
  getSettingsMock.mockReturnValue({
    skills: { enabledSkillNames: ['test-skill'] },
  })
  settingsState.licenseKey = undefined
  settingsState.licenseDetail = undefined
  settingsState.licensePlanName = undefined
  settingsState.licenseActivationMethod = undefined
  settingsState.hasExpiredLicense = false
  isProMock.mockReturnValue(true)
  buildCodeExecutionToolsMock.mockReturnValue({
    description: 'code execution toolset',
    tools: {
      code_execution: { execute: async () => ({}) },
      parse_file: { execute: async () => ({}) },
    },
  })
  getSessionAttachmentRagToolSetMock.mockResolvedValue({
    description: 'session attachment rag toolset',
    tools: { query_session_attachment: { execute: async () => ({}) } },
  })
  discoverSkillsMock.mockResolvedValue([
    { name: 'test-skill', description: 'A test skill' },
    { name: 'chatbox-product-info', description: 'Chatbox product info' },
    { name: 'disabled-skill', description: 'Disabled' },
  ])
  loadSkillMock.mockResolvedValue({ metadata: {}, body: '# Skill instructions' })
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('buildToolsForSession', () => {
  test('agentMode="off" — no skills tools, no sandbox tools in result', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'off',
    }
    const result = await buildToolsForSession(model, options)

    expect(result.tools.load_skill).toBeUndefined()
    expect(result.tools.chatbox_cli).toBeUndefined()
    expect(result.tools.user_exec).toBeUndefined()
    expect(result.instructions).not.toContain('## Skills')
    expect(result.instructions).not.toContain('Chatbox Account CLI')
    expect(discoverSkillsMock).not.toHaveBeenCalled()
    for (const name of sandboxToolNames) {
      expect(result.tools[name]).toBeUndefined()
    }
    expect(result.initialActiveTools).toBeUndefined()
  })

  test('agentMode="auto" — has load_skill, has code-exec tools, returns initialActiveTools excluding code execution', async () => {
    const model = createMockModel()
    const provider = createMockSandboxProvider()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'auto',
      codeExecution: {
        sessionId: 'session-1',
        provider,
        files: [],
      },
    }

    const result = await buildToolsForSession(model, options)

    // Skills tools present
    expect(result.tools.load_skill).toBeDefined()

    // Low-level sandbox_* tools are never exposed to the model.
    for (const name of sandboxToolNames) {
      expect(result.tools[name]).toBeUndefined()
    }

    // Code execution tools present
    expect(result.tools.code_execution).toBeDefined()
    expect(result.tools.parse_file).toBeDefined()

    // initialActiveTools should exclude code-exec tools and privileged real-environment tools.
    expect(result.initialActiveTools).toBeDefined()
    expect(result.initialActiveTools).toContain('load_skill')
    expect(result.initialActiveTools).not.toContain('code_execution')
    expect(result.initialActiveTools).not.toContain('parse_file')
    expect(result.initialActiveTools).not.toContain('user_exec')
  })

  test('agentMode="on" — has all tools, no initialActiveTools', async () => {
    const model = createMockModel()
    const provider = createMockSandboxProvider()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
      codeExecution: {
        sessionId: 'session-1',
        provider,
        files: [],
      },
    }

    const result = await buildToolsForSession(model, options)

    expect(result.tools.load_skill).toBeDefined()
    // Sandbox tools NOT present when code_execution is active
    for (const name of sandboxToolNames) {
      expect(result.tools[name]).toBeUndefined()
    }
    expect(result.tools.code_execution).toBeDefined()
    expect(result.initialActiveTools).toBeUndefined()
  })

  test('agentMode="auto" without codeExecution — load_skill only, no code-exec tools', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'auto',
      // no codeExecution
    }

    const result = await buildToolsForSession(model, options)

    expect(result.tools.load_skill).toBeDefined()

    // Low-level sandbox_* tools are not exposed; code_execution is the supported sandbox surface.
    for (const name of sandboxToolNames) {
      expect(result.tools[name]).toBeUndefined()
    }

    // But code execution tools are NOT present (no codeExecution option)
    expect(result.tools.code_execution).toBeUndefined()
    expect(result.tools.parse_file).toBeUndefined()
    expect(buildCodeExecutionToolsMock).not.toHaveBeenCalled()
  })

  test('resets discovered skills cache when skills change', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
    }

    getSettingsMock.mockReturnValue({
      skills: { enabledSkillNames: ['test-skill', 'new-skill'] },
    })
    discoverSkillsMock
      .mockResolvedValueOnce([{ name: 'test-skill', description: 'A test skill' }])
      .mockResolvedValueOnce([{ name: 'new-skill', description: 'A newly discovered skill' }])

    const first = await buildToolsForSession(model, options)
    expect(first.instructions).toContain('test-skill')

    const cached = await buildToolsForSession(model, options)
    expect(cached.instructions).toContain('test-skill')
    expect(discoverSkillsMock).toHaveBeenCalledTimes(1)

    for (const listener of skillsChangedListeners) {
      listener()
    }

    const refreshed = await buildToolsForSession(model, options)
    expect(refreshed.instructions).toContain('new-skill')
    expect(discoverSkillsMock).toHaveBeenCalledTimes(2)
  })
})

describe('load_skill tool', () => {
  test('calls onAgentModeActivated callback', async () => {
    const model = createMockModel()
    const onAgentModeActivated = vi.fn()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
      onAgentModeActivated,
    }

    const result = await buildToolsForSession(model, options)

    // Execute the load_skill tool
    const loadSkillTool = result.tools.load_skill
    expect(loadSkillTool).toBeDefined()
    if (!loadSkillTool.execute) throw new Error('load_skill execute missing')

    const executeResult = await loadSkillTool.execute({ name: 'test-skill' }, {} as never)
    expect(onAgentModeActivated).toHaveBeenCalledTimes(1)
    expect(executeResult).toHaveProperty('instructions', '# Skill instructions')
  })

  test('returns error for non-enabled skill', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
    }

    const result = await buildToolsForSession(model, options)
    const loadSkillTool = result.tools.load_skill
    if (!loadSkillTool.execute) throw new Error('load_skill execute missing')

    const executeResult = await loadSkillTool.execute({ name: 'disabled-skill' }, {} as never)
    expect(executeResult).toHaveProperty('error')
    expect((executeResult as { error: string }).error).toContain('not enabled')
  })
})

describe('chatbox_cli tool', () => {
  test('is available only when chatbox-product-info is enabled', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
    }

    getSettingsMock.mockReturnValueOnce({
      skills: { enabledSkillNames: ['chatbox-product-info'] },
    })
    const enabled = await buildToolsForSession(model, options)
    expect(enabled.tools.chatbox_cli).toBeDefined()

    getSettingsMock.mockReturnValueOnce({
      skills: { enabledSkillNames: ['test-skill'] },
    })
    const disabled = await buildToolsForSession(model, options)
    expect(disabled.tools.chatbox_cli).toBeUndefined()
  })

  test('returns masked license status for CLI-style command', async () => {
    const model = createMockModel()
    const onAgentModeActivated = vi.fn()
    settingsState.licenseKey = 'license-key-secret-1234'
    settingsState.licenseActivationMethod = 'manual'
    settingsState.licensePlanName = 'Chatbox AI Pro'

    getSettingsMock.mockReturnValue({
      skills: { enabledSkillNames: ['chatbox-product-info'] },
    })

    const result = await buildToolsForSession(model, {
      webBrowsing: false,
      messages: [],
      agentMode: 'auto',
      onAgentModeActivated,
    })
    if (!result.tools.chatbox_cli.execute) throw new Error('chatbox_cli execute missing')

    const executeResult = await result.tools.chatbox_cli.execute({ command: 'chatbox account status' }, {} as never)

    expect(onAgentModeActivated).toHaveBeenCalledTimes(1)
    expect(executeResult).toMatchObject({
      licenseConfigured: true,
      licenseKey: 'configured (...1234)',
      activationMethod: 'manual',
      plan: { name: 'Chatbox AI Pro' },
    })
    expect(JSON.stringify(executeResult)).not.toContain('license-key-secret-1234')
  })
})

describe('session attachment RAG tools', () => {
  function retrievalMessage(): Message {
    return {
      id: 'm1',
      role: 'user',
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'What does the uploaded manual say?' }],
      files: [
        {
          id: 'f1',
          name: 'manual.md',
          fileType: 'text/markdown',
          ragMode: 'session-retrieval',
          sessionAttachmentId: 42,
          sessionAttachmentAvailability: 'allowed',
          sessionAttachmentIndexStatus: 'ready',
        },
      ],
    }
  }

  test('adds retrieval tools and instructions for session retrieval attachments', async () => {
    const model = createMockModel()
    const result = await buildToolsForSession(model, {
      webBrowsing: false,
      messages: [retrievalMessage()],
      agentMode: 'off',
    })

    expect(getSessionAttachmentRagToolSetMock).toHaveBeenCalledWith([42])
    expect(result.instructions).toContain('session attachment rag toolset')
    expect(result.tools.query_session_attachment).toBeDefined()
  })

  test('does not add retrieval tools when the model cannot use tools', async () => {
    const model = createMockModel({ isSupportToolUse: vi.fn().mockReturnValue(false) })
    const result = await buildToolsForSession(model, {
      webBrowsing: false,
      messages: [retrievalMessage()],
      agentMode: 'off',
    })

    expect(getSessionAttachmentRagToolSetMock).not.toHaveBeenCalled()
    expect(result.instructions).not.toContain('session attachment rag toolset')
    expect(result.tools.query_session_attachment).toBeUndefined()
  })
})

describe('install_skill tool', () => {
  test('install_skill is in tools when agentMode="on" AND codeExecution is provided', async () => {
    const model = createMockModel()
    const provider = createMockSandboxProvider()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
      codeExecution: {
        sessionId: 'session-1',
        provider,
        files: [],
      },
    }

    const result = await buildToolsForSession(model, options)
    expect(result.tools.install_skill).toBeDefined()
  })

  test('install_skill is in tools when agentMode="auto" AND codeExecution is provided', async () => {
    const model = createMockModel()
    const provider = createMockSandboxProvider()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'auto',
      codeExecution: {
        sessionId: 'session-1',
        provider,
        files: [],
      },
    }

    const result = await buildToolsForSession(model, options)
    expect(result.tools.install_skill).toBeDefined()
  })

  test('install_skill is NOT in tools when agentMode="off"', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'off',
    }

    const result = await buildToolsForSession(model, options)
    expect(result.tools.install_skill).toBeUndefined()
  })

  test('install_skill is NOT in tools when agentMode="on" but no codeExecution', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
      // no codeExecution
    }

    const result = await buildToolsForSession(model, options)
    expect(result.tools.install_skill).toBeUndefined()
  })

  test('install_skill is in initialActiveTools in auto mode (not gated)', async () => {
    const model = createMockModel()
    const provider = createMockSandboxProvider()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'auto',
      codeExecution: {
        sessionId: 'session-1',
        provider,
        files: [],
      },
    }

    const result = await buildToolsForSession(model, options)
    expect(result.initialActiveTools).toBeDefined()
    expect(result.initialActiveTools).toContain('install_skill')
  })
})

describe('user_exec tool', () => {
  test('user_exec is in tools when agentMode="on"', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'on',
    }
    const result = await buildToolsForSession(model, options)
    expect(result.tools.user_exec).toBeDefined()
  })

  test('user_exec is NOT in tools when agentMode="off"', async () => {
    const model = createMockModel()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'off',
    }
    const result = await buildToolsForSession(model, options)
    expect(result.tools.user_exec).toBeUndefined()
  })

  test('user_exec is gated behind load_skill in auto mode', async () => {
    const model = createMockModel()
    const provider = createMockSandboxProvider()
    const options: BuildToolsOptions = {
      webBrowsing: false,
      messages: [],
      agentMode: 'auto',
      codeExecution: {
        sessionId: 'session-1',
        provider,
        files: [],
      },
    }
    const result = await buildToolsForSession(model, options)
    expect(result.tools.user_exec).toBeDefined()
    expect(result.initialActiveTools).not.toContain('user_exec')
  })
})
