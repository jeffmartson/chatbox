import { beforeEach, describe, expect, test, vi } from 'vitest'

const { discoverSkillsMock, getSettingsMock, mcpToolsMock, sandboxProviderMock, skillsChangedListeners } = vi.hoisted(
  () => ({
    discoverSkillsMock: vi.fn(),
    getSettingsMock: vi.fn(),
    mcpToolsMock: vi.fn(),
    sandboxProviderMock: {
      type: 'local',
      init: vi.fn(),
      exec: vi.fn(),
      copyBlobIn: vi.fn(),
      checkAvailability: vi.fn(),
      destroy: vi.fn(),
    },
    skillsChangedListeners: new Set<() => void>(),
  })
)

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
  default: {
    type: 'web',
    getPlatform: vi.fn().mockResolvedValue('darwin'),
    getVersion: vi.fn().mockResolvedValue('test-version'),
  },
}))

vi.mock('@/storage', () => ({
  default: {
    getBlob: vi.fn().mockResolvedValue(null),
    setBlob: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/sandbox', () => ({
  createSandboxProvider: () => sandboxProviderMock,
}))

vi.mock('@/packages/mcp/controller', () => ({
  mcpController: {
    getAvailableTools: mcpToolsMock,
  },
}))

vi.mock('@/packages/skills/controller', () => ({
  subscribeSkillsChanged: (listener: () => void) => {
    skillsChangedListeners.add(listener)
    return () => skillsChangedListeners.delete(listener)
  },
  skillsController: {
    discoverSkills: discoverSkillsMock,
    loadSkill: vi.fn().mockResolvedValue({ metadata: {}, body: '# Skill instructions' }),
    installFromSandbox: vi.fn(),
  },
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      getSettings: getSettingsMock,
    }),
    setState: vi.fn(),
  },
}))

vi.mock('@/stores/settingActions', () => ({
  getExtensionSettings: () => ({
    webSearch: { provider: 'tavily' },
  }),
  getRemoteConfig: vi.fn().mockResolvedValue({}),
  isPro: () => true,
}))

vi.mock('@/packages/user-exec-approval', () => ({
  requestUserExecApproval: vi.fn(),
}))

import type { ModelInterface } from '@shared/models/types'
import type { SandboxProvider } from '@shared/sandbox-provider'
import {
  type Config,
  type Message,
  type MessageFile,
  MessageRoleEnum,
  ModelProviderEnum,
  type Session,
  type SessionSettings,
  type Settings,
} from '@shared/types'
import { getMessageText } from '@shared/utils/message'
import {
  computeEffectiveAgentMode,
  prepareAgentGenerationHarness,
  shouldAutoEnableAgentForFiles,
} from './agent-harness'

function createMockModel(overrides?: Partial<ModelInterface>): ModelInterface {
  return {
    name: 'Test Model',
    modelId: 'test-model',
    isSupportToolUse: vi.fn().mockReturnValue(true),
    isSupportVision: vi.fn().mockReturnValue(true),
    isSupportSystemMessage: vi.fn().mockReturnValue(true),
    chat: vi.fn(),
    chatStream: vi.fn(),
    paint: vi.fn(),
    ...overrides,
  } as unknown as ModelInterface
}

function createSession(): Session {
  return {
    id: 'session-1',
    name: 'Session',
    type: 'chat',
    messages: [],
    threads: [],
    messageForksHash: {},
  } as unknown as Session
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const listener of skillsChangedListeners) {
    listener()
  }
  sandboxProviderMock.type = 'local'
  sandboxProviderMock.checkAvailability.mockResolvedValue({ available: true })
  sandboxProviderMock.init.mockResolvedValue({ success: true })
  sandboxProviderMock.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  sandboxProviderMock.copyBlobIn.mockResolvedValue({ success: true })
  mcpToolsMock.mockReturnValue({})
  discoverSkillsMock.mockResolvedValue([{ name: 'analysis', description: 'Analyze files' }])
  getSettingsMock.mockReturnValue({
    skills: { enabledSkillNames: ['analysis'] },
  })
})

describe('computeEffectiveAgentMode', () => {
  test('keeps unsupported platforms out of agent mode even with files', () => {
    expect(computeEffectiveAgentMode('on', true, false)).toBe('off')
    expect(computeEffectiveAgentMode('auto', true, false)).toBe('off')
  })
})

describe('shouldAutoEnableAgentForFiles', () => {
  test('keeps a single txt/doc/docx file in auto mode', () => {
    expect(shouldAutoEnableAgentForFiles([{ id: '1', name: 'notes.txt', fileType: 'text/plain' } as MessageFile])).toBe(
      false
    )
    expect(
      shouldAutoEnableAgentForFiles([{ id: '1', name: 'brief.doc', fileType: 'application/msword' } as MessageFile])
    ).toBe(false)
    expect(
      shouldAutoEnableAgentForFiles([
        {
          id: '1',
          name: 'brief.docx',
          fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        } as MessageFile,
      ])
    ).toBe(false)
  })

  test('auto-enables agent mode for multiple files or non txt/doc/docx files', () => {
    expect(
      shouldAutoEnableAgentForFiles([
        { id: '1', name: 'a.txt', fileType: 'text/plain' } as MessageFile,
        { id: '2', name: 'b.txt', fileType: 'text/plain' } as MessageFile,
      ])
    ).toBe(true)
    expect(
      shouldAutoEnableAgentForFiles([
        {
          id: '1',
          name: 'sales.xlsx',
          fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        } as MessageFile,
      ])
    ).toBe(true)
  })
})

describe('prepareAgentGenerationHarness', () => {
  test('prepares the real context, system prompt, tools, and sandbox gating for an uploaded file', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Analyze this spreadsheet and create an HTML report.' }],
      files: [
        {
          id: 'file-1',
          name: 'sales.xlsx',
          storageKey: 'parsed-sales',
          rawStorageKey: 'raw-sales',
          byteLength: 2048,
          parserType: 'sandbox-raw',
        },
      ],
    } as unknown as Message

    const lockAgentMode = vi.fn()
    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: {},
      webBrowsing: false,
      agentModeValue: 'auto',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
      sideEffects: {
        lockAgentMode,
      },
    })

    expect(lockAgentMode).toHaveBeenCalledWith('file_upload')
    expect(sandboxProviderMock.checkAvailability).toHaveBeenCalled()
    expect(prepared.debug.effectiveAgentMode).toBe('on')
    expect(prepared.debug.canExecuteCode).toBe(true)

    expect(prepared.tools.code_execution).toBeDefined()
    expect(prepared.tools.read_file).toBeDefined()
    expect(prepared.tools.write_file).toBeDefined()
    expect(prepared.tools.load_skill).toBeDefined()
    expect(prepared.tools.install_skill).toBeDefined()

    const lastPromptMessage = prepared.promptMsgs.at(-1)
    expect(lastPromptMessage).toBeDefined()
    const promptText = lastPromptMessage ? getMessageText(lastPromptMessage, true, false) : ''
    expect(promptText).toContain('<ATTACHMENT_FILE>')
    expect(promptText).toContain('<SANDBOX_MODE>true</SANDBOX_MODE>')
    expect(promptText).toContain('<SANDBOX_PATH>sales.xlsx</SANDBOX_PATH>')
    expect(promptText).not.toContain('ATTACHED_FILES')

    const serializedCoreMessages = JSON.stringify(prepared.coreMessages)
    expect(serializedCoreMessages).toContain('Current model: test-model')
    expect(serializedCoreMessages).toContain('code_execution')
    expect(serializedCoreMessages).toContain('Available Skills')

    expect(prepared.chatOptions.tools).toBe(prepared.tools)
    expect(prepared.chatOptions.prepareStep).toBeUndefined()
  })

  test('keeps code execution gated behind load_skill in auto mode when there are no files', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Make a small HTML demo.' }],
    }

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: {},
      webBrowsing: false,
      agentModeValue: 'auto',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.debug.effectiveAgentMode).toBe('auto')
    expect(prepared.tools.code_execution).toBeDefined()
    expect(prepared.chatOptions.prepareStep).toBeDefined()

    const beforeSkillLoad = prepared.chatOptions.prepareStep?.({ steps: [] })
    expect(beforeSkillLoad?.activeTools).toContain('load_skill')
    expect(beforeSkillLoad?.activeTools).not.toContain('code_execution')
    expect(beforeSkillLoad?.activeTools).not.toContain('write_file')
    expect(beforeSkillLoad?.activeTools).not.toContain('user_exec')

    const afterSkillLoad = prepared.chatOptions.prepareStep?.({
      steps: [{ stepType: 'tool-result', toolCalls: [{ type: 'tool-call', toolCallId: '1', toolName: 'load_skill' }] }],
    })
    expect(afterSkillLoad?.activeTools).toContain('code_execution')
    expect(afterSkillLoad?.activeTools).toContain('write_file')
    expect(afterSkillLoad?.activeTools).toContain('user_exec')
  })

  test('keeps code execution gated behind load_skill in auto mode for a single simple file', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Summarize this note.' }],
      files: [
        {
          id: 'file-1',
          name: 'note.txt',
          fileType: 'text/plain',
          storageKey: 'note-key',
        },
      ],
    } as Message

    const lockAgentMode = vi.fn()
    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: {},
      webBrowsing: false,
      agentModeValue: 'auto',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
      sideEffects: {
        lockAgentMode,
      },
    })

    expect(lockAgentMode).not.toHaveBeenCalled()
    expect(prepared.debug.effectiveAgentMode).toBe('auto')
    expect(prepared.tools.code_execution).toBeDefined()

    const beforeSkillLoad = prepared.chatOptions.prepareStep?.({ steps: [] })
    expect(beforeSkillLoad?.activeTools).not.toContain('code_execution')
  })

  test('keeps the toolset and context clean when agent mode is manually off', async () => {
    const userMessage: Message = {
      id: 'msg-1',
      role: MessageRoleEnum.User,
      timestamp: Date.now(),
      contentParts: [{ type: 'text', text: 'Answer normally.' }],
    }

    const prepared = await prepareAgentGenerationHarness({
      session: createSession(),
      settings: {
        provider: ModelProviderEnum.ChatboxAI,
        modelId: 'test-model',
      } as SessionSettings,
      globalSettings: {} as Settings,
      configs: { uuid: 'config-1' } as Config,
      messages: [userMessage],
      targetMsgIx: 1,
      model: createMockModel(),
      dependencies: {},
      webBrowsing: false,
      agentModeValue: 'off',
      agentModeLocked: false,
      agentModeSupported: true,
      signal: new AbortController().signal,
      sandboxProviderFactory: () => sandboxProviderMock as unknown as SandboxProvider,
      isPro: () => true,
    })

    expect(prepared.debug.effectiveAgentMode).toBe('off')
    expect(prepared.debug.canExecuteCode).toBe(false)
    expect(prepared.tools.code_execution).toBeUndefined()
    expect(prepared.tools.read_file).toBeUndefined()
    expect(prepared.chatOptions.tools).toBeUndefined()
    expect(JSON.stringify(prepared.coreMessages)).not.toContain('SANDBOX_MODE')
  })
})
