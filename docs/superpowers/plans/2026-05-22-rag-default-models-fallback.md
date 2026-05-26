# RAG Default Models Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default embedding and reranking model settings that act as API-user fallbacks for knowledge-base RAG and large uploaded-file RAG.

**Architecture:** Store the two defaults in global settings as `{ provider, model }`, render them in the existing Default Models settings route, and resolve them in main-process RAG providers only when Chatbox AI paid defaults or per-knowledge-base models are unavailable. Keep existing paid-user Chatbox AI behavior unchanged.

**Tech Stack:** TypeScript, React 18, Mantine, Zustand settings store, Zod settings schema, Vitest, Electron main IPC/RAG modules, Vercel AI SDK embeddings, Cohere rerank client.

---

## File Structure

- `src/shared/types/settings.ts`
  - Add reusable `DefaultModelSelectionSchema` and two settings fields: `defaultEmbeddingModel`, `defaultRerankModel`.
- `src/shared/defaults.ts`
  - Defaults remain unset (`undefined`) for both new fields so paid users and existing users do not change behavior.
- `src/shared/types/settings.test.ts`
  - New tests for settings schema parsing and defaults. Create this file near the schema because no existing settings schema test exists.
- `src/main/rag-default-models.ts`
  - New focused helper for main-process fallback resolution. Converts settings selections to existing RAG model string format and resolves fallback embedding/rerank model strings.
- `src/main/rag-default-models.test.ts`
  - Unit tests for fallback selection logic without touching Electron or vector DB.
- `src/main/knowledge-base/model-providers.ts`
  - Use fallback embedding/rerank settings when a knowledge base row lacks those model fields. Preserve existing behavior when the row has explicit models.
- `src/main/session-attachment-rag/model-providers.ts`
  - Use Chatbox AI fixed embedding for paid users; otherwise use default embedding fallback. Add helper for default rerank fallback.
- `src/renderer/packages/model-calls/toolsets/session-attachment-rag.ts`
  - When remote session attachment rerank config is unavailable, use the default rerank setting from local settings.
- `src/renderer/packages/model-calls/toolsets/session-attachment-rag.test.ts`
  - New unit tests for toolset query-plan rerank fallback.
- `src/renderer/routes/settings/default-models.tsx`
  - Add two selectors after OCR Model. Filter to configured provider models only: `embedding` for embedding, `rerank` for reranking.

---

### Task 1: Add settings schema fields and defaults

**Files:**
- Modify: `src/shared/types/settings.ts:292-334`
- Modify: `src/shared/defaults.ts:70-145`
- Create: `src/shared/types/settings.test.ts`

- [ ] **Step 1: Write the failing schema/defaults tests**

Create `src/shared/types/settings.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { settings as defaultSettings } from '../defaults'
import { SettingsSchema } from './settings'

describe('SettingsSchema RAG default models', () => {
  test('parses default embedding and rerank model selections', () => {
    const parsed = SettingsSchema.parse({
      ...defaultSettings(),
      defaultEmbeddingModel: {
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
      defaultRerankModel: {
        provider: 'cohere',
        model: 'rerank-v3.5',
      },
    })

    expect(parsed.defaultEmbeddingModel).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    })
    expect(parsed.defaultRerankModel).toEqual({
      provider: 'cohere',
      model: 'rerank-v3.5',
    })
  })

  test('defaults leave RAG model fallbacks unset', () => {
    const parsed = SettingsSchema.parse(defaultSettings())

    expect(parsed.defaultEmbeddingModel).toBeUndefined()
    expect(parsed.defaultRerankModel).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm test src/shared/types/settings.test.ts
```

Expected: FAIL because `defaultEmbeddingModel` and `defaultRerankModel` are stripped or not present on parsed settings.

- [ ] **Step 3: Add the schema fields**

In `src/shared/types/settings.ts`, add this helper before `SettingsSchema`:

```ts
const DefaultModelSelectionSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
  })
  .optional()
  .catch(undefined)
```

Then add these fields in the `// default models` section after `ocrModel`:

```ts
  defaultEmbeddingModel: DefaultModelSelectionSchema,
  defaultRerankModel: DefaultModelSelectionSchema,
```

- [ ] **Step 4: Make defaults explicit**

In `src/shared/defaults.ts`, add these fields near the other default model defaults in the returned object:

```ts
    defaultEmbeddingModel: undefined,
    defaultRerankModel: undefined,
```

Place them before `extension` or near other default-model-related settings. Do not add concrete model IDs.

- [ ] **Step 5: Run the schema test to verify it passes**

Run:

```bash
pnpm test src/shared/types/settings.test.ts
```

Expected: PASS.

---

### Task 2: Add main-process fallback model helpers

**Files:**
- Create: `src/main/rag-default-models.ts`
- Create: `src/main/rag-default-models.test.ts`

- [ ] **Step 1: Write failing tests for helper behavior**

Create `src/main/rag-default-models.test.ts`:

```ts
import type { Settings } from '@shared/types'
import { describe, expect, test } from 'vitest'
import { getDefaultEmbeddingModelString, getDefaultRerankModelString, toRagModelString } from './rag-default-models'

function settingsWithFallbacks(overrides: Partial<Settings> = {}): Settings {
  return {
    providers: {},
    customProviders: [],
    theme: 0,
    language: 'en',
    fontSize: 14,
    shortcuts: {
      quickToggle: 'Alt+`',
      inputBoxFocus: 'mod+i',
      inputBoxWebBrowsingMode: 'mod+e',
      newChat: 'mod+n',
      newPictureChat: 'mod+shift+n',
      sessionListNavNext: 'mod+tab',
      sessionListNavPrev: 'mod+shift+tab',
      sessionListNavTargetIndex: 'mod',
      messageListRefreshContext: 'mod+r',
      dialogOpenSearch: 'mod+k',
      inputBoxSendMessage: 'Enter',
      inputBoxSendMessageWithoutResponse: 'Ctrl+Enter',
      optionNavUp: 'up',
      optionNavDown: 'down',
      optionSelect: 'enter',
    },
    extension: {
      webSearch: {
        provider: 'build-in',
      },
    },
    mcp: {
      servers: [],
      enabledBuiltinServers: [],
    },
    skills: {
      enabledSkillNames: [],
      translationEnabled: true,
    },
    showTokenUsed: true,
    showModelName: true,
    showAvatar: true,
    defaultPrompt: 'You are a helpful assistant.',
    allowReportingAndTracking: true,
    chatboxAIDesktopPromptDismissed: false,
    enableMarkdownRendering: true,
    enableLaTeXRendering: true,
    enableMermaidRendering: true,
    injectDefaultMetadata: true,
    autoPreviewArtifacts: false,
    autoCollapseCodeBlock: true,
    pasteLongTextAsAFile: true,
    autoGenerateTitle: true,
    autoCompaction: true,
    compactionThreshold: 0.6,
    autoLaunch: false,
    autoUpdate: true,
    betaUpdate: false,
    ...overrides,
  } as Settings
}

describe('RAG default model helpers', () => {
  test('formats settings model selection for RAG providers', () => {
    expect(toRagModelString({ provider: 'openai', model: 'text-embedding-3-small' })).toBe(
      'openai:text-embedding-3-small'
    )
  })

  test('returns undefined when no embedding fallback is configured', () => {
    expect(getDefaultEmbeddingModelString(settingsWithFallbacks())).toBeUndefined()
  })

  test('returns default embedding model string when configured', () => {
    expect(
      getDefaultEmbeddingModelString(
        settingsWithFallbacks({
          defaultEmbeddingModel: {
            provider: 'openai',
            model: 'text-embedding-3-small',
          },
        })
      )
    ).toBe('openai:text-embedding-3-small')
  })

  test('returns default rerank model string when configured', () => {
    expect(
      getDefaultRerankModelString(
        settingsWithFallbacks({
          defaultRerankModel: {
            provider: 'cohere',
            model: 'rerank-v3.5',
          },
        })
      )
    ).toBe('cohere:rerank-v3.5')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm test src/main/rag-default-models.test.ts
```

Expected: FAIL because `src/main/rag-default-models.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/main/rag-default-models.ts`:

```ts
import type { Settings } from '@shared/types'

type ModelSelection = {
  provider: string
  model: string
}

export function toRagModelString(selection?: ModelSelection): string | undefined {
  if (!selection?.provider || !selection.model) return undefined
  return `${selection.provider}:${selection.model}`
}

export function getDefaultEmbeddingModelString(settings: Settings): string | undefined {
  return toRagModelString(settings.defaultEmbeddingModel)
}

export function getDefaultRerankModelString(settings: Settings): string | undefined {
  return toRagModelString(settings.defaultRerankModel)
}
```

- [ ] **Step 4: Run the helper tests**

Run:

```bash
pnpm test src/main/rag-default-models.test.ts
```

Expected: PASS.

---

### Task 3: Apply fallback to knowledge-base model providers

**Files:**
- Modify: `src/main/knowledge-base/model-providers.ts:89-136`
- Modify: `src/main/knowledge-base/model-providers.ts:233-281`
- Test: `src/main/rag-default-models.test.ts`

- [ ] **Step 1: Extend helper tests with selection precedence**

Append these tests to `src/main/rag-default-models.test.ts`:

```ts
test('explicit knowledge-base embedding model wins over default fallback', () => {
  const explicitModel = 'openai:kb-specific-embedding'
  const fallback = getDefaultEmbeddingModelString(
    settingsWithFallbacks({
      defaultEmbeddingModel: {
        provider: 'openai',
        model: 'global-embedding',
      },
    })
  )

  expect(explicitModel || fallback).toBe('openai:kb-specific-embedding')
})

test('knowledge-base rerank can fall back when explicit model is empty', () => {
  const explicitModel = ''
  const fallback = getDefaultRerankModelString(
    settingsWithFallbacks({
      defaultRerankModel: {
        provider: 'cohere',
        model: 'global-rerank',
      },
    })
  )

  expect(explicitModel || fallback).toBe('cohere:global-rerank')
})
```

- [ ] **Step 2: Run the tests**

Run:

```bash
pnpm test src/main/rag-default-models.test.ts
```

Expected: PASS. These tests document precedence before wiring the provider.

- [ ] **Step 3: Wire embedding fallback in knowledge-base providers**

In `src/main/knowledge-base/model-providers.ts`, add import:

```ts
import { getDefaultEmbeddingModelString, getDefaultRerankModelString } from '../rag-default-models'
```

Replace the embedding model selection block:

```ts
        const embeddingModel = rs.rows[0].embedding_model as string
        if (!embeddingModel) {
```

with:

```ts
        const embeddingModel =
          (rs.rows[0].embedding_model as string | undefined) || getDefaultEmbeddingModelString(getSettings())
        if (!embeddingModel) {
```

Do not change the downstream parser or `createEmbeddingProviderFromModelString` call.

- [ ] **Step 4: Wire rerank fallback in knowledge-base providers**

Replace:

```ts
        const rerankModel = rs.rows[0].rerank_model as string
        if (!rerankModel) {
          return null
        }
```

with:

```ts
        const rerankModel = (rs.rows[0].rerank_model as string | undefined) || getDefaultRerankModelString(getSettings())
        if (!rerankModel) {
          return null
        }
```

- [ ] **Step 5: Run focused tests and typecheck target file**

Run:

```bash
pnpm test src/main/rag-default-models.test.ts
pnpm check
```

Expected: helper test PASS. `pnpm check` may show known route-generation baseline errors if route tree has not been generated; if so, run `pnpm build` then `pnpm check`.

---

### Task 4: Apply fallback to session attachment RAG embedding and rerank

**Files:**
- Modify: `src/main/session-attachment-rag/model-providers.ts:14-35`
- Modify: `src/renderer/packages/model-calls/toolsets/session-attachment-rag.ts:8-16`
- Create: `src/renderer/packages/model-calls/toolsets/session-attachment-rag.test.ts`

- [ ] **Step 1: Write failing test for renderer rerank fallback query plan**

Create `src/renderer/packages/model-calls/toolsets/session-attachment-rag.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'

const queryMock = vi.fn()
const getAttachmentsMock = vi.fn()
const getSessionRagConfigMock = vi.fn()
const getLicenseKeyMock = vi.fn()
const getSettingsMock = vi.fn()

vi.mock('@/platform', () => ({
  default: {
    getSessionAttachmentRagController: () => ({
      getAttachments: getAttachmentsMock,
      query: queryMock,
      readParents: vi.fn(),
    }),
  },
}))

vi.mock('@/packages/remote', () => ({
  getSessionRagConfig: getSessionRagConfigMock,
}))

vi.mock('@/stores/settingActions', () => ({
  getLicenseKey: getLicenseKeyMock,
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: getSettingsMock,
  },
}))

describe('session attachment RAG toolset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAttachmentsMock.mockResolvedValue([
      {
        id: 1,
        filename: 'large.pdf',
        status: 'ready',
      },
    ])
    getLicenseKeyMock.mockReturnValue(undefined)
    getSessionRagConfigMock.mockResolvedValue(undefined)
    getSettingsMock.mockReturnValue({
      defaultRerankModel: {
        provider: 'cohere',
        model: 'rerank-v3.5',
      },
    })
    queryMock.mockResolvedValue([])
  })

  test('uses local default rerank model when remote session RAG rerank model is unavailable', async () => {
    const { getToolSet } = await import('./session-attachment-rag')
    const toolset = await getToolSet([1])

    await toolset.tools.query_session_attachment.execute(
      { query: 'budget summary', limit: 3 },
      {
        toolCallId: 'call-1',
        messages: [],
      }
    )

    expect(queryMock).toHaveBeenCalledWith({
      attachmentIds: [1],
      query: 'budget summary',
      plan: {
        recallTopK: 20,
        finalTopK: 3,
        rerank: {
          enabled: true,
          model: 'cohere:rerank-v3.5',
        },
      },
    })
  })

  test('remote rerank model wins over local default rerank model', async () => {
    getSessionRagConfigMock.mockResolvedValue({
      capabilities: {
        session_attachment_rerank: true,
      },
      models: {
        rerank: 'chatbox-ai:rerank',
      },
    })

    const { getToolSet } = await import('./session-attachment-rag')
    const toolset = await getToolSet([1])

    await toolset.tools.query_session_attachment.execute(
      { query: 'budget summary' },
      {
        toolCallId: 'call-1',
        messages: [],
      }
    )

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          rerank: {
            enabled: true,
            model: 'chatbox-ai:rerank',
          },
        }),
      })
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm test src/renderer/packages/model-calls/toolsets/session-attachment-rag.test.ts
```

Expected: FAIL because `session-attachment-rag.ts` does not yet read `settingsStore` fallback.

- [ ] **Step 3: Implement renderer rerank fallback**

In `src/renderer/packages/model-calls/toolsets/session-attachment-rag.ts`, add imports:

```ts
import { settingsStore } from '@/stores/settingsStore'
```

Then replace:

```ts
  const useRerank = !!sessionRagConfig?.capabilities?.session_attachment_rerank
  const rerankModel = useRerank ? sessionRagConfig?.models?.rerank : undefined
```

with:

```ts
  const remoteRerankModel = sessionRagConfig?.capabilities?.session_attachment_rerank
    ? sessionRagConfig?.models?.rerank
    : undefined
  const defaultRerankModel = settingsStore.getState().defaultRerankModel
  const defaultRerankModelString = defaultRerankModel
    ? `${defaultRerankModel.provider}:${defaultRerankModel.model}`
    : undefined
  const rerankModel = remoteRerankModel || defaultRerankModelString
```

Then replace:

```ts
      enabled: !!(useRerank && rerankModel),
```

with:

```ts
      enabled: !!rerankModel,
```

- [ ] **Step 4: Implement main embedding fallback for API users**

In `src/main/session-attachment-rag/model-providers.ts`, add import:

```ts
import { getDefaultEmbeddingModelString, getDefaultRerankModelString } from '../rag-default-models'
```

Replace `getSessionAttachmentEmbeddingProvider` with:

```ts
export async function getSessionAttachmentEmbeddingProvider(): Promise<EmbeddingModel> {
  const configuredModel = store.get('settings.licenseKey')
    ? SESSION_ATTACHMENT_EMBEDDING_MODEL
    : getDefaultEmbeddingModelString(getSettings())

  if (!configuredModel) {
    throw new Error('session attachment embedding model not set')
  }

  try {
    return await createEmbeddingProviderFromModelString(configuredModel)
  } catch (error) {
    log.error(`[MODEL] Failed to resolve session attachment embedding provider: ${configuredModel}`, error)
    sentry.withScope((scope) => {
      scope.setTag('component', 'session-attachment-rag-model')
      scope.setTag('operation', 'get_embedding_provider')
      scope.setExtra('embeddingModel', configuredModel)
      sentry.captureException(error)
    })
    throw error
  }
}
```

Add this exported helper after it:

```ts
export function getDefaultSessionAttachmentRerankModelString(): string | undefined {
  return getDefaultRerankModelString(getSettings())
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test src/renderer/packages/model-calls/toolsets/session-attachment-rag.test.ts src/main/rag-default-models.test.ts
```

Expected: PASS.

---

### Task 5: Add Default Models UI selectors

**Files:**
- Modify: `src/renderer/routes/settings/default-models.tsx:1-217`

- [ ] **Step 1: Add model type filter support to the content component**

Update `ModelSelectContent` props from:

```ts
{ provider?: string; model?: string; autoText?: string; onClick?: () => void }
```

to:

```ts
{
  provider?: string
  model?: string
  autoText?: string
  onClick?: () => void
  modelType?: 'chat' | 'embedding' | 'rerank'
}
```

Update the component arguments:

```ts
>(({ provider, model, autoText, onClick, modelType }, ref) => {
```

Update `modelOptions` to filter when `modelType` is provided:

```ts
    return enrichModelsFromRegistry(rawModels, provider).filter((candidate) =>
      modelType ? candidate.type === modelType : true
    )
```

- [ ] **Step 2: Add Default Embedding Model selector after OCR Model**

Insert after the OCR `Stack` block:

```tsx
      <Stack gap="xs">
        <Text fw={600}>{t('Default Embedding Model')}</Text>

        <ModelSelector
          position="bottom-start"
          showAuto={true}
          autoText={t('None')!}
          width={320}
          modelFilter={(model) => model.type === 'embedding'}
          selectedProviderId={settings.defaultEmbeddingModel?.provider}
          selectedModelId={settings.defaultEmbeddingModel?.model}
          searchPosition="top"
          onSelect={(provider, model) =>
            setSettings({
              defaultEmbeddingModel:
                provider && model
                  ? {
                      provider,
                      model,
                    }
                  : undefined,
            })
          }
        >
          <ModelSelectContent
            autoText={t('None')!}
            provider={settings.defaultEmbeddingModel?.provider}
            model={settings.defaultEmbeddingModel?.model}
            modelType="embedding"
          />
        </ModelSelector>

        <Text c="chatbox-tertiary" size="xs">
          {t('Chatbox will use this embedding model as the fallback for RAG when Chatbox AI defaults are unavailable.')}
        </Text>
      </Stack>
```

- [ ] **Step 3: Add Default Reranking Model selector after embedding selector**

Insert immediately after the embedding block:

```tsx
      <Stack gap="xs">
        <Text fw={600}>{t('Default Reranking Model')}</Text>

        <ModelSelector
          position="bottom-start"
          showAuto={true}
          autoText={t('None')!}
          width={320}
          modelFilter={(model) => model.type === 'rerank'}
          selectedProviderId={settings.defaultRerankModel?.provider}
          selectedModelId={settings.defaultRerankModel?.model}
          searchPosition="top"
          onSelect={(provider, model) =>
            setSettings({
              defaultRerankModel:
                provider && model
                  ? {
                      provider,
                      model,
                    }
                  : undefined,
            })
          }
        >
          <ModelSelectContent
            autoText={t('None')!}
            provider={settings.defaultRerankModel?.provider}
            model={settings.defaultRerankModel?.model}
            modelType="rerank"
          />
        </ModelSelector>

        <Text c="chatbox-tertiary" size="xs">
          {t('Chatbox will use this reranking model as the fallback for RAG when Chatbox AI defaults are unavailable.')}
        </Text>
      </Stack>
```

Do not edit `src/renderer/i18n/locales/*/translation.json`.

- [ ] **Step 4: Run formatter and typecheck**

Run:

```bash
pnpm format
pnpm check
```

Expected: formatting succeeds. If `pnpm check` reports route-related generated route errors, run `pnpm build` and then `pnpm check` again per `CLAUDE.md`.

---

### Task 6: Verify full behavior

**Files:**
- No new production files beyond previous tasks.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test src/shared/types/settings.test.ts src/main/rag-default-models.test.ts src/renderer/packages/model-calls/toolsets/session-attachment-rag.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run broader test target**

Run:

```bash
pnpm test
```

Expected: Existing repository baseline may include pre-existing token-estimation failures. Confirm no new failures are from the files changed in this plan.

- [ ] **Step 3: Run lint/type/build checks**

Run:

```bash
pnpm lint
pnpm check
```

Expected: `pnpm lint` may report pre-existing Biome warnings/errors per `CLAUDE.md`; confirm no new errors from changed files. `pnpm check` should pass after route generation is available.

- [ ] **Step 4: Manual UI verification**

Run the app:

```bash
pnpm dev
```

Open Settings → Default Models. Verify:

1. The two new controls appear after OCR Model.
2. Embedding selector only lists configured provider models with `type: 'embedding'`.
3. Reranking selector only lists configured provider models with `type: 'rerank'`.
4. Selecting and clearing each control persists in settings.
5. Locale JSON files remain untouched.

- [ ] **Step 5: Manual RAG verification**

With no Chatbox AI license and a provider configured with embedding/rerank models:

1. Set Default Embedding Model.
2. Upload a large file to a chat so it uses session attachment RAG.
3. Confirm indexing does not fail with missing Chatbox AI token.
4. Ask a question about the uploaded file and confirm retrieval returns relevant content.
5. Set Default Reranking Model and confirm the retrieval query still succeeds.

---

## Self-Review

- Spec coverage: This plan covers settings storage, Default Models UI, knowledge-base fallback, large uploaded-file RAG fallback, paid-user precedence, and tests.
- Placeholder scan: No TBD/TODO placeholders remain in implementation steps.
- Type consistency: The settings fields are consistently named `defaultEmbeddingModel` and `defaultRerankModel`, shaped as `{ provider, model }`, and converted to existing RAG model strings with `provider:model`.
