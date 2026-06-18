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
          text: `A shell command is about to run on the user's machine. The user needs a quick, scannable summary to decide whether to approve it.

Recent user messages for context:
${userContext}

Command:
\`\`\`
${command}
\`\`\`

Reply in ${language}, as concisely as possible, in exactly two short lines and nothing else:
Line 1 — what it does, plus any real risk (file changes, network, data loss). One sentence, no preamble.
Line 2 — start with "✅" to approve or "⚠️" to be cautious, then a few words why.
Do not restate the command, add headings, or suggest alternatives.`,
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
