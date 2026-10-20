/**
 * KikisApp Session Recovery CLI
 *
 * Manual recovery tool for abandoned MPP sessions.
 * Scans Supabase for sessions marked as "closing" and attempts to broadcast
 * channel close transactions with the latest signed commitments.
 *
 * Usage:
 *   npx ts-node src/recover-sessions.ts
 *
 * Environment Variables:
 *   SUPABASE_URL          Supabase project URL
 *   SUPABASE_SERVICE_KEY  Supabase service role key (for admin access)
 *   STELLAR_NETWORK       Network (testnet or mainnet, default: testnet)
 *   STELLAR_PAYEE_SECRET  Payee secret key for signing settlement txs
 */

import { createClient } from '@supabase/supabase-js'
import { reconcileAbandonedSessions } from '@kikis-app/kikis-app/provider'

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''
const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const STELLAR_PAYEE_SECRET = process.env['STELLAR_PAYEE_SECRET'] ?? ''

/**
 * Minimal shape of an active MPP session handle that can be settled on shutdown.
 * Matches the `SessionHandle` returned by `client.openSession()`.
 */
export interface ActiveSession {
  channelId: string
  close: () => Promise<unknown>
}

/** Timeout applied to each best-effort session close during shutdown. */
const SESSION_CLOSE_TIMEOUT_MS = 5_000

/**
 * Registry of active sessions opened by the agent runner. Sessions are added
 * when opened and removed once closed so shutdown only touches live channels.
 */
const activeSessions = new Map<string, ActiveSession>()

/** Register a session so it can be settled on process shutdown. */
export function trackSession(session: ActiveSession): void {
  activeSessions.set(session.channelId, session)
}

/** Remove a session from the registry (e.g. after a normal close). */
export function untrackSession(channelId: string): void {
  activeSessions.delete(channelId)
}

/**
 * Best-effort settlement of all active sessions. Each close is bounded by a
 * 5-second timeout so a hung channel cannot block process termination.
 * Returns the number of sessions that were closed successfully.
 */
export async function closeAllSessions(): Promise<number> {
  const sessions = Array.from(activeSessions.values())
  if (sessions.length === 0) {
    return 0
  }

  console.log(`[SessionCleanup] Closing ${sessions.length} active session(s)...`)

  let closed = 0
  await Promise.all(
    sessions.map(async (session) => {
      try {
        await Promise.race([
          session.close(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('close timed out')),
              SESSION_CLOSE_TIMEOUT_MS,
            ),
          ),
        ])
        activeSessions.delete(session.channelId)
        closed += 1
        console.log(`[SessionCleanup] Closed channel ${session.channelId}`)
      } catch (err) {
        console.error(
          `[SessionCleanup] Failed to close channel ${session.channelId}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }),
  )

  console.log(
    `[SessionCleanup] Recovered collateral from ${closed}/${sessions.length} session(s)`,
  )
  return closed
}

let shutdownInProgress = false

/**
 * Graceful shutdown: settle all active sessions, then exit. Guarded so that
 * overlapping signals or an uncaught exception do not trigger double-close.
 */
async function gracefulShutdown(reason: string, exitCode: number): Promise<void> {
  if (shutdownInProgress) {
    return
  }
  shutdownInProgress = true

  console.log(`[SessionCleanup] Received ${reason}, settling active sessions...`)
  try {
    await closeAllSessions()
  } catch (err) {
    console.error('[SessionCleanup] Unexpected error during cleanup:', err)
  }
  process.exit(exitCode)
}

/**
 * Install process exit handlers so open channels are settled before the agent
 * terminates. Safe to call multiple times; handlers are registered once.
 */
export function registerShutdownHandlers(): void {
  process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT', 0)
  })
  process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM', 0)
  })
  process.once('uncaughtException', (err) => {
    console.error('[SessionCleanup] Uncaught exception:', err)
    void gracefulShutdown('uncaughtException', 1)
  })
}

async function main(): Promise<void> {
  // Validation
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(
      'FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.\n' +
      'Set these environment variables to enable session recovery.',
    )
    process.exit(1)
  }

  if (!STELLAR_PAYEE_SECRET || !STELLAR_PAYEE_SECRET.startsWith('S')) {
    console.error(
      'FATAL: STELLAR_PAYEE_SECRET is required and must be a valid Stellar secret key (S...).',
    )
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  console.log('[SessionRecovery] KikisApp Session Recovery Tool')
  console.log(`[SessionRecovery] Network: ${STELLAR_NETWORK}`)
  console.log(`[SessionRecovery] Supabase: ${SUPABASE_URL}`)
  console.log()

  try {
    const stats = await reconcileAbandonedSessions({
      supabase,
      network: STELLAR_NETWORK,
      payeeSecretKey: STELLAR_PAYEE_SECRET,
      onRecovered: async (channelId: string, txHash: string, totalPaid: string) => {
        console.log(`[SessionRecovery] Recovered: ${channelId}`)
        console.log(`  → Settled ${totalPaid} USDC`)
        console.log(`  → TxHash: ${txHash}`)
      },
    })

    console.log()
    console.log('[SessionRecovery] Recovery Summary:')
    console.log(`  Orphaned sessions found: ${stats.orphanedCount}`)
    console.log(`  Successfully recovered: ${stats.recoveredCount}`)
    console.log(`  Skipped (incomplete data): ${stats.skippedCount}`)
    console.log(`  Failed: ${stats.failedCount}`)

    if (stats.errors.length > 0) {
      console.log()
      console.log('[SessionRecovery] Errors:')
      for (const err of stats.errors) {
        console.log(`  - ${err.channelId}: ${err.reason}`)
      }
    }

    console.log()
    if (stats.recoveredCount > 0) {
      console.log('[SessionRecovery] ✓ Session recovery completed successfully')
      process.exit(0)
    } else if (stats.failedCount > 0) {
      console.log('[SessionRecovery] ✗ Session recovery completed with errors')
      process.exit(1)
    } else {
      console.log('[SessionRecovery] ✓ No orphaned sessions found')
      process.exit(0)
    }
  } catch (err) {
    console.error('[SessionRecovery] Fatal error:', err)
    process.exit(1)
  }
}

main()
