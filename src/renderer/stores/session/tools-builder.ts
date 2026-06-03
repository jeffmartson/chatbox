import type { ModelInterface } from '@shared/models/types'
import type { SandboxProvider } from '@shared/sandbox-provider'
import type { AgentModeValue, KnowledgeBase, Message, SessionSettings } from '@shared/types'
import { getMessageText } from '@shared/utils/message'
import { jsonSchema, type ToolSet } from 'ai'
import { mcpController } from '@/packages/mcp/controller'
import { generateCommandExplanation } from '@/packages/model-calls/command-explanation'
import { buildChatboxCliToolSet } from '@/packages/model-calls/toolsets/chatbox-cli'
import { buildCodeExecutionTools } from '@/packages/model-calls/toolsets/code-execution'
import fileToolSet from '@/packages/model-calls/toolsets/file'
import { buildFilesystemTools } from '@/packages/model-calls/toolsets/filesystem'
import { getToolSet as getKBToolSet } from '@/packages/model-calls/toolsets/knowledge-base'
import { getToolSet as getSessionAttachmentRagToolSet } from '@/packages/model-calls/toolsets/session-attachment-rag'
import { getToolSetDescription, parseLinkTool, webSearchTool } from '@/packages/model-calls/toolsets/web-search'
import { skillsController, subscribeSkillsChanged } from '@/packages/skills/controller'
import { type ExplanationContext, requestUserExecApproval } from '@/packages/user-exec-approval'
import { PROVIDERS_WITH_PARSE_LINK } from '@/packages/web-search'
import * as settingActions from '@/stores/settingActions'
import { settingsStore } from '@/stores/settingsStore'

// Cache discoverSkills() to avoid IPC on every message generation
let cachedSkills: Array<{ name: string; description: string }> | null = null
let cachedSkillsTimestamp = 0
const SKILLS_CACHE_TTL = 30_000 // 30 seconds

async function getDiscoveredSkills(): Promise<Array<{ name: string; description: string }>> {
  const now = Date.now()
  if (cachedSkills && now - cachedSkillsTimestamp < SKILLS_CACHE_TTL) {
    return cachedSkills
  }
  const allSkills = await skillsController.discoverSkills()
  cachedSkills = allSkills.map((s) => ({ name: s.name, description: s.description }))
  cachedSkillsTimestamp = now
  return cachedSkills
}

/** Reset the renderer-side skills cache. Call after installing/deleting skills. */
export function resetSkillsCache(): void {
  cachedSkills = null
  cachedSkillsTimestamp = 0
}

subscribeSkillsChanged(resetSkillsCache)

export interface BuildToolsOptions {
  webBrowsing: boolean
  knowledgeBase?: Pick<KnowledgeBase, 'id' | 'name'>
  messages: Message[]
  agentMode: AgentModeValue
  sessionSettings?: SessionSettings
  codeExecution?: {
    sessionId: string
    provider: SandboxProvider
    files: Array<{ storageKey: string; rawStorageKey?: string; name: string }>
  }
  onAgentModeActivated?: () => void
}

export interface BuildToolsResult {
  tools: ToolSet
  instructions: string
  /** When agentMode is 'auto', only these tools are active until load_skill escalates to full mode. */
  initialActiveTools?: string[]
}

function buildSkillToolsInstruction(enabledSkills: Array<{ name: string; description: string }>): string {
  let instruction = `
## Skills
You have access to skills that can extend your capabilities.
`

  if (enabledSkills.length > 0) {
    instruction += `
### Available Skills
${enabledSkills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}

When the user's request matches a skill's purpose, call load_skill to load its full instructions before proceeding.
Loading a skill activates agent mode.
`
  } else {
    instruction += `
No skills are currently enabled.
`
  }

  instruction += `
### Running Commands in User Environment
**user_exec** runs commands in the user's real environment with full system access. This is a privileged tool.
Only use user_exec when a loaded skill explicitly instructs you to run a command in the user's environment.
Do NOT use user_exec on your own initiative — use code_execution (sandbox) for file processing, data analysis, downloading files, and all other tasks.

### Installing Skills
You can install skills from any source:
1. Use code_execution (sandbox) to download and unpack the skill files
2. Ensure the directory contains a valid SKILL.md with name and description
3. Call install_skill with the sandbox path
The skill will be auto-enabled after installation.
`
  return instruction
}

function getSessionAttachmentRagIds(messages: Message[]): number[] {
  return Array.from(
    new Set(
      messages.flatMap((message) =>
        (message.files ?? [])
          .filter(
            (file) =>
              file.ragMode === 'session-retrieval' &&
              file.sessionAttachmentAvailability !== 'blocked' &&
              typeof file.sessionAttachmentId === 'number'
          )
          .map((file) => file.sessionAttachmentId as number)
      )
    )
  )
}

/**
 * Builds the tool set and instructions for a chat session based on model capabilities and session options.
 *
 * agentMode controls skill and code execution tool availability:
 * - 'off': No skill or code execution tools
 * - 'auto': load_skill only (code execution tools gated behind load_skill activation)
 * - 'on': Full suite — skills + code execution
 */
export async function buildToolsForSession(
  model: ModelInterface,
  options: BuildToolsOptions
): Promise<BuildToolsResult> {
  const { webBrowsing, knowledgeBase, messages, agentMode, codeExecution } = options

  // Agent mode tools require model to support the 'agent' scope.
  // Models with weak function calling (e.g. DeepSeek V3/R1) return false here,
  // so they won't get any agent-specific tools (MCP, sandbox, skills, KB, code execution).
  // Web search is independent — it works outside agent mode.
  const modelSupportsAgentTools = model.isSupportToolUse('agent')
  const includeAgentTools = (agentMode === 'on' || agentMode === 'auto') && modelSupportsAgentTools

  const hasInlineFileOrLink = messages.some(
    (m) => m.links?.length || m.files?.some((file) => file.ragMode !== 'session-retrieval')
  )
  const sessionAttachmentIds = getSessionAttachmentRagIds(messages)
  // When code execution is enabled, file tools are replaced by code_execution + sandbox read_file.
  const needFileToolSet = !codeExecution && hasInlineFileOrLink && model.isSupportToolUse('read-file')
  const needSessionAttachmentRagToolSet = sessionAttachmentIds.length > 0 && model.isSupportToolUse('read-file')
  const kbSupported = includeAgentTools && knowledgeBase && model.isSupportToolUse('knowledge-base')
  const webSupported = webBrowsing && model.isSupportToolUse('web-browsing')
  const searchProvider = settingActions.getExtensionSettings().webSearch.provider
  const includeParseLinkTool = webSupported && PROVIDERS_WITH_PARSE_LINK.has(searchProvider)

  let kbToolSet: Awaited<ReturnType<typeof getKBToolSet>> | null = null
  if (knowledgeBase && kbSupported) {
    try {
      kbToolSet = await getKBToolSet(knowledgeBase.id, knowledgeBase.name)
    } catch (err) {
      console.error('Failed to load knowledge base toolset:', err)
    }
  }

  let sessionAttachmentRagToolSet: Awaited<ReturnType<typeof getSessionAttachmentRagToolSet>> | null = null
  if (needSessionAttachmentRagToolSet) {
    try {
      sessionAttachmentRagToolSet = await getSessionAttachmentRagToolSet(sessionAttachmentIds)
    } catch (err) {
      console.error('Failed to load session attachment RAG toolset:', err)
    }
  }

  let instructions = includeAgentTools
    ? `## Context Management
In long conversations, earlier tool call results may be automatically compressed or summarized to stay within the context window. When you receive important results from tool calls, always include the key findings and essential data in your text response — do not rely on being able to re-read previous tool outputs later.
`
    : ''
  if (kbToolSet && kbSupported) {
    instructions += kbToolSet.description
  }
  if (sessionAttachmentRagToolSet) {
    instructions += sessionAttachmentRagToolSet.description
  }
  if (needFileToolSet) {
    instructions += fileToolSet.description
  }
  if (webSupported) {
    instructions += getToolSetDescription({ includeParseLink: includeParseLinkTool })
  }

  let codeExecToolSet: ReturnType<typeof buildCodeExecutionTools> | null = null
  if (includeAgentTools && codeExecution) {
    codeExecToolSet = buildCodeExecutionTools(codeExecution)
    instructions += codeExecToolSet.description
  }

  let tools: ToolSet = {}

  // MCP tools: agent mode only, requires model support
  if (includeAgentTools) {
    tools = { ...mcpController.getAvailableTools() }
  }

  // Web search: works independently of agent mode
  if (webBrowsing && webSupported) {
    tools.web_search = webSearchTool
    // Inject parse_link based on the selected provider's declared capability.
    // Validation (Pro for build-in, API key for third parties) happens at execution time.
    if (includeParseLinkTool) {
      tools.parse_link = parseLinkTool
    }
  }

  if (kbToolSet && kbSupported) {
    tools = { ...tools, ...kbToolSet.tools }
  }

  if (sessionAttachmentRagToolSet) {
    tools = { ...tools, ...sessionAttachmentRagToolSet.tools }
  }

  if (needFileToolSet) {
    tools = { ...tools, ...fileToolSet.tools }
  }

  if (codeExecToolSet) {
    tools = { ...tools, ...codeExecToolSet.tools }
  }

  if (includeAgentTools) {
    const filesystemToolSet = buildFilesystemTools({
      sessionId: codeExecution?.sessionId,
      provider: codeExecution?.provider,
    })
    instructions += filesystemToolSet.description
    tools = { ...tools, ...filesystemToolSet.tools }
  }

  // Skills tools: agent mode only, requires model support
  if (includeAgentTools) {
    const allSkills = await getDiscoveredSkills()
    const skillSettings = settingsStore.getState().getSettings().skills
    const enabledSkills = allSkills.filter((s) => skillSettings.enabledSkillNames.includes(s.name))
    instructions += buildSkillToolsInstruction(enabledSkills)
    tools.load_skill = buildLoadSkillTool(options)
    if (enabledSkills.some((skill) => skill.name === 'chatbox-product-info')) {
      const chatboxCliToolSet = buildChatboxCliToolSet({
        onUsed: options.onAgentModeActivated,
      })
      instructions += chatboxCliToolSet.description
      tools = { ...tools, ...chatboxCliToolSet.tools }
    }
    tools.user_exec = buildUserExecTool(options)
    if (codeExecution) {
      tools.install_skill = buildInstallSkillTool(options)
    }
  }

  // In 'auto' mode, only expose skill discovery tools initially.
  // Full tools become available after load_skill fires (via prepareStep).
  let initialActiveTools: string[] | undefined
  if (agentMode === 'auto' && includeAgentTools) {
    const allToolNames = Object.keys(tools)
    // Code execution and file mutation tools are gated behind load_skill activation.
    const codeExecToolNames = codeExecToolSet ? new Set(Object.keys(codeExecToolSet.tools)) : new Set<string>()
    const filesystemToolNames = new Set(['list_files', 'search_files', 'write_file', 'edit_file'])
    const gatedTools = new Set([...codeExecToolNames, ...filesystemToolNames, 'user_exec'])
    // install_skill should be available immediately so downloaded skills can be installed before loading one.
    gatedTools.delete('install_skill')
    initialActiveTools = allToolNames.filter((name) => !gatedTools.has(name))
  }

  return { tools, instructions, initialActiveTools }
}

function buildLoadSkillTool(options: BuildToolsOptions): ToolSet[string] {
  return {
    description:
      "Load a skill by name to get its full instructions. Call this when the user's request " +
      'matches an available skill. Available skills are listed in the system instructions.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the skill to load',
        },
      },
      required: ['name'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const skillInput = input as { name: string }
      const skillSettings = settingsStore.getState().getSettings().skills
      if (!skillSettings.enabledSkillNames.includes(skillInput.name)) {
        return { error: `Skill "${skillInput.name}" is not enabled. Check available skills in the system instructions.` }
      }

      const result = await skillsController.loadSkill(skillInput.name)
      if (!result) {
        return { error: `Skill "${skillInput.name}" not found or could not be loaded.` }
      }

      // Trigger agent mode activation
      try {
        options.onAgentModeActivated?.()
      } catch (err) {
        console.warn('onAgentModeActivated callback failed:', err)
      }

      return { instructions: result.body }
    },
  }
}

function buildInstallSkillTool(options: BuildToolsOptions): ToolSet[string] {
  return {
    description:
      'Install a skill from a prepared directory. ' +
      'First use code_execution (sandbox) to download/unpack the skill files, ensure the directory ' +
      'contains a valid SKILL.md with name and description fields, then call this tool. ' +
      'The skill will be auto-enabled after installation.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        sandboxPath: {
          type: 'string',
          description: 'Path to the skill directory (must contain SKILL.md)',
        },
        sourceInfo: {
          type: 'string',
          description: 'Where the skill came from (URL, repo, etc.) for tracking',
        },
      },
      required: ['sandboxPath'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const installInput = input as { sandboxPath: string; sourceInfo?: string }
      if (!options.codeExecution) {
        return { error: 'Code execution not available. Agent mode with sandbox is required.' }
      }

      const result = await skillsController.installFromSandbox(
        installInput.sandboxPath,
        options.codeExecution.sessionId,
        installInput.sourceInfo
      )

      if (!result.success) {
        return { error: result.error || 'Installation failed.' }
      }

      // Auto-enable the installed skill
      settingsStore.setState((state) => ({
        skills: {
          ...state.skills,
          enabledSkillNames: [...new Set([...state.skills.enabledSkillNames, result.skillName])],
        },
      }))

      // Reset renderer-side skills cache so load_skill sees the new skill immediately
      resetSkillsCache()

      // Trigger agent mode activation
      try {
        options.onAgentModeActivated?.()
      } catch (err) {
        console.warn('onAgentModeActivated callback failed:', err)
      }

      return {
        success: true,
        skillName: result.skillName,
        message: `Skill "${result.skillName}" installed and enabled. You can now use load_skill("${result.skillName}") to load it.`,
      }
    },
  }
}

function buildUserExecTool(options: BuildToolsOptions): ToolSet[string] {
  return {
    description:
      "Execute a command in the user's real environment (not sandbox). " +
      'RESTRICTED: Only use when a loaded skill explicitly requires running a command in the user environment. ' +
      'Do NOT use for general tasks — use code_execution (sandbox) instead. ' +
      "Runs in the user's login shell with full system access. " +
      'The user must approve the command before it runs.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
      },
      required: ['command'],
      additionalProperties: false,
    }),
    execute: async (input, toolOptions) => {
      const execInput = input as { command: string }
      const alreadyApproved = (toolOptions as typeof toolOptions & { approved?: boolean }).approved
      const recentUserMsgs = options.messages
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => getMessageText(m, true, false).slice(0, 500))
      const userContext = recentUserMsgs.join('\n---\n')

      const sessionSettings = options.sessionSettings
      const explanationCtx: ExplanationContext | undefined = sessionSettings
        ? {
            userContext,
            generateExplanation: (cmd, ctx, onStream) =>
              generateCommandExplanation(sessionSettings, cmd, ctx, onStream),
          }
        : undefined

      const approved =
        alreadyApproved || (await requestUserExecApproval(toolOptions.toolCallId, execInput.command, explanationCtx))

      if (!approved) {
        return {
          success: false,
          exitCode: null,
          stdout: '',
          stderr: 'Command denied by user.',
        }
      }

      const result = await skillsController.userExec(execInput.command)

      try {
        options.onAgentModeActivated?.()
      } catch {
        // ignore
      }

      return {
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },
  }
}
