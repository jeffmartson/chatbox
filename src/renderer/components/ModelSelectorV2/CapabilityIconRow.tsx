import { Flex } from '@mantine/core'
import type { ProviderModelInfo } from '@shared/types'
import { IconBulb, IconEye, IconTool } from '@tabler/icons-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { ScalableIcon } from '../common/ScalableIcon'

export function CapabilityIconRow({
  capabilities,
  compact,
}: {
  capabilities?: ProviderModelInfo['capabilities']
  compact?: boolean
}) {
  const { t } = useTranslation()
  const items = [
    { id: 'vision', label: t('Vision'), icon: IconEye },
    { id: 'reasoning', label: t('Reasoning'), icon: IconBulb },
    { id: 'tool_use', label: t('Tool Use'), icon: IconTool },
  ].filter((item) => capabilities?.includes(item.id as NonNullable<ProviderModelInfo['capabilities']>[number]))

  if (items.length === 0) return null

  return (
    <Flex gap="xs" wrap="wrap">
      {items.map((item) => (
        <Flex
          key={item.id}
          align="center"
          gap={4}
          className={clsx(
            'rounded-full bg-chatbox-background-tertiary text-chatbox-tint-secondary',
            compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
          )}
        >
          <ScalableIcon icon={item.icon} size={compact ? 13 : 15} />
          <span>{item.label}</span>
        </Flex>
      ))}
    </Flex>
  )
}
