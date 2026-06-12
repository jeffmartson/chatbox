import { Text } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import clsx from 'clsx'
import { ScalableIcon } from '../common/ScalableIcon'
import ProviderIcon from '../icons/ProviderIcon'

export function ProviderRowHeader({
  provider,
  modelCount,
  collapsed,
  onToggle,
}: {
  provider: { id: string; name: string; isCustom?: boolean }
  modelCount: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full h-10 px-2.5 flex items-center gap-2 border-0 border-b border-solid border-chatbox-border-primary bg-transparent text-chatbox-tint-primary cursor-pointer"
    >
      <ScalableIcon
        icon={IconChevronDown}
        size={15}
        className={clsx('transition-transform', collapsed && '-rotate-90')}
      />
      <ProviderIcon provider={provider.id} size={18} />
      <Text span fw={650} size="sm" lh={1.2} className="min-w-0 flex-1 text-left truncate">
        {provider.name}
      </Text>
      <Text span size="xs" c="chatbox-tertiary">
        {modelCount}
      </Text>
    </button>
  )
}
