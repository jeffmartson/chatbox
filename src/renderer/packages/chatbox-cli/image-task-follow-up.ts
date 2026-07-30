import type { ImageGeneration } from '@shared/types'
import { resumeGeneration } from '@/stores/imageGenerationActions'
import { queueBackgroundTaskNotification } from './background-follow-up'

interface ImageTaskFollowUpTarget {
  sessionId: string
  toolCallId: string
}

function getFollowUpTarget(
  record: ImageGeneration,
  fallback?: ImageTaskFollowUpTarget
): ImageTaskFollowUpTarget | undefined {
  if (record.source?.type === 'chatbox_cli') {
    return {
      sessionId: record.source.sessionId,
      toolCallId: record.source.toolCallId,
    }
  }
  return fallback
}

export function queueImageTaskCompletion(
  record: ImageGeneration,
  fallbackTarget?: ImageTaskFollowUpTarget,
  startedAt = record.createdAt
): void {
  if (record.status !== 'done' && record.status !== 'error') return
  const target = getFollowUpTarget(record, fallbackTarget)
  if (!target) return

  const finishedAt = Date.now()
  queueBackgroundTaskNotification(target.sessionId, target.toolCallId, {
    id: `image-generation:${record.id}:${record.status}`,
    type: 'image_generation',
    status: record.status === 'done' ? 'completed' : 'failed',
    recordId: record.id,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    summary:
      record.status === 'done'
        ? `${record.generatedImages.length} image(s) generated. Use "chatbox image status ${record.id}" to inspect the result references.`
        : `Image generation failed: ${record.error?.slice(0, 500) ?? 'Unknown error'}`,
  })
}

export function queueImageTaskCompletionError(
  recordId: string,
  startedAt: number,
  target: ImageTaskFollowUpTarget,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error)
  const finishedAt = Date.now()
  queueBackgroundTaskNotification(target.sessionId, target.toolCallId, {
    id: `image-generation:${recordId}:completion-error`,
    type: 'image_generation',
    status: 'failed',
    recordId,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    summary: `Unable to read image generation result: ${message.slice(0, 500)}`,
  })
}

export async function resumeImageGenerationWithFollowUp(
  recordId: string,
  fallbackTarget?: ImageTaskFollowUpTarget
): Promise<ImageGeneration | null> {
  const record = await resumeGeneration(recordId)
  if (record) {
    queueImageTaskCompletion(record, fallbackTarget)
  }
  return record
}
