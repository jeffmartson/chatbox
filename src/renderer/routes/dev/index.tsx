import { Badge, Box, Button, Card, Container, Group, Paper, Stack, Switch, Text, Title, Tooltip } from '@mantine/core'
import { IconAdjustmentsHorizontal, IconCode, IconExternalLink, IconEye } from '@tabler/icons-react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { getShowGuideDevButtonsFlag, setShowGuideDevButtonsFlag } from '@/dev/devToolsFlags'

export const Route = createFileRoute('/dev/')({
  component: DevIndexPage,
})

const devPages = [
  {
    path: '/dev/storage',
    name: 'Storage Explorer',
    description: 'Inspect key-value and blob storage entries provided by the unified platform layer',
    tags: ['Tool', 'Storage'],
  },
  {
    path: '/dev/css-var',
    name: 'CSS Variables Preview',
    description: 'CSS Variables Preview',
    tags: ['UI'],
  },
  {
    path: '/dev/context-generator',
    name: 'Context Generator',
    description: 'Generate fake conversation context for testing context management and token estimation',
    tags: ['Tool', 'Testing'],
  },
  {
    path: '/dev/session-rag',
    name: 'Session RAG Inspector',
    description: 'Inspect local libsql state for session attachment RAG',
    tags: ['Tool', 'RAG'],
  },
  {
    path: '/dev/ui-inventory',
    name: 'UI Inventory',
    description: 'Complete generated catalog of UI pages, components, states, text, and preview links',
    tags: ['Tool', 'UI'],
  },
]

interface DevControl {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function DevIndexPage() {
  const [showGuideDevButtons, setShowGuideDevButtons] = useState(getShowGuideDevButtonsFlag)
  const devControls: DevControl[] = [
    {
      id: 'guide-dev-buttons',
      label: 'Guide dev buttons',
      description: 'Show guide debug actions on the Getting Started page.',
      checked: showGuideDevButtons,
      onChange: (checked) => {
        setShowGuideDevButtonsFlag(checked)
        setShowGuideDevButtons(checked)
      },
    },
  ]

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        {/* Header */}
        <div>
          <Group justify="space-between" align="flex-start" gap="md" mb="md">
            <div>
              <Title order={1}>Dev Tools</Title>
            </div>
            <Stack align="flex-end" gap="xs">
              <Badge size="lg" variant="light" color="blue">
                Development Mode
              </Badge>
              <DevControlsStrip controls={devControls} />
            </Stack>
          </Group>
          <Text c="dimmed">
            Component previews and development tools. These are available when running in development mode or when the
            dev tools override is enabled.
          </Text>
        </div>

        {/* Available Pages */}
        <Paper shadow="xs" p="lg" radius="md">
          <Title order={3} mb="md">
            <Group gap="xs">
              <ScalableIcon icon={IconEye} size={20} />
              <span>Component Previews</span>
            </Group>
          </Title>

          <Stack gap="md">
            {devPages.map((page) => (
              <Card key={page.path} shadow="xs" p="md" radius="md" withBorder>
                <Group justify="space-between" align="start">
                  <div style={{ flex: 1 }}>
                    <Group gap="xs" mb="xs">
                      <Text fw={600}>{page.name}</Text>
                      {page.tags.map((tag) => (
                        <Badge key={tag} size="sm" variant="light">
                          {tag}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="sm" c="dimmed">
                      {page.description}
                    </Text>
                  </div>
                  <Button
                    component={Link}
                    to={page.path}
                    variant="light"
                    size="sm"
                    rightSection={<ScalableIcon icon={IconExternalLink} />}
                  >
                    Open Preview
                  </Button>
                </Group>
              </Card>
            ))}

            {devPages.length === 0 && (
              <Text c="dimmed" ta="center" py="xl">
                No component previews available yet
              </Text>
            )}
          </Stack>
        </Paper>

        {/* Instructions */}
        <Paper shadow="xs" p="lg" radius="md" className="bg-blue-50 dark:bg-blue-950/20">
          <Title order={4} mb="md">
            <Group gap="xs">
              <ScalableIcon icon={IconCode} size={18} />
              <span>How to Add New Previews</span>
            </Group>
          </Title>
          <Stack gap="xs">
            <Text size="sm">
              1. Create a preview component in <code>/src/renderer/components/[ComponentName]/Preview.tsx</code>
            </Text>
            <Text size="sm">
              2. Create a route file in <code>/src/renderer/routes/dev/[component-name].tsx</code>
            </Text>
            <Text size="sm">
              3. Add the page info to the <code>devPages</code> array in this file
            </Text>
            <Text size="sm">4. The preview will automatically appear in this list</Text>
          </Stack>
        </Paper>

        {/* Note */}
        <Paper shadow="xs" p="md" radius="md" className="bg-yellow-50 dark:bg-yellow-950/20">
          <Group gap="xs">
            <Text size="sm" fw={500}>
              ⚠️ Note:
            </Text>
            <Text size="sm">
              These dev tools are hidden in production builds unless <code>FORCE_ENABLE_DEV_PAGES</code> in{' '}
              <code>src/renderer/dev/devToolsConfig.ts</code> is set to <code>true</code>.
            </Text>
          </Group>
        </Paper>
      </Stack>
    </Container>
  )
}

function DevControlsStrip({ controls }: { controls: DevControl[] }) {
  if (controls.length === 0) return null

  return (
    <Box className="border border-solid border-[var(--chatbox-border-primary)] rounded-md bg-[var(--chatbox-background-secondary)] px-2 py-1">
      <Group gap="sm" wrap="wrap">
        <Group gap={4}>
          <ScalableIcon icon={IconAdjustmentsHorizontal} size={14} className="text-chatbox-tint-tertiary" />
          <Text size="xs" fw={700} c="chatbox-tertiary" tt="uppercase" lh={1}>
            Controls
          </Text>
        </Group>
        {controls.map((control) => (
          <Tooltip key={control.id} label={control.description} withArrow openDelay={400}>
            <Switch
              size="xs"
              label={control.label}
              checked={control.checked}
              onChange={(event) => control.onChange(event.currentTarget.checked)}
            />
          </Tooltip>
        ))}
      </Group>
    </Box>
  )
}

export default DevIndexPage
