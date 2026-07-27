import NiceModal, { useModal } from '@ebay/nice-modal-react'
import { Button, Stack, Text, ThemeIcon } from '@mantine/core'
import { IconGift } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { AdaptiveModal } from '@/components/common/AdaptiveModal'
import { useLanguage } from '@/stores/settingsStore'

export interface AgentModeRewardClaimSuccessProps {
  tokenLimit: number
  expiresAt: string
}

export function formatRewardClaimDetails({
  tokenLimit,
  expiresAt,
  language,
}: AgentModeRewardClaimSuccessProps & { language: string }) {
  const points = new Intl.NumberFormat(language).format(tokenLimit)
  const expiresAtDate = new Date(expiresAt)
  const expiry = Number.isNaN(expiresAtDate.getTime())
    ? expiresAt
    : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(expiresAtDate)
  return { points, expiry }
}

const AgentModeRewardClaimSuccess = NiceModal.create(({ tokenLimit, expiresAt }: AgentModeRewardClaimSuccessProps) => {
  const modal = useModal()
  const { t } = useTranslation()
  const language = useLanguage()
  const { points, expiry } = formatRewardClaimDetails({ tokenLimit, expiresAt, language })

  const close = () => {
    modal.resolve()
    modal.hide()
  }

  return (
    <AdaptiveModal opened={modal.visible} onClose={close} centered title={t('Reward claimed successfully')}>
      <Stack align="center" gap="sm">
        <ThemeIcon size={56} radius="50%" variant="light" color="chatbox-success">
          <IconGift size={28} stroke={1.8} />
        </ThemeIcon>
        <Text size="sm" c="chatbox-secondary" ta="center">
          {t('You received {{points}} reward points, valid until {{expiry}}.', { points, expiry })}
        </Text>
      </Stack>

      <AdaptiveModal.Actions>
        <Button onClick={close}>{t('Confirm')}</Button>
      </AdaptiveModal.Actions>
    </AdaptiveModal>
  )
})

export default AgentModeRewardClaimSuccess
