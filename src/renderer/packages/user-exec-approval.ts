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
import { settingsStore } from '@/stores/settingsStore'
import { isCommandAutoApprovable } from './user-exec-whitelist'

export interface ExplanationContext {
  userContext: string
  generateExplanation: (command: string, userContext: string, onStreamUpdate: (text: string) => void) => Promise<string>
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
    .then((text) => {
      updateExplanation(toolCallId, text, false)
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

/**
 * Request user approval for a command. Idempotent per toolCallId:
 * if an entry already exists (e.g. execute() called twice for the
 * same tool call), the existing promise is returned.
 */
const promiseCache = new Map<string, Promise<boolean>>()
const MAX_PERSISTED_EXPLANATION_LENGTH = 4000

async function generateApprovalExplanation(
  command: string,
  explanationCtx: ExplanationContext | undefined
): Promise<{ explanation?: string; explanationError?: boolean }> {
  const showExplanation = settingsStore.getState().getSettings().showCommandExplanation
  if (!showExplanation || !explanationCtx) {
    return {}
  }

  try {
    let latestText = ''
    const explanation = await explanationCtx.generateExplanation(command, explanationCtx.userContext, (text) => {
      latestText = text
    })
    const text = explanation || latestText
    return text ? { explanation: text.slice(0, MAX_PERSISTED_EXPLANATION_LENGTH) } : {}
  } catch {
    return { explanationError: true }
  }
}

export async function requestUserExecApproval(
  toolCallId: string,
  command: string,
  explanationCtx?: ExplanationContext
): Promise<boolean> {
  // Idempotent: return existing promise if already requested
  const existing = promiseCache.get(toolCallId)
  if (existing) return existing

  // Auto-approve safe read-only commands (no caching needed — idempotent)
  if (isCommandAutoApprovable(command)) {
    return Promise.resolve(true)
  }

  const { explanation, explanationError } = await generateApprovalExplanation(command, explanationCtx)
  throw new UserExecApprovalPausedError(toolCallId, command, explanation, explanationError)
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
  promiseCache.clear()
  explanationCtxCache.clear()
}
