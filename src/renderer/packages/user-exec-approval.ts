/**
 * User exec approval registry.
 * Keyed by toolCallId for exact matching between execute() and the UI.
 *
 * The approval store is the source of truth — the UI should show
 * approve/deny buttons whenever an entry exists here, regardless of
 * the tool-call part's render lifecycle (which can remount during streaming).
 */

import { createStore } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { CommandExplanationResult } from '@/packages/model-calls/command-explanation'
import { getAiAutoApprovalEligibility } from './user-exec-ai-policy'
import { isCommandAutoApprovable } from './user-exec-whitelist'

export interface ExplanationContext {
  userContext: string
  generateExplanation: (
    command: string,
    userContext: string,
    onStreamUpdate?: (text: string) => void,
    signal?: AbortSignal
  ) => Promise<CommandExplanationResult>
}

export interface PendingApproval {
  toolCallId: string
  kind?: 'command' | 'file'
  command: string
  title?: string
  resolve: (approved: boolean) => void
  /** undefined = not requested, null = loading, string = done (or partial during streaming) */
  explanation: string | null | undefined
  /** true if explanation generation failed */
  explanationError: boolean
}

export class UserExecApprovalPausedError extends Error {
  readonly kind = 'command'

  constructor(
    readonly toolCallId: string,
    readonly command: string,
    readonly explanation?: string,
    readonly explanationError?: boolean
  ) {
    super(`User approval required before executing command: ${command}`)
    this.name = 'UserExecApprovalPausedError'
  }
}

export class FileMutationApprovalPausedError extends Error {
  readonly kind = 'file'

  constructor(
    readonly toolCallId: string,
    readonly title: string,
    readonly preview: string
  ) {
    super(`User approval required before mutating file: ${title}`)
    this.name = 'FileMutationApprovalPausedError'
  }
}

interface ApprovalState {
  /** Pending approvals waiting for user action, keyed by toolCallId */
  pending: Map<string, PendingApproval>
}

const approvalStore = createStore<ApprovalState>(() => ({
  pending: new Map(),
}))

/** Stored explanation contexts for retry support */
const explanationCtxCache = new Map<string, ExplanationContext>()

function updateExplanation(toolCallId: string, explanation: string | null | undefined, error: boolean) {
  const { pending } = approvalStore.getState()
  const entry = pending.get(toolCallId)
  if (!entry) return // already resolved, no-op
  const next = new Map(pending)
  next.set(toolCallId, { ...entry, explanation, explanationError: error })
  approvalStore.setState({ pending: next })
}

function runExplanationGeneration(toolCallId: string, command: string, ctx: ExplanationContext) {
  updateExplanation(toolCallId, null, false)
  ctx
    .generateExplanation(command, ctx.userContext, (text) => {
      // Stream update: set partial text, not yet done
      updateExplanation(toolCallId, text, false)
    })
    .then((result) => {
      updateExplanation(toolCallId, result.explanation, false)
    })
    .catch(() => {
      updateExplanation(toolCallId, null, true)
    })
}

/** Retry explanation generation for a pending approval */
export function retryExplanation(toolCallId: string) {
  const entry = approvalStore.getState().pending.get(toolCallId)
  const ctx = explanationCtxCache.get(toolCallId)
  if (!entry || !ctx) return
  runExplanationGeneration(toolCallId, entry.command, ctx)
}

/** Evaluate whether a command can run automatically or must pause for user approval. */
const MAX_PERSISTED_EXPLANATION_LENGTH = 4000

async function generateApprovalAssessment(
  command: string,
  explanationCtx: ExplanationContext | undefined,
  signal?: AbortSignal
): Promise<{ explanation?: string; explanationError?: boolean; safe?: boolean }> {
  if (!explanationCtx) return {}

  try {
    throwIfAborted(signal)
    const result = await explanationCtx.generateExplanation(command, explanationCtx.userContext, undefined, signal)
    throwIfAborted(signal)
    return {
      explanation: result.explanation ? result.explanation.slice(0, MAX_PERSISTED_EXPLANATION_LENGTH) : undefined,
      safe: Boolean(result.explanation) && result.safe,
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return { explanationError: true }
  }
}

export async function requestUserExecApproval(
  toolCallId: string,
  command: string,
  explanationCtx?: ExplanationContext,
  signal?: AbortSignal
): Promise<boolean> {
  // Auto-approve safe read-only commands (no caching needed — idempotent)
  if (isCommandAutoApprovable(command)) {
    return Promise.resolve(true)
  }

  const aiEligibility = getAiAutoApprovalEligibility(command)
  const { explanation, explanationError, safe } = await generateApprovalAssessment(command, explanationCtx, signal)
  if (aiEligibility.eligible && safe) return true

  throw new UserExecApprovalPausedError(toolCallId, command, explanation, explanationError)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function requestFileMutationApproval(toolCallId: string, title: string, preview: string): Promise<boolean> {
  throw new FileMutationApprovalPausedError(toolCallId, title, preview)
}

/** Approve a pending exec */
export function approveUserExec(toolCallId: string) {
  approvalStore.getState().pending.get(toolCallId)?.resolve(true)
}

/** Deny a pending exec */
export function denyUserExec(toolCallId: string) {
  approvalStore.getState().pending.get(toolCallId)?.resolve(false)
}

/** React hook: get the pending approval for a specific tool call */
export function usePendingApproval(toolCallId: string | undefined) {
  return useStoreWithEqualityFn(approvalStore, (s) => (toolCallId ? s.pending.get(toolCallId) : undefined), Object.is)
}

function pendingApprovalArraysEqual(a: PendingApproval[], b: PendingApproval[]) {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index]
      return (
        entry.toolCallId === other.toolCallId &&
        entry.command === other.command &&
        entry.explanation === other.explanation &&
        entry.explanationError === other.explanationError
      )
    })
  )
}

/** React hook: get pending approvals, optionally scoped to specific tool call ids */
export function usePendingApprovals(toolCallIds?: readonly string[]) {
  return useStoreWithEqualityFn(
    approvalStore,
    (s) => {
      if (!toolCallIds || toolCallIds.length === 0) {
        return Array.from(s.pending.values())
      }
      return toolCallIds.flatMap((toolCallId) => {
        const approval = s.pending.get(toolCallId)
        return approval ? [approval] : []
      })
    },
    pendingApprovalArraysEqual
  )
}

/** React hook: whether any approval is pending */
export function useHasPendingApprovals(toolCallIds?: readonly string[]) {
  return useStoreWithEqualityFn(
    approvalStore,
    (s) => {
      if (!toolCallIds || toolCallIds.length === 0) {
        return s.pending.size > 0
      }
      return toolCallIds.some((toolCallId) => s.pending.has(toolCallId))
    },
    Object.is
  )
}

/** Deny all pending approvals (call on generation abort/stop to prevent leaks) */
export function denyAllPendingApprovals() {
  const { pending } = approvalStore.getState()
  if (pending.size === 0) return
  for (const entry of pending.values()) {
    entry.resolve(false)
  }
}

export function resetUserExecApprovalsForTests() {
  approvalStore.setState({ pending: new Map() })
  explanationCtxCache.clear()
}
