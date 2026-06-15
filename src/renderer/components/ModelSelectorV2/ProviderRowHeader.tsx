import { Text } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import clsx from 'clsx'
import { ScalableIcon } from '../common/ScalableIcon'
import ProviderIcon from '../icons/ProviderIcon'

export function ProviderRowHeader({
  provider,
  modelCount,
  collapsed,
  variant = 'generic',
  onToggle,
}: {
  provider: { id: string; name: string; isCustom?: boolean }
  modelCount: number
  collapsed: boolean
  variant?: 'chatbox' | 'generic'
  onToggle: () => void
}) {
  const isChatbox = variant === 'chatbox'
  return (
    <button
      type="button"
      onClick={onToggle}
      className={clsx(
        'w-full flex items-center gap-2 border-0 border-b border-solid text-chatbox-tint-primary cursor-pointer transition-colors focus:outline-none focus-visible:outline-none',
        isChatbox
          ? 'sticky top-0 z-20 h-11 pl-4 pr-2.5 border-chatbox-border-primary bg-chatbox-background-primary'
          : 'h-10 px-2.5 border-chatbox-border-primary bg-chatbox-background-primary hover:bg-chatbox-background-primary-hover'
      )}
    >
      <ScalableIcon
        icon={IconChevronDown}
        size={15}
        className={clsx('transition-transform', collapsed && '-rotate-90')}
      />
      <span
        className={clsx(
          'flex items-center justify-center flex-shrink-0',
          isChatbox && 'h-6 w-6 rounded-md bg-chatbox-background-brand-secondary'
        )}
      >
        <ProviderIcon provider={provider.id} size={isChatbox ? 19 : 18} />
      </span>
      <Text span fw={isChatbox ? 720 : 650} size="sm" lh={1.2} className="min-w-0 flex-1 text-left truncate">
        {provider.name}
      </Text>
      <Text
        span
        size="xs"
        c={isChatbox ? 'chatbox-brand' : 'chatbox-tertiary'}
        className={clsx(isChatbox && 'font-semibold')}
      >
        {modelCount}
      </Text>
    </button>
  )
}
