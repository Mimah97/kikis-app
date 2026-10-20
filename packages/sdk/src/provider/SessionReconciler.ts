/**
 * Session Reconciler — Recovery mechanism for orphaned MPP sessions
 *
 * Scans Supabase for sessions marked as "closing" (client initiated close but
 * provider crashed before broadcasting settlement). Recovers abandoned funds by
 * broadcasting the channel close transaction with the latest signed commitment.
 *
 * Idempotent: Safe to run multiple times on the same session (settlement_tx_hash
 * acts as deduplication key).
 */

import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { usdcToStroops } from '../internal/usdc.js'
import { channelAuthorizer, formatMppError } from './mppCompatibility.js'
import { resolveLogger, type KikisAppLogger } from '../internal/logger.js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

type ChannelCloseFn = (args: {
  channel: string
  amount: bigint
  signature: Buffer
  feePayer: { envelopeSigner: Keypair }
  network: 'stellar:testnet' | 'stellar:pubnet'
}) => Promise<string>

/** On-chain channel state probe — structurally compatible with the
 * `getChannelState` export of @stellar/mpp/channel/server. */
type ChannelStateFn = (args: {
  channel: string
  network: 'stellar:testnet' | 'stellar:pubnet'
  sourceAccount: string
}) => Promise<{ closeEffectiveAtLedger: number | null }>

export interface SessionReconcilerOptions {
  supabase: SupabaseClient
  network: Network
  payeeSecretKey: string
  onRecovered?: (channelId: string, txHash: string, totalPaid: string) => Promise<void>
  /** Injectable for testing. Defaults to @stellar/mpp/channel/server close() */
  channelClose?: ChannelCloseFn
  /**
   * On-chain channel state probe used to confirm that a close() rejection
   * really means the channel is already settled before the session is
   * transitioned out of `closing`. Injectable for testing; defaults to
   * getChannelState() from @stellar/mpp/channel/server (#53).
   */
  channelState?: ChannelStateFn
  /** In-loop diagnostic sink. Defaults to the console-backed logger. */
  logger?: KikisAppLogger
}

export interface ReconciliationStats {
  orphanedCount: number
  recoveredCount: number
  skippedCount: number
  failedCount: number
  /**
   * Sessions whose close failed because the channel was already settled or is
   * gone on-chain (e.g. an earlier cycle closed it but the Supabase update
   * failed). They are transitioned to `closed` instead of being retried — and
   * counted as failures — on every subsequent cycle (#53).
   */
  alreadyClosedCount: number
  errors: Array<{ channelId: string; reason: string }>
}

export function decimalToStroops(amountStr: string): bigint {
  return usdcToStroops(amountStr)
}

/** Why close() can never make progress for this session again. */
type TerminalCloseKind = 'already-settled' | 'channel-not-found'

/**
 * Errors meaning the channel (or its contract) is already settled/closed —
 * grounded in the strings @stellar/mpp and mppx actually raise, plus the
 * contract-level precondition/sequence failures Soroban surfaces on a second
 * close attempt. `ChannelClosedError`/`ChannelNotFoundError` class names are
 * matched too (contiguous camelCase segments).
 */
const ALREADY_SETTLED_PATTERNS: RegExp[] = [
  /already[\s_-]*(?:been[\s_-]*)?(?:closed|settled|finalized)/i,
  /channel[\s_-]*closed/i,
  /close[\s_-]*(?:has[\s_-]*been)?[\s_-]*(?:already[\s_-]*)?(?:settled|completed)/i,
  /sendTransaction returned DUPLICATE/i,
  /tx[_-]?bad[_-]?seq/i,
  /sequence[\s_-]*number[\s_-]*(?:has[\s_-]*already[\s_-]*been[\s_-]*used|is[\s_-]*already)/i,
]

/** Errors meaning the channel contract itself can never be closed again. */
const CHANNEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /channel[\s_-]*not[\s_-]*found/i,
  /no[\s_-]*channel/i,
  /(?:channel|contract)[\s_-]*(?:does[\s_-]*not|doesn't)[\s_-]*exist/i,
  /contract[\s_-]*not[\s_-]*found/i,
]

/**
 * Classify a close() rejection. Returns null for ordinary failures (RPC
 * outages, fee problems, verification errors) that must keep counting as
 * failed and be retried on the next cycle.
 */
function classifyTerminalCloseError(err: unknown): TerminalCloseKind | null {
  const parts: string[] = [formatMppError(err)]
  if (err !== null && typeof err === 'object') {
    const { code, name } = err as { code?: unknown; name?: unknown }
    if (typeof code === 'string') parts.push(code)
    if (typeof name === 'string') parts.push(name)
  }
  const text = parts.join(' ')
  if (CHANNEL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'channel-not-found'
  }
  if (ALREADY_SETTLED_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'already-settled'
  }
  return null
}

/**
 * Scan for abandoned sessions and attempt recovery.
 * Idempotent: sessions with settlement_tx_hash are skipped (already recovered).
 */
export async function reconcileAbandonedSessions(
  opts: SessionReconcilerOptions,
): Promise<ReconciliationStats> {
  const stats: ReconciliationStats = {
    orphanedCount: 0,
    recoveredCount: 0,
    skippedCount: 0,
    failedCount: 0,
    alreadyClosedCount: 0,
    errors: [],
  }

  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const networkId = MPP_NETWORK[opts.network]
  const logger = resolveLogger(opts.logger)

  /**
   * A close rejection that can never make progress again (#53): confirm the
   * on-chain state, then transition the Supabase row out of `closing` so the
   * next cycle does not repeat — and re-fail — the same close forever.
   */
  async function resolveTerminalClose(
    sessionChannelId: string,
    channelId: string,
    kind: TerminalCloseKind,
    cause: unknown,
  ): Promise<boolean> {
    if (kind === 'already-settled') {
      // Only trust the error once the chain agrees: closeEffectiveAtLedger is
      // set by close_start (dispute) or a settled close, so a channel without
      // it may be an ambiguous rejection worth retrying next cycle.
      let confirmed = false
      try {
        const probe =
          opts.channelState ??
          (await import('@stellar/mpp/channel/server')).getChannelState
        const state = await probe({
          channel: channelId,
          network: networkId,
          sourceAccount: payeeKeypair.publicKey(),
        })
        confirmed = state.closeEffectiveAtLedger !== null
      } catch (probeErr) {
        logger('warn', '[SessionReconciler] on-chain confirmation failed; will retry next cycle', {
          channelId,
          error: probeErr,
        })
      }
      if (!confirmed) return false
    }
    // 'channel-not-found': the contract itself is gone — there is nothing to
    // query or settle against, so the terminal error alone is conclusive.

    const { error: updateError } = await opts.supabase
      .from('sessions')
      .update({
        status: 'closed',
        updated_at: new Date().toISOString(),
      })
      .eq('channel_id', sessionChannelId)

    if (updateError) {
      logger(
        'error',
        '[SessionReconciler] channel already closed on-chain but the Supabase update failed',
        { channelId, error: updateError.message },
      )
      return false
    }

    stats.alreadyClosedCount++
    logger(
      'info',
      kind === 'already-settled'
        ? `[SessionReconciler] channel ${channelId} already settled on-chain — marked session closed`
        : `[SessionReconciler] channel contract ${channelId} not found on-chain — marked session closed`,
      { channelId, reason: formatMppError(cause) },
    )
    return true
  }

  try {
    // Query for sessions in "closing" state with no settlement_tx_hash
    const { data: closingSessions, error } = await opts.supabase
      .from('sessions')
      .select('channel_id, channel_contract, cumulative_amount, last_signature, settlement_tx_hash')
      .eq('status', 'closing')
      .eq('network', opts.network)
      .eq('payee', paye

/* … truncated 4356 chars — edit only what you need near the top … */
