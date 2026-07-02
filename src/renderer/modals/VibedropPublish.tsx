import NiceModal, { useModal } from '@ebay/nice-modal-react'
import { ActionIcon, Button, CopyButton, Flex, SegmentedControl, Stack, Text, TextInput, Tooltip } from '@mantine/core'
import { IconCheck, IconCopy, IconExternalLink, IconWorldUpload } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AdaptiveModal } from '@/components/common/AdaptiveModal'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { navigateToSettings } from '@/modals/Settings'
import { issueVibedropKey } from '@/packages/remote'
import {
  clearCachedVibedropKey,
  getCachedVibedropKey,
  getStoredSlug,
  publishToVibedrop,
  setCachedVibedropKey,
  setStoredSlug,
  VIBEDROP_MANAGE_URL,
  VibedropAuthError,
  VibedropEmailRequiredError,
  type VibedropSite,
  VibedropSlugNotOwnedError,
  type VibedropVisibility,
} from '@/packages/vibedrop'
import { useAuthInfoStore } from '@/stores/authInfoStore'

export interface VibedropPublishProps {
  html: string
  // Stable code-block id; used to reuse the published slug on re-publish.
  uniqueId?: string
}

type Stage = 'login_required' | 'form' | 'publishing' | 'email_required' | 'success' | 'error'

const ManageSitesHint = () => (
  <Text size="xs" c="dimmed">
    <Trans
      i18nKey="Manage your published pages at <ManageLink>app.vibedrop.cc</ManageLink> — sign in with your Chatbox email."
      components={{
        ManageLink: (
          <a
            href={VIBEDROP_MANAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-blue-600 transition-colors"
          />
        ),
      }}
    />
  </Text>
)

const VibedropPublish = NiceModal.create(({ html, uniqueId }: VibedropPublishProps) => {
  const isSmallScreen = useIsSmallScreen()
  const modal = useModal()
  const { t } = useTranslation()

  const isLoggedIn = useAuthInfoStore((state) => Boolean(state.accessToken && state.refreshToken))
  const [stage, setStage] = useState<Stage>(isLoggedIn ? 'form' : 'login_required')
  const [visibility, setVisibility] = useState<VibedropVisibility>('unlisted')
  const [url, setUrl] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const getPublishErrorMessage = useCallback(
    (error: unknown): string => {
      const message = (error as Error)?.message
      if (message === 'HTML content is empty, nothing to publish.') {
        return t('HTML content is empty, nothing to publish.')
      }
      if (message === 'VibeDrop authorization failed') {
        return t('VibeDrop authorization failed')
      }
      if (message?.startsWith('Failed to publish to VibeDrop (status ')) {
        return t('Failed to publish to VibeDrop. Please try again later.')
      }
      return message || t('Publish failed') || 'Publish failed'
    },
    [t]
  )

  const onClose = () => {
    modal.resolve()
    modal.hide()
  }

  const goLogin = () => {
    navigateToSettings('/provider/chatbox-ai')
    onClose()
  }

  useEffect(() => {
    if (isLoggedIn && stage === 'login_required') {
      setStage('form')
    }
  }, [isLoggedIn, stage])

  // Obtain a publish key: cached first, otherwise issue one via chatbox-backend.
  const obtainKey = useCallback(async (forceReissue = false): Promise<string> => {
    if (!forceReissue) {
      const cached = getCachedVibedropKey()
      if (cached) return cached
    }
    const { vdKey } = await issueVibedropKey()
    setCachedVibedropKey(vdKey)
    return vdKey
  }, [])

  const publishWithRetry = useCallback(async (): Promise<VibedropSite> => {
    let vdKey = await obtainKey()
    const slug = getStoredSlug(uniqueId)
    try {
      return await publishToVibedrop({ html, vdKey, visibility, slug })
    } catch (e) {
      if (e instanceof VibedropAuthError) {
        // Key revoked/invalid — clear cache, re-issue, retry once.
        clearCachedVibedropKey()
        vdKey = await obtainKey(true)
        return await publishToVibedrop({ html, vdKey, visibility, slug })
      }
      if (e instanceof VibedropSlugNotOwnedError) {
        // Stored slug no longer owned — publish as a fresh site.
        return await publishToVibedrop({ html, vdKey, visibility, slug: null })
      }
      throw e
    }
  }, [html, uniqueId, visibility, obtainKey])

  const publish = useCallback(async () => {
    setStage('publishing')
    try {
      const site = await publishWithRetry()
      setStoredSlug(uniqueId, site.slug)
      setUrl(site.url)
      setStage('success')
    } catch (e) {
      if (e instanceof VibedropEmailRequiredError) {
        setStage('email_required')
        return
      }
      setErrorMessage(getPublishErrorMessage(e))
      setStage('error')
    }
  }, [uniqueId, publishWithRetry, getPublishErrorMessage])

  return (
    <AdaptiveModal opened={modal.visible} onClose={onClose} centered title={t('Publish to VibeDrop')}>
      <Stack>
        {stage === 'login_required' && (
          <>
            <Text size="sm" c="dimmed">
              {t('Sign in to your Chatbox account to publish and manage your pages.')}
            </Text>
            <AdaptiveModal.Actions>
              <Button variant="default" onClick={onClose}>
                {t('Close')}
              </Button>
              <Button onClick={goLogin} c="white">
                {t('Sign in')}
              </Button>
            </AdaptiveModal.Actions>
          </>
        )}

        {(stage === 'form' || stage === 'publishing') && (
          <>
            <Text size="sm" c="dimmed">
              {t('Your HTML page will be published to VibeDrop. Choose who can access it.')}
            </Text>
            <SegmentedControl
              fullWidth
              value={visibility}
              onChange={(v) => setVisibility(v as VibedropVisibility)}
              disabled={stage === 'publishing'}
              data={[
                { label: t('Link only'), value: 'unlisted' },
                { label: t('Public'), value: 'public' },
              ]}
            />
            <Text size="xs" c="dimmed">
              {visibility === 'public'
                ? t('Anyone can find this page in the VibeDrop explore gallery.')
                : t('Only people with the link can open this page.')}
            </Text>
            <ManageSitesHint />
            <AdaptiveModal.Actions>
              <Button variant="default" onClick={onClose} disabled={stage === 'publishing'}>
                {t('Close')}
              </Button>
              <Button
                onClick={publish}
                loading={stage === 'publishing'}
                leftSection={<ScalableIcon icon={IconWorldUpload} size={16} />}
                c="white"
              >
                {t('Publish')}
              </Button>
            </AdaptiveModal.Actions>
          </>
        )}

        {stage === 'email_required' && (
          <>
            <Text size="sm" c="dimmed">
              {t('Publishing requires an email on your Chatbox account. Please add one and try again.')}
            </Text>
            <AdaptiveModal.Actions>
              <Button variant="default" onClick={onClose}>
                {t('Close')}
              </Button>
            </AdaptiveModal.Actions>
          </>
        )}

        {stage === 'error' && (
          <>
            <Text size="sm" c="red">
              {errorMessage}
            </Text>
            <AdaptiveModal.Actions>
              <Button variant="default" onClick={onClose}>
                {t('Close')}
              </Button>
              <Button onClick={() => setStage('form')} c="white">
                {t('Try Again')}
              </Button>
            </AdaptiveModal.Actions>
          </>
        )}

        {stage === 'success' && (
          <>
            <Text size="sm" c="dimmed">
              {t('Your page is published. You can access it via the link below.')}
            </Text>
            <Flex gap="xs" className={isSmallScreen ? 'flex-col' : ''}>
              <TextInput
                value={url}
                readOnly
                className="flex-1"
                rightSection={
                  <CopyButton value={url} timeout={2000}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? t('Copied') : t('Copy')} withArrow position="right">
                        <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                }
              />
              <Button
                component="a"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                leftSection={<ScalableIcon icon={IconExternalLink} size={16} />}
                c="white"
              >
                {t('Open')}
              </Button>
            </Flex>
            <ManageSitesHint />
            {!isSmallScreen && (
              <AdaptiveModal.Actions>
                <Button variant="default" onClick={onClose}>
                  {t('Close')}
                </Button>
              </AdaptiveModal.Actions>
            )}
          </>
        )}
      </Stack>
    </AdaptiveModal>
  )
})

export default VibedropPublish
