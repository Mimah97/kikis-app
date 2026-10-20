import { usdcToStroops, USDC_DECIMALS } from '@kikis-app/nulth-sdk'

/**
 * Row shape of the per-network `public_dashboard_stats` view (migration 008).
 * Each row is keyed by `network` so testnet and mainnet totals stay isolated.
 * `total_settled` is text so the exact 7-decimal sum survives the wire format.
 */
export interface DashboardStatsRow {
  network: string
  active_sessions: number | null
  open_vouchers: number | null
  total_settled: string | number | null
  last_settlement_tx_hash: string | null
  last_settlement_at: string | null
}

export interface DashboardMetrics {
  activeSessions: number
  totalVouchers: number
  totalSettled: number
  lastSettlement: { settlement_tx_hash: string; updated_at: string } | undefined
}

/**
 * Pure mapper from a `public_dashboard_stats` row to the metric-card values.
 *
 * The aggregates come from the database, so the cards no longer depend on the
 * 50 most recently opened sessions the page fetches for the table. A missing
 * row or null fields map to zeros and no last settlement. `total_settled` is
 * parsed with `usdcToStroops` — never floated — so a 7-decimal total stays
 * exact.
 */
export function toDashboardMetrics(row: DashboardStatsRow | null | undefined): DashboardMetrics {
  const totalSettledStroops = usdcToStroops(String(row?.total_settled ?? '0'))

  return {
    activeSessions: Number(row?.active_sessions ?? 0),
    totalVouchers: Number(row?.open_vouchers ?? 0),
    totalSettled: Number(totalSettledStroops) / 10 ** USDC_DECIMALS,
    lastSettlement:
      row?.last_settlement_tx_hash && row.last_settlement_at
        ? {
            settlement_tx_hash: row.last_settlement_tx_hash,
            updated_at: row.last_settlement_at,
          }
        : undefined,
  }
}

/**
 * Builds the Supabase query for the active network's stats row.
 *
 * The view now exposes one row per `network`, so the dashboard must filter by
 * the active network environment — otherwise testnet dummy USDC would leak
 * into mainnet reporting. Returns the query builder so callers can await it.
 */
export function dashboardStatsQuery(
  client: { from: (table: string) => any },
  activeNetwork: string,
) {
  return client.from('public_dashboard_stats').select('*').eq('network', activeNetwork).maybeSingle()
}
