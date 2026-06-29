import type { DragEndEvent } from '@dnd-kit/core'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Flex, Text } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import type { SessionMetaRecord } from '@shared/types'
import { IconLoader2 } from '@tabler/icons-react'
import { useRouterState } from '@tanstack/react-router'
import { type CSSProperties, type MutableRefObject, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { useSessionList } from '@/stores/chatStore'
import { reorderSessions } from '@/stores/sessionActions'
import SessionItem from './SessionItem'

export interface Props {
  sessionListViewportRef: MutableRefObject<HTMLDivElement | null>
}

type SessionListItem =
  | { type: 'section'; id: string; label: string }
  | { type: 'session'; id: string; session: SessionMetaRecord }

function SessionListLoadingFooter() {
  return (
    <Flex justify="center" py="xs">
      <IconLoader2 size={16} className="animate-spin" style={{ color: 'var(--mantine-color-dimmed)' }} />
    </Flex>
  )
}

export default function SessionList(props: Props) {
  const { t } = useTranslation()
  const { sessionMetaList: sortedSessions, fetchNextPage, hasNextPage, isFetchingNextPage } = useSessionList()
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const isSmallScreen = useMediaQuery('(max-width: 768px)')
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: 250,
      tolerance: 10,
    },
  })
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10,
    },
  })
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
  const sensors = useSensors(...(isSmallScreen ? [] : [touchSensor]), mouseSensor, keyboardSensor)
  const onDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }
  const onDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)
    if (!event.over) {
      return
    }
    if (!sortedSessions) {
      return
    }
    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    if (activeId !== overId) {
      const oldIndex = sortedSessions.findIndex((s) => s.id === activeId)
      const newIndex = sortedSessions.findIndex((s) => s.id === overId)
      if (oldIndex < 0 || newIndex < 0) {
        return
      }
      await reorderSessions(oldIndex, newIndex)
    }
  }
  const onDragCancel = () => {
    setActiveDragId(null)
  }
  const activeDragSession = useMemo(
    () => sortedSessions?.find((session) => session.id === activeDragId),
    [activeDragId, sortedSessions]
  )
  const sortableSessionIds = useMemo(() => sortedSessions?.map((session) => session.id) ?? [], [sortedSessions])
  const displayItems = useMemo<SessionListItem[]>(() => {
    if (!sortedSessions) {
      return []
    }

    const pinnedSessions = sortedSessions.filter((session) => session.starred)
    const otherSessions = sortedSessions.filter((session) => !session.starred)
    if (pinnedSessions.length === 0) {
      return otherSessions.map((session) => ({ type: 'session', id: session.id, session }))
    }

    return [
      { type: 'section', id: 'section:pinned', label: t('Pinned') },
      ...pinnedSessions.map((session) => ({ type: 'session' as const, id: session.id, session })),
      ...(otherSessions.length > 0
        ? [
            { type: 'section' as const, id: 'section:chats', label: t('Chats') },
            ...otherSessions.map((session) => ({ type: 'session' as const, id: session.id, session })),
          ]
        : []),
    ]
  }, [sortedSessions, t])
  const routerState = useRouterState()
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const virtuosoComponents = useMemo(
    () =>
      hasNextPage
        ? {
            Footer: SessionListLoadingFooter,
          }
        : {},
    [hasNextPage]
  )

  return (
    <DndContext
      modifiers={[restrictToVerticalAxis]}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {sortedSessions && (
        <SortableContext items={sortableSessionIds} strategy={verticalListSortingStrategy}>
          <Virtuoso
            style={{ flex: 1 }}
            data={displayItems}
            computeItemKey={(_index, item) => item.id}
            scrollerRef={(ref) => {
              if (ref instanceof HTMLDivElement) {
                props.sessionListViewportRef.current = ref
              }
            }}
            endReached={onEndReached}
            components={virtuosoComponents}
            itemContent={(_index, item) =>
              item.type === 'section' ? (
                <Text px="md" pt="sm" pb={4} size="xs" fw={600} c="chatbox-tertiary">
                  {item.label}
                </Text>
              ) : (
                <SortableItem id={item.session.id}>
                  <SessionItem
                    selected={routerState.location.pathname === `/session/${item.session.id}`}
                    session={item.session}
                  />
                </SortableItem>
              )
            }
          />
          <DragOverlay>
            {activeDragSession ? (
              <div className="pointer-events-none">
                <SessionItem
                  selected={routerState.location.pathname === `/session/${activeDragSession.id}`}
                  session={activeDragSession}
                />
              </div>
            ) : null}
          </DragOverlay>
        </SortableContext>
      )}
    </DndContext>
  )
}

function SortableItem(props: { id: string; children?: React.ReactNode }) {
  const { id, children } = props
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  )
}
