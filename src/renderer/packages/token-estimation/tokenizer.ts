/**
 * Moved to shared so the native mobile shell reuses the exact same token
 * estimation logic (js-tiktoken cl100k_base + DeepSeek heuristics).
 */
import * as Sentry from '@sentry/react'
import { setTokenizerErrorReporter } from '@shared/token-estimation/tokenizer'

// Restore the pre-extraction behavior: tokenizer failures are reported to Sentry
// on the renderer. (Shared defaults to a no-op so it can't import Sentry directly.)
setTokenizerErrorReporter((error) => Sentry.captureException(error))

export * from '@shared/token-estimation/tokenizer'
