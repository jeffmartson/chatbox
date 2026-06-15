import { ActionIcon, Flex, Text, Tooltip } from '@mantine/core'
import type { ProviderModelInfo } from '@shared/types'
import { IconBolt, IconEye, IconInfoCircle, IconLock, IconStar, IconStarFilled } from '@tabler/icons-react'
import clsx from 'clsx'
import type { KeyboardEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import platform from '@/platform'
import { ScalableIcon } from '../common/ScalableIcon'
import { ModelIcon } from '../icons/ModelIcon'
import { HOVER_CLASS, MOBILE_TAP_RESET_STYLE, SELECTED_CLASS } from './constants'
import { getCostLabel } from './helpers'
import type { DetailModel } from './types'

function RowIconButton({
  label,
  children,
  onClick,
  mobile,
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
  mobile?: boolean
}) {
  return (
    <Tooltip
      label={label}
      position="top"
      withArrow
      events={{ hover: !mobile, focus: true, touch: !!mobile }}
      openDelay={160}
    >
      <ActionIcon
        aria-label={label}
        variant="transparent"
        size={mobile ? 'sm' : 'xs'}
        className="text-chatbox-tint-tertiary hover:text-chatbox-tint-secondary"
        onClick={(event) => {
          event.stopPropagation()
          onClick?.()
        }}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

export function ModelRow({
  detail,
  providerModel,
  selected,
  favorited,
  locked,
  mobile,
  hideFavorite,
  brandedInset,
  pricingLink,
  onSelect,
  onFavorite,
  onShowDetail,
  onDesktopDetailOpen,
  onDesktopDetailClose,
  onDisabledSelect,
}: {
  detail: DetailModel
  providerModel: ProviderModelInfo
  selected: boolean
  favorited: boolean
  locked?: boolean
  mobile?: boolean
  hideFavorite?: boolean
  brandedInset?: boolean
  pricingLink?: string
  onSelect: () => void
  onFavorite: () => void
  onShowDetail?: () => void
  onDesktopDetailOpen?: (anchor: HTMLElement) => void
  onDesktopDetailClose?: () => void
  onDisabledSelect?: () => void
}) {
  const { t } = useTranslation()
  const handleRowAction = () => {
    if (detail.disabledReason && !locked) {
      onDisabledSelect?.()
      return
    }
    if (locked) {
      onShowDetail?.()
      return
    }
    onSelect()
  }
  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handleRowAction()
  }
  const handleMouseEnter = (event: MouseEvent<HTMLDivElement>) => {
    onDesktopDetailOpen?.(event.currentTarget)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={!!detail.disabledReason && !locked}
      className={clsx(
        'w-full flex items-center border-0 bg-transparent text-left cursor-pointer text-chatbox-tint-primary focus:outline-none focus-visible:outline-none',
        mobile
          ? clsx('min-h-11 pr-3 gap-2.5', brandedInset ? 'pl-4' : 'pl-3')
          : clsx('h-9 pr-2.5 gap-1.5', brandedInset ? 'pl-4' : 'pl-2.5'),
        !mobile && (selected ? SELECTED_CLASS : HOVER_CLASS),
        detail.disabledReason && !locked && 'opacity-50 cursor-not-allowed'
      )}
      style={mobile ? MOBILE_TAP_RESET_STYLE : undefined}
      onClick={handleRowAction}
      onKeyDown={handleRowKeyDown}
      onMouseEnter={mobile ? undefined : handleMouseEnter}
      onMouseLeave={mobile ? undefined : onDesktopDetailClose}
    >
      <ModelIcon
        providerId={detail.providerId}
        modelId={detail.modelId}
        size={mobile ? 20 : 18}
        className="flex-shrink-0"
      />
      <Text span size="sm" fw={500} lh={1.15} className="min-w-0 flex-shrink truncate">
        {detail.name}
      </Text>
      <Flex align="center" gap={mobile ? 4 : 1} className="min-w-0 flex-shrink-0">
        {detail.costLevel && (
          <RowIconButton
            label={getCostLabel(detail.costLevel, t)}
            onClick={() => pricingLink && platform.openLink(pricingLink)}
            mobile={mobile}
          >
            <ScalableIcon icon={IconBolt} size={mobile ? 16 : 14} className="text-chatbox-tint-warning" />
          </RowIconButton>
        )}
        {providerModel.capabilities?.includes('vision') && (
          <RowIconButton label={t('Vision')} mobile={mobile}>
            <ScalableIcon icon={IconEye} size={mobile ? 16 : 14} />
          </RowIconButton>
        )}
        {mobile && (
          <RowIconButton label={t('Model details')} onClick={onShowDetail} mobile={mobile}>
            <ScalableIcon icon={IconInfoCircle} size={15} />
          </RowIconButton>
        )}
      </Flex>
      <Flex align="center" gap={4} ml="auto" className="flex-shrink-0">
        {locked && <ScalableIcon icon={IconLock} size={mobile ? 16 : 15} className="text-chatbox-tint-tertiary" />}
        {!hideFavorite && (
          <ActionIcon
            aria-label={favorited ? t('Remove from favorites') : t('Add to favorites')}
            variant="transparent"
            size="sm"
            className={
              favorited ? 'text-chatbox-tint-brand' : 'text-chatbox-tint-tertiary hover:text-chatbox-tint-brand'
            }
            onClick={(event) => {
              event.stopPropagation()
              onFavorite()
            }}
          >
            <ScalableIcon icon={favorited ? IconStarFilled : IconStar} size={mobile ? 19 : 17} />
          </ActionIcon>
        )}
      </Flex>
    </div>
  )
}
