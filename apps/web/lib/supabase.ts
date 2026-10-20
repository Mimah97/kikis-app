import { createClient } from '@supabase/supabase-js'

// Read inside the function (not at module scope) so a missing/empty value is
// caught on every call and tests can stub process.env per case. The literal
// `process.env.NEXT_PUBLIC_...` accesses matter: Next.js inlines NEXT_PUBLIC_*
// values into the browser bundle by matching this exact syntax at build time,
// so a dynamic lookup like `process.env[name]` would be undefined in the
// browser even when the variable is set.
function requireSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    return null
  }

  return { url, anonKey }
}

/**
 * Whether the Supabase environment variables are present. UI components use
 * this to render a setup guide instead of crashing when the app is run without
 * a configured `.env.local`.
 */
export function isSupabaseConfigured(): boolean {
  return requireSupabaseConfig() !== null
}

// Browser singleton — safe to call multiple times (same instance returned).
// Returns `null` when Supabase is unconfigured so callers can render a setup
// notice rather than throwing at runtime.
let browserClient: ReturnType<typeof createClient> | null = null

export function getSupabaseBrowserClient(): ReturnType<typeof createClient> | null {
  if (!browserClient) {
    const config = requireSupabaseConfig()
    if (!config) return null
    browserClient = createClient(config.url, config.anonKey)
  }
  return browserClient
}

// Server-side client (plain, no singleton — each call gets a fresh instance).
// Returns `null` when Supabase is unconfigured.
export function getSupabaseServerClient(): ReturnType<typeof createClient> | null {
  const config = requireSupabaseConfig()
  if (!config) return null
  return createClient(config.url, config.anonKey)
}

// ── Realtime helpers ─────────────────────────────────────────────────────────

/**
 * Subscribe to `INSERT` events on `public.tx_log` via Supabase Realtime.
 *
 * Returns an unsubscribe function that removes the channel; callers should
 * invoke it on unmount to avoid leaking WebSocket subscriptions. The channel
 * name is suffixed so multiple components can each hold their own subscription
 * without colliding on the same topic.
 */
export function subscribeToTxLogInserts(
  onInsert: (entry: TxLogEntry) => void,
  channelName = 'tx_log_feed',
): () => void {
  const client = getSupabaseBrowserClient()
  const channel = client
    .channel(channelName)
    .on(
      // @ts-expect-error — supabase-js types the postgres_changes payload loosely
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'tx_log' },
      (payload: { new: TxLogEntry }) => {
        if (payload?.new) onInsert(payload.new)
      },
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}

// ── Database types from Section 8 schema ──────────────────────────────────────

/**
 * Explicit column list for the `public_sessions` view.
 *
 * `cumulative_amount` is cast to text on purpose: the column is NUMERIC(20,7) and
 * PostgREST otherwise hands supabase-js a JSON number. `String()` on any value below
 * 1e-6 yields exponent form ("5e-7"), which `usdcToStroops` rejects. Postgres renders
 * NUMERIC as plain decimal text ("0.0000005"), so selecting it as text keeps the amount
 * in a format the parser accepts.
 */
export const SESSION_COLUMNS =
  'id, channel_id, payee, payer, cumulative_amount::text, status, network, opened_at, updated_at, settlement_tx_hash, open_tx_hash, voucher_count'

/**
 * Session lifecycle status. Mirrors the `sessions_status_check` constraint in
 * `supabase/migrations/007_session_dispute_status.sql`, which adds the MPP
 * dispute and on-chain refund states.
 */
export type SessionStatus =
  | 'open'
  | 'closing'
  | 'closed'
  | 'disputed'
  | 'in-refund-window'
  | 'refundable'
  | 'refunded'

export interface Session {
  id: string
  channel_id: string
  payee: string
  payer: string
  /** Decimal USDC as text, e.g. "0.0000005" — see {@link SESSION_COLUMNS}. */
  cumulative_amount: string
  status: SessionStatus
  network: string
  opened_at: string
  updated_at: string
  settlement_tx_hash: string | null
  open_tx_hash: string | null
  voucher_count: number
}

export interface TxLogEntry {
  id: string
  session_id: string | null
  tx_type: 'x402_settle' | 'mpp_charge' | 'channel_open' | 'channel_close' | 'policy_reject'
  tx_hash: string | null
  amount: number | null
  mode: string | null
  network: string
  provider_url: string | null
  agent_address: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}
