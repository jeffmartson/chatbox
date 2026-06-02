import type { SessionSettings } from '@shared/types'
import type { Message } from '@shared/types'
import { createModel } from '@/adapters'
import { languageNameMap } from '@/i18n/locales'
import { convertToModelMessages } from '@/packages/model-calls/message-utils'
import { settingsStore } from '@/stores/settingsStore'

function buildExplanationMessages(command: string, userContext: string, language: string): Message[] {
  return [
    {
      id: 'explain-cmd',
      role: 'user',
      contentParts: [
        {
          type: 'text',
          text: `A shell command is about to be executed on the user's machine. Explain what it does and any consequences (file changes, network access, system modifications, data loss risks).

Recent user messages for context:
${userContext}

Command:
\`\`\`
${command}
\`\`\`

Provide a brief, clear explanation in 1-3 sentences. Focus on what the command does and any risks. At the end, give a clear recommendation: whether the user should approve or reject this command, and why. Respond in ${language}. Do not suggest alternative commands.`,
        },
      ],
    },
  ]
}

export async function generateCommandExplanation(
  settings: SessionSettings,
  command: string,
  userContext: string,
  onStreamUpdate?: (text: string) => void
): Promise<string> {
  const model = await createModel(settings)
  const language = languageNameMap[settingsStore.getState().getSettings().language] || 'English'
  const messages = buildExplanationMessages(command, userContext, language)
  const coreMessages = await convertToModelMessages(messages, { modelSupportVision: model.isSupportVision() })

  const result = await model.chat(coreMessages, {
    onResultChange: (data) => {
      if (data.contentParts && onStreamUpdate) {
        const text = data.contentParts
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
        onStreamUpdate(text)
      }
    },
  })

  return (
    result.contentParts
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('') || ''
  )
}
