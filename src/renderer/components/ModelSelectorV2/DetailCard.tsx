import { Badge, Button, Flex, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconBolt, IconSparkles } from '@tabler/icons-react'
import clsx from 'clsx'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import platform from '@/platform'
import { formatNumber } from '@/utils/format'
import { ScalableIcon } from '../common/ScalableIcon'
import { ModelIcon } from '../icons/ModelIcon'
import { CapabilityIconRow } from './CapabilityIconRow'
import { CARD_SURFACE_STYLE, FALLBACK_UPGRADE_URL } from './constants'
import { getCostLabel } from './helpers'
import type { DetailModel } from './types'

function formatPrice(value: number, isCN: boolean) {
  return isCN ? `$${value.toFixed(2)} / 百万 token` : `$${value.toFixed(2)} / 1M token`
}

function formatTokenValue(value: number) {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function formatTokenLimit(value: number | undefined, isCN: boolean) {
  if (!value) return ''
  return formatNumber(value, 0, isCN)
}

function TieredPricingDetails({
  tiers,
  t,
  isCN,
}: {
  tiers: NonNullable<DetailModel['pricing']>['tieredPricing']
  t: (key: string) => string
  isCN: boolean
}) {
  return (
    <Stack gap={8} className="min-w-[260px] p-0.5">
      <Text size="sm" fw={750} c="chatbox-primary" lh={1.1}>
        {t('Tiered pricing')}
      </Text>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-chatbox-tint-tertiary">
            <th className="pb-1.5 pr-3 text-left font-semibold">{t('Condition')}</th>
            <th className="pb-1.5 pr-3 text-left font-semibold">{t('Input')}</th>
            <th className="pb-1.5 text-left font-semibold">{t('Output')}</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier) => {
            const inputLimit = formatTokenLimit(tier.max_input_tokens, isCN)
            const outputLimit = formatTokenLimit(tier.max_output_tokens, isCN)
            const tierKey = `${tier.max_input_tokens}-${tier.max_output_tokens}-${tier.price_input}-${tier.price_output}`
            const conditions: string[] = []
            if (inputLimit) conditions.push(`${t('Input')} ≤ ${inputLimit}`)
            if (outputLimit) conditions.push(`${t('Output')} ≤ ${outputLimit}`)
            const condition = conditions.length > 0 ? conditions.join(' · ') : t('Otherwise')
            return (
              <tr key={tierKey} className="border-0 border-t border-solid border-chatbox-border-primary">
                <td className="py-1.5 pr-3 text-chatbox-tint-secondary whitespace-nowrap">{condition}</td>
                <td className="py-1.5 pr-3 text-chatbox-tint-primary whitespace-nowrap">
                  {formatPrice(tier.price_input, isCN)}
                </td>
                <td className="py-1.5 text-chatbox-tint-primary whitespace-nowrap">
                  {formatPrice(tier.price_output, isCN)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Stack>
  )
}

function TieredPricingTag({
  tiers,
  t,
  isCN,
  mobile,
  expanded,
  onToggle,
}: {
  tiers: NonNullable<DetailModel['pricing']>['tieredPricing']
  t: (key: string) => string
  isCN: boolean
  mobile?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const badge = (
    <Badge
      variant="light"
      size="xs"
      className="cursor-help normal-case border border-solid border-amber-200 bg-amber-100 px-1 py-0.5 text-[10px] font-medium leading-none text-amber-700"
    >
      {t('Tiered pricing')}
    </Badge>
  )

  if (mobile) {
    return (
      <UnstyledButton
        aria-expanded={expanded}
        className="inline-flex cursor-help"
        onClick={(event) => {
          event.stopPropagation()
          onToggle?.()
        }}
      >
        {badge}
      </UnstyledButton>
    )
  }

  return (
    <Tooltip
      label={<TieredPricingDetails tiers={tiers} t={t} isCN={isCN} />}
      withArrow
      multiline
      w={340}
      events={{ hover: true, focus: true, touch: false }}
      openDelay={120}
      position="right"
      offset={8}
      styles={{
        tooltip: {
          background: 'var(--chatbox-background-primary)',
          color: 'var(--chatbox-tint-primary)',
          border: '1px solid var(--chatbox-border-primary)',
          borderRadius: 12,
          boxShadow: '0 18px 48px rgb(0 0 0 / 0.18)',
          padding: 12,
        },
        arrow: {
          background: 'var(--chatbox-background-primary)',
          border: '1px solid var(--chatbox-border-primary)',
        },
      }}
    >
      <span className="inline-flex cursor-help" onClick={(event) => event.stopPropagation()}>
        {badge}
      </span>
    </Tooltip>
  )
}

function PriceMetric({
  label,
  value,
  labelRightSection,
}: {
  label: string
  value: string
  labelRightSection?: React.ReactNode
}) {
  return (
    <Stack gap={3} className="min-w-0">
      <Flex align="center" gap={6} wrap="wrap">
        <Text size="xs" c="chatbox-tertiary" className="uppercase tracking-[0.04em]">
          {label}
        </Text>
        {labelRightSection}
      </Flex>
      <Text size="sm" fw={650} lh={1.16} c="chatbox-primary" className="whitespace-nowrap">
        {value}
      </Text>
    </Stack>
  )
}

function PricingBlock({
  model,
  mobile,
  t,
  isCN,
}: {
  model: DetailModel
  mobile?: boolean
  t: (key: string) => string
  isCN: boolean
}) {
  const [mobileTieredOpen, setMobileTieredOpen] = useState(false)
  const pricing = model.pricing
  if (!pricing || (!pricing.officialInput && !pricing.officialOutput && !pricing.tokensPerComputePoint)) return null

  const hasTieredPricing = pricing.tieredPricing.length > 0
  const tieredPricingTag = hasTieredPricing ? (
    <TieredPricingTag
      tiers={pricing.tieredPricing}
      t={t}
      isCN={isCN}
      mobile={mobile}
      expanded={mobileTieredOpen}
      onToggle={() => setMobileTieredOpen((open) => !open)}
    />
  ) : null

  return (
    <Stack gap={10} className="border-0 border-y border-solid border-chatbox-border-primary py-4">
      <Flex align="center" justify="space-between" gap="xs">
        <Text size="xs" fw={750} c="chatbox-primary" className="uppercase tracking-[0.08em]">
          {t('Pricing')}
        </Text>
      </Flex>
      {pricing.tokensPerComputePoint > 0 && (
        <PriceMetric label={t('Compute point exchange')} value={formatTokenValue(pricing.tokensPerComputePoint)} />
      )}
      {(pricing.officialInput > 0 || pricing.officialOutput > 0) && (
        <Stack gap={5}>
          <Text size="xs" c="chatbox-tertiary" className="uppercase tracking-[0.04em]">
            {t('Official API price')}
          </Text>
          <div className={clsx('grid gap-y-3', mobile ? 'grid-cols-1' : 'grid-cols-2 gap-x-8')}>
            {pricing.officialInput > 0 && (
              <PriceMetric
                label={t('Input')}
                value={formatPrice(pricing.officialInput, isCN)}
                labelRightSection={tieredPricingTag}
              />
            )}
            {pricing.officialOutput > 0 && (
              <PriceMetric label={t('Output')} value={formatPrice(pricing.officialOutput, isCN)} />
            )}
          </div>
        </Stack>
      )}
      {mobile && hasTieredPricing && mobileTieredOpen && (
        <div className="rounded-md border border-solid border-chatbox-border-primary bg-chatbox-background-primary px-3 py-2">
          <TieredPricingDetails tiers={pricing.tieredPricing} t={t} isCN={isCN} />
        </div>
      )}
    </Stack>
  )
}

export function DetailCard({
  model,
  pricingLink,
  upgradeLink,
  onSelect,
  onClose,
  onUpgradeClick,
  mobile,
}: {
  model: DetailModel
  pricingLink?: string
  upgradeLink?: string
  onSelect: () => void
  onClose?: () => void
  onUpgradeClick?: () => void
  mobile?: boolean
}) {
  const { t, i18n } = useTranslation()
  const costLabel = getCostLabel(model.costLevel, t)
  const isCN = i18n.language.toLowerCase().startsWith('zh')
  const showPricing = false
  return (
    <Stack
      gap={mobile ? 'md' : 'md'}
      className={clsx(
        'relative border border-solid text-chatbox-tint-primary',
        mobile ? 'border-0 px-6 pb-6 pt-4' : 'w-[320px] rounded-[20px] p-6'
      )}
      style={mobile ? undefined : CARD_SURFACE_STYLE}
    >
      <Flex align="center" gap="md">
        <ModelIcon providerId={model.providerId} modelId={model.modelId} size={mobile ? 34 : 30} />
        <Text fw={750} size={mobile ? 'xl' : 'lg'} lh={1.16} className="min-w-0 flex-1 break-words">
          {model.name}
        </Text>
      </Flex>
      {model.description && (
        <Text size={mobile ? 'md' : 'sm'} c="chatbox-secondary" className="leading-relaxed">
          {model.description}
        </Text>
      )}
      {costLabel && (
        <UnstyledButton
          className="self-start flex items-center gap-1.5 text-chatbox-tint-warning"
          onClick={() => pricingLink && platform.openLink(pricingLink)}
        >
          <ScalableIcon icon={IconBolt} size={16} />
          <Text span size="sm" fw={600} c="inherit">
            {costLabel}
          </Text>
        </UnstyledButton>
      )}
      {/* Temporarily hide model pricing information. */}
      {showPricing && <PricingBlock model={model} mobile={mobile} t={t} isCN={isCN} />}
      <Stack gap="xs" mt="sm">
        <Text size="xs" fw={750} c="chatbox-primary" className="uppercase tracking-[0.08em]">
          {t('Capabilities')}
        </Text>
        <CapabilityIconRow capabilities={model.capabilities} />
      </Stack>
      {model.locked && (
        <Text size="sm" c="chatbox-tertiary" ta="center" mt={mobile ? 'xs' : 0}>
          {t('Available on Pro and above')}
        </Text>
      )}
      {!model.locked && model.disabledReason && (
        <Text size="sm" c="chatbox-tertiary" ta="center" mt={mobile ? 'xs' : 0}>
          {model.disabledReason}
        </Text>
      )}
      <Flex gap="sm" mt={mobile ? 'md' : 'sm'}>
        {onClose && (
          <Button
            variant="default"
            size={mobile ? 'md' : 'sm'}
            onClick={onClose}
            className="flex-shrink-0"
            styles={{ root: { height: mobile ? 46 : 42, minHeight: mobile ? 46 : 42, minWidth: mobile ? 88 : 76 } }}
          >
            {t('Close')}
          </Button>
        )}
        {(mobile || model.locked || model.disabledReason) && (
          <Button
            fullWidth
            size={mobile ? 'md' : 'sm'}
            leftSection={model.locked ? <ScalableIcon icon={IconSparkles} size={16} /> : undefined}
            disabled={!model.locked && !!model.disabledReason}
            className={model.locked ? 'font-semibold' : undefined}
            style={
              model.locked
                ? {
                    minHeight: mobile ? 46 : 42,
                    border: 0,
                    background: 'linear-gradient(90deg, #f59f00 0%, #f06b2f 52%, #e8592c 100%)',
                    boxShadow: '0 10px 24px rgb(232 89 44 / 0.24)',
                  }
                : model.disabledReason
                  ? {
                      minHeight: mobile ? 46 : 42,
                    }
                  : {
                      minHeight: mobile ? 46 : 42,
                      border: 0,
                      background: 'linear-gradient(105deg, #74c0fc 0%, #228be6 46%, #1864ab 100%)',
                    }
            }
            onClick={() => {
              if (model.locked) {
                onUpgradeClick?.()
                platform.openLink(upgradeLink || FALLBACK_UPGRADE_URL)
              } else if (!model.disabledReason) {
                onSelect()
              }
            }}
          >
            {model.locked ? t('Upgrade to Pro') : t('Use this model')}
          </Button>
        )}
      </Flex>
    </Stack>
  )
}
