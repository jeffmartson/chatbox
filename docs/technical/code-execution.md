# Chat 模式代码执行技术设计

> Last updated: 2026-06

本文档描述 Chat 模式下代码执行、Agent Mode、工具暂停审批和 HTML 产物预览的技术设计。产品说明见 [`docs/product/code-execution.md`](../product/code-execution.md)，Task 模式沙箱见 [`./task-mode.md`](./task-mode.md)。

---

## 系统概览

Chat 代码执行复用 Main 进程的本地沙箱基础设施，但在 Renderer 侧使用独立的高层工具集和 Agent Mode 编排。

```
Renderer
  orchestrateGeneration()
    ├─ shouldSuggestAgentMode()                   # 仅首轮 auto，快速分类模型
    │   └─ 命中 → 注入 agent-mode-suggestion 卡片并停止生成
    └─ prepareAgentGenerationHarness()
        ├─ computeEffectiveAgentMode(agentModeValue, supported)
        ├─ createSandboxProvider()                # desktop only
        ├─ buildToolsForSession()
        │   ├─ web_search / parse_link            # independent of agent mode
        │   ├─ code_execution / read_file / create_download
        │   ├─ filesystem tools: list/search/write/edit
        │   ├─ load_skill / install_skill / user_exec
        │   └─ MCP / knowledge base tools
        └─ chatStream(..., { tools })

Main
  src/main/sandbox/
    ├─ manager.ts                                 # sandbox session, exec, file IO
    ├─ ipc-handlers.ts                            # renderer bridge
    ├─ node-runtime.ts                            # bundled/resolved Node runtime
    ├─ preview-server.ts                          # local HTML preview
    └─ truncate.ts                                # output trimming
```

## 与 Task 模式的差异

| 维度 | Task 模式 | Chat 代码执行 |
|------|-----------|--------------|
| 工具集 | `sandbox_*` 底层工具 | `code_execution` / `read_file` / `create_download` 高层工具 |
| 工作目录 | 用户选择真实目录 | 自动临时沙箱目录 |
| 文件注入 | 用户直接操作工作目录 | 上传文件在首次工具调用时复制进沙箱 |
| 工具门控 | Task 会话内可见 | Agent Mode auto/on/off 控制 |
| 产物展示 | 面向任务日志和文件 | 消息末尾产物区、HTML 预览 |

Chat 模式当前不再向模型注入 `sandbox_*` 工具。`toolsets/sandbox.ts` 仍保留给 Task 模式和历史消息渲染使用。

## Code Execution 工具集

文件：`src/renderer/packages/model-calls/toolsets/code-execution.ts`

| 工具 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `code_execution` | `code`, `language`, `timeout?` | `{ stdout, stderr, exitCode }` | 执行短 Node.js 或 Bash 脚本。`language` 为 `node | bash` |
| `read_file` | `file_path`, `offset?`, `limit?` | `{ content, startLine, endLine, totalLines, hasMore }` | 读取沙箱文件或经授权读取用户真实文件，支持分页 |
| `create_download` | `file_path`, `display_name?` | `{ downloadable, file_path, display_name }` | 将沙箱文件标记为消息产物 |

### 运行环境

当前实现刻意移除了 Python 工具链：

- 不创建 venv，不预装 pandas/numpy/matplotlib，也不支持 pip 安装作为默认路径。
- Node.js 优先使用应用解析出的本地运行时，避免依赖用户 shell 的 `PATH` 或 nvm 初始化状态。
- Bash 只用于轻量命令和文件处理；需要复杂依赖时应让模型解释限制，而不是安装大型软件包。
- 图表优先生成 HTML/SVG/浏览器 JS，通过本地预览展示。

这个选择降低了安装包体积和签名风险，也让 Chat 代码执行聚焦于简单文件处理。

### 懒初始化和文件注入

沙箱在第一次工具调用时创建。初始化过程会把对话中的上传文件复制到会话沙箱：

- 文本文件按原文件名复制。
- 非文本文件如果已有上传阶段解析结果，会同时复制 `{filename}_parsed.txt`。
- 复制采用并发批次控制，避免大量文件 IPC 传输阻塞 UI。

工具结果必须保持小体积。大输出写入沙箱文件，再通过 `read_file` 分页、`create_download` 下载或 HTML 预览展示。

## Agent Mode

### 状态模型

```typescript
type AgentModeValue = 'auto' | 'on' | 'off'

interface AgentModeEntry {
  value: AgentModeValue
  locked: boolean
  lockReason: 'file_upload' | 'load_skill' | 'message_sent' | null
}
```

`agent` scope 是代码执行、文件工具、MCP、知识库和 Skills 的统一门控。Web Search 使用独立的 `web-browsing` scope，不受 Agent Mode 影响。

### 有效模式计算

`src/renderer/stores/session/agent-harness.ts` 中的 `computeEffectiveAgentMode(agentModeValue, agentModeSupported)`：

```typescript
export function computeEffectiveAgentMode(agentModeValue, agentModeSupported) {
  if (!agentModeSupported || agentModeValue === 'off') return 'off'
  return agentModeValue === 'on' ? 'on' : 'off'
}
```

规则：

- 模型不支持 agent scope（非桌面端），或用户选择 `off`：`effectiveAgentMode = 'off'`。
- 用户选择 `on`：`effectiveAgentMode = 'on'`，注入完整 agent 工具集。
- `auto`：`effectiveAgentMode = 'off'`。Auto **不再**根据文件类型或数量自动升级；是否进入 Agent Mode 由首轮的建议分类器决定（见下）。

### Auto 建议机制（首轮分类器）

文件触发已被移除，改为在会话首轮用一个独立的快速分类模型判断意图。逻辑位于 `orchestration.ts` 的 `shouldSuggestAgentMode()` 与 `agent-mode-suggestion.ts`。

触发条件（全部满足才运行分类器）：

- `operationType === 'send_message'` 且非 `appendToMessage`、非 `skipAgentModeSuggestion`。
- 桌面端（`agentModeSupported`）且 `agentModeValue === 'auto'`。
- 模型支持 `agent` scope。
- 当前是该 thread 的首条用户消息（`isFirstUserTurn()`）。

流程：

1. 分类模型优先取全局设置的 `threadNamingModel`（廉价快速），无法创建时回退到对话模型。
2. 用 `AGENT_MODE_SUGGESTION_PROMPT` 让模型判断该消息是否需要代码执行、文件操作、本地工具、知识库、加载 Skill 等 Agent 能力，返回 `{"suggest":boolean,"reason":string}`。
3. **suggest=true**：在消息中注入一个 `agent-mode-suggestion` content part（携带 `reason`，与用户消息同语言），`finishReason: 'agent-mode-suggested'`，**停止本轮生成**。用户点击卡片上的“使用 Agent Mode”才将会话切为 On 并继续；点击“继续普通回答”则按普通文本对话处理。
4. **suggest=false**：静默跳过，按 `effectiveAgentMode = 'off'` 走普通文本生成，不注入 Agent 工具。
5. 分类期间用户取消时，消息被标记为 stopped，不会落入已 abort 的生成流程。

### 锁定机制

| 触发 | 场景 | 效果 |
|------|------|------|
| `message_sent` | 用户在 On 模式发送消息 | 锁定为 On |
| `load_skill` | 模型加载 Skill | 锁定为 On |

`AgentModeLockReason` 类型仍保留 `'file_upload'` 取值以兼容历史会话数据，但当前代码不再因文件上传触发该锁定。

### Auto 工具门控

由于 `auto` 的 `effectiveAgentMode` 为 `'off'`，普通 Auto 对话不注入任何 Agent 工具；用户接受建议后会话变为 `on`，此时注入完整工具集。

`buildToolsForSession()` 仍保留按 `agentMode === 'auto'` 计算 `initialActiveTools` 的渐进门控逻辑（隐藏 `code_execution`、文件系统读写、`user_exec`，待 `load_skill` 触发后由 `prepareStep` 解锁完整工具集），但在当前 Chat 编排里 builder 收到的是 `effectiveAgentMode`（只会是 `on`/`off`），因此该渐进门控目前只在单元测试中覆盖，不在实时流程触发。

## Tool 构建

文件：`src/renderer/stores/session/tools-builder.ts`

构建顺序：

1. Web Search：独立于 Agent Mode，只受用户开关和 `web-browsing` scope 控制。
2. 普通文件工具：当没有 code execution provider 且模型支持 `read-file` 时，用于读取内联附件/链接。
3. Session attachment RAG：对已有 session attachment 提供检索式读取。
4. Agent 工具：`agentMode !== 'off'` 且模型支持 `agent` scope 时注入。
5. Code execution：存在 `codeExecution` provider 时注入 `code_execution/read_file/create_download`。
6. Filesystem tools：注入真实文件系统读写编辑工具，写入/编辑需要审批。
7. Skills：注入启用 Skill 元数据、`load_skill`、`chatbox_cli`、`user_exec`，以及 code execution 可用时的 `install_skill`。
8. MCP 和知识库：按会话配置和模型 scope 注入。

Chat Agent 不再 fallback 注入 `sandboxToolSet`。

## 暂停、审批和继续

工具调用可能在三类情况下进入 `paused` 状态：

| pauseReason | 触发 | 继续行为 |
|-------------|------|----------|
| `tool_call_limit` | 多轮工具调用达到上限 | 用户确认后执行原本暂停的工具调用 |
| `user_exec_approval` | `user_exec` 命令不在自动审批白名单 | 批准后执行命令，拒绝后写入拒绝结果 |
| `file_mutation_approval` | 写入或编辑用户真实文件系统 | 批准后执行文件变更，拒绝后写入拒绝结果 |

设计要点：

- 暂停状态写入 `MessageToolCallPart.state = 'paused'`，随 session 持久化。
- 重启后 UI 可从消息状态恢复“继续/停止”操作，不依赖内存 Promise。
- 点击继续后走 `continuePausedToolCall()`，执行原工具并调用 `orchestrateGeneration(..., appendToMessage: true)`，结果追加到同一条 assistant 消息。
- 暂停的 tool call 不会作为已完成工具结果注入模型上下文，避免模型误判工具已经执行。
- `user_exec` 白名单只自动批准安全只读命令；写入、删除、安装、提权和复杂 shell 组合会暂停。

## 多轮工具调用上限

`orchestration.ts` 通过 `withToolCallLimitPause()` 在达到上限时暂停，而不是返回一个普通 tool result 让模型继续循环。暂停发生在即将执行下一次工具前；用户点击继续后会执行该工具调用，并在同一条消息内继续生成。

当前常量位于 `MAX_TOOL_CALLS_BEFORE_CONFIRMATION`。发布前应确认它符合产品目标值，避免测试用小阈值影响真实用户。

## HTML 产物预览

HTML 下载产物在桌面端可复用本地预览组件展示：

- Main 进程启动本地 preview server。
- 预览 URL 使用 `http://127.0.0.1:{port}/sandbox/{relativePath}`。
- `relativePath` 是会话沙箱内相对路径，不是系统绝对路径。
- 请求会解析到当前 tool call 产物所属的沙箱会话，允许 HTML 通过相对路径加载同一沙箱中的 JS/CSS/图片资源。

由于访问范围限定在当前沙箱产物上下文内，桌面本地预览不额外使用随机 token。

## 输出截断

工具结果有多层控制：

| 层次 | 目的 |
|------|------|
| Main 进程流式缓冲上限 | 防止 stdout/stderr 无限增长导致内存问题 |
| 命令输出 tail 截断 | 保留近期有效日志 |
| Renderer 工具结果截断 | 控制写入消息数据的大小 |
| UI 错误截断 | 避免错误 JSON 或长 stderr 撑爆工具卡片 |

原则：会话消息中只保存摘要、路径和短预览；大内容写入文件，按需读取。

## 平台和模型门控

- 桌面端：可创建 `LocalSandboxProvider`，支持 Agent Mode。
- Web/Mobile：不启用 Agent Mode，不注入 agent 工具，保持纯文本对话上下文干净。
- 弱工具模型：DeepSeek R1、V3、V3.2 等 v4 以下模型禁用 agent scope。
- Web Search 是独立能力，不因为 Agent Mode Off 自动关闭。

## 测试覆盖

重点测试：

- `agent-harness.test.ts`：有效模式计算、harness 准备。
- `agent-mode-suggestion.test.ts`：首轮建议分类器的 prompt 构造与决策解析。
- `tools-builder.test.ts`：不同 agent mode、code execution provider、web search、sandbox_* 不可见。
- `agent-mode-orchestration.test.ts`：prepareStep、暂停/继续和 append 行为。
- `code-execution.test.ts`：懒初始化、文件注入、执行和错误处理。
- `user-exec-whitelist.test.ts`：自动审批白名单。
- 文件工具与 UI 组件测试：暂停审批、timeline、产物展示、HTML 预览。

## 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Chat 工具形态 | 高层 `code_execution` 替代 `sandbox_*` | 降低模型误用底层 shell/file 工具的概率 |
| 运行时 | Node.js/Bash，不内置 Python 科学栈 | 控制安装包体积和签名风险，聚焦简单文件处理 |
| Auto 进入条件 | 首轮快速分类模型建议 + 用户手动确认，移除文件类型自动升级 | 避免误判，把控制权交回用户，减少纯文本对话的上下文污染 |
| 暂停机制 | 持久化 `paused` tool call | 重启可恢复，继续后能 append 到原消息 |
| HTML 预览 | 本地 preview server + 沙箱相对路径 | 支持相对资源文件，不依赖远端 artifact 域名 |
| 工具结果 | 小结果入消息，大结果入文件 | 控制 session 数据体积和上下文缓存压力 |

## 参考资料

- 产品说明：[`docs/product/code-execution.md`](../product/code-execution.md)
- 工具与集成系统：[`./tools-and-integrations.md`](./tools-and-integrations.md)
- Agent Skills：[`./agent-skills.md`](./agent-skills.md)
- Task 模式：[`./task-mode.md`](./task-mode.md)
