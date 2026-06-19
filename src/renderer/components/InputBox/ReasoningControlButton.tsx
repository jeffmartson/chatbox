import { Menu, Text, Tooltip, UnstyledButton } from '@mantine/core'
import type { ProviderModelInfo, ProviderOptions } from '@shared/types'
import {
  getReasoningControlCapabilities,
  getReasoningControlLevel,
  getReasoningControlOptions,
  type ReasoningControlDisabledReason,
  type ReasoningControlLevel,
  type ReasoningControlOption,
} from '@shared/utils/reasoning-control'
import { IconBrain } from '@tabler/icons-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface ReasoningControlButtonProps {
  provider?: string
  model?: ProviderModelInfo | null
  providerOptions?: ProviderOptions
  iconSize: number
  onChange: (level: ReasoningControlLevel) => void
}

const LEVEL_COLORS: Record<ReasoningControlLevel, string> = {
  off: 'var(--chatbox-tint-tertiary)',
  low: 'var(--chatbox-tint-secondary)',
  medium: 'var(--chatbox-tint-brand)',
  high: 'var(--chatbox-tint-brand)',
}

export default function ReasoningControlButton({
  provider,
  model,
  providerOptions,
  iconSize,
  onChange,
}: ReasoningControlButtonProps) {
  const { t } = useTranslation()
  const capabilities = useMemo(() => getReasoningControlCapabilities(provider, model), [provider, model])
  const level = useMemo(
    () => getReasoningControlLevel(provider, model, providerOptions),
    [provider, model, providerOptions]
  )
  const options = useMemo(() => getReasoningControlOptions(provider, model), [provider, model])

  if (!capabilities.supported && !capabilities.disabledReason) {
    return null
  }

  if (capabilities.disabledReason) {
    return (
      <Tooltip label={getDisabledReasonLabel(capabilities.disabledReason, t)} position="top" withArrow>
        <span>
          <UnstyledButton
            className="flex items-center gap-1 px-2 py-1 rounded-lg cursor-not-allowed opacity-60"
            style={{ color: 'var(--chatbox-tint-tertiary)' }}
            disabled
          >
            <IconBrain size={iconSize} strokeWidth={1.8} />
          </UnstyledButton>
        </span>
      </Tooltip>
    )
  }

  const selectedOption = options.find((item) => item.level === level)
  const levelLabel = getOptionLabel(selectedOption || { level, label: level }, t)

  return (
    <Menu
      shadow="md"
      trigger="click"
      position="top-start"
      openDelay={100}
      closeDelay={100}
      keepMounted
      transitionProps={{ transition: 'pop', duration: 200 }}
    >
      <Menu.Target>
        <Tooltip label={t('Thinking: {{level}}', { level: levelLabel })} position="top" withArrow>
          <UnstyledButton
            className={
              'flex items-center gap-1 px-2 py-1 rounded-lg ' +
              'hover:bg-[var(--chatbox-background-tertiary)] transition-colors'
            }
            style={{ color: LEVEL_COLORS[level] }}
          >
            <IconBrain size={iconSize} strokeWidth={1.8} />
            <Text span size="xs" fw={500} className="whitespace-nowrap" c="inherit">
              {levelLabel}
            </Text>
          </UnstyledButton>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label fw={600}>{t('Thinking Effort')}</Menu.Label>
        {options.map((item) => (
          <Menu.Item
            key={item.level}
            onClick={() => onChange(item.level)}
            color={item.level === level ? 'chatbox-brand' : undefined}
          >
            {getOptionLabel(item, t)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}

// Literal t() calls so i18next-parser (which only scans src/renderer) can extract the keys
function getDisabledReasonLabel(reason: ReasoningControlDisabledReason, t: (key: string) => string): string {
  switch (reason) {
    case 'requires-anthropic-api-style':
      return t(
        'Thinking controls are disabled because this Claude model is not exposed through the Anthropic API style.'
      )
    case 'requires-google-api-style':
      return t('Thinking controls are disabled because this Gemini model is not exposed through the Google API style.')
    case 'requires-openai-api-style':
      return t('Thinking controls are disabled because this GPT model is not exposed through an OpenAI API style.')
    case 'requires-deepseek-api-style':
      return t(
        'Thinking controls are disabled because this DeepSeek model is not exposed through the DeepSeek API style.'
      )
    case 'requires-qwen-api-style':
      return t('Thinking controls are disabled because this Qwen model is not exposed through the Qwen API style.')
    case 'requires-xai-api-style':
      return t('Thinking controls are disabled because this Grok model is not exposed through the xAI API style.')
  }
}

function getOptionLabel(option: ReasoningControlOption, t: (key: string) => string): string {
  if (option.label === 'on') return t('On')
  return getLevelLabel(option.level, t)
}

function getLevelLabel(level: ReasoningControlLevel, t: (key: string) => string): string {
  switch (level) {
    case 'off':
      return t('Off')
    case 'low':
      return t('Low')
    case 'medium':
      return t('Medium')
    case 'high':
      return t('High')
  }
}
