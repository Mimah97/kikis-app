import type { Metadata } from 'next'
import { networkLabel } from '@/lib/explorer'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Dashboard',
  description: `Live view of KikisApp payment sessions, transactions, and voucher activity on Stellar ${networkLabel()}.`,
}

import { getSupabaseServerClient, SESSION_COLUMNS } from '@/lib/supabase'
import { DashboardHeader } from '@/components/layout/DashboardHeader'
import { DashboardMetrics } from '@/components/dashboard/DashboardMetrics'
import { SessionTable } from '@/components/dashboard/SessionTable'
import { TxFeed } from '@/components/dashboard/TxFeed'
import { VoucherChart } from '@/components/dashboard/VoucherChart'
import type { DashboardStatsRow } from '@/lib/dashboardMetrics'
import type { Session, TxLogEntry } from '@/lib/supabase'

type DashboardNetwork = 'testnet' | 'mainnet'

function resolveNetwork(value: string | string[] | undefined): DashboardNetwork {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'mainnet' ? 'mainnet' : 'testnet'
}

async function fetchDashboardData(network: DashboardNetwork) {
  const supabase = getSupabaseServerClient()

  const [sessionsRes, txLogRes, statsRes] = await Promise.all([
    supabase
      .from('public_sessions')
      .select(SESSION_COLUMNS)
      .eq('network', network)
      .order('opened_at', { ascending: false })
      .limit(SESSIONS_PAGE_SIZE),
    supabase
      .from('tx_log')
      .select('*')
      .eq('network', network)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('public_dashboard_stats')
      .select('*')
      .eq('network', network)
      .maybeSingle(),
  ])

  if (sessionsRes.error) {
    console.error('[dashboard] failed to load public_sessions:', sessionsRes.error.message)
  }
  if (txLogRes.error) {
    console.error('[dashboard] failed to load tx_log:', txLogRes.error.message)
  }
  if (statsRes.error) {
    console.error('[dashboard] failed to load public_dashboard_stats:', statsRes.error.message)
  }

  const sessions = (sessionsRes.data ?? []) as Session[]
  const txLog = (txLogRes.data ?? []) as TxLogEntry[]
  const stats = (statsRes.data ?? null) as DashboardStatsRow | null

  return {
    sessions,
    txLog,
    stats,
    hasError: Boolean(sessionsRes.error || txLogRes.error || statsRes.error),
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined }
}) {
  const network = resolveNetwork(searchParams?.network)
  const { sessions, txLog, stats, hasError } = await fetchDashboardData(network)

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <DashboardHeader network={network} />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-center gap-2">
          <span
            className={
              network === 'mainnet'
                ? 'inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-400'
                : 'inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-400'
            }
          >
            {network === 'mainnet' ? 'Mainnet' : 'Testnet'}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {network === 'mainnet'
              ? 'Showing real-value mainnet activity'
              : 'Showing testnet activity — no real value'}
          </span>
        </div>

        {hasError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            Some dashboard data could not be loaded from the registry. Figures below may be
            incomplete — check server logs for details.
          </div>
        )}

        {/* Metric cards — server-seeded from the aggregate view, polled client-side */}
        <DashboardMetrics initialStats={stats} />

        {/* Session table + Tx feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <SessionTable
              initialSessions={sessions}
              pageSize={SESSIONS_PAGE_SIZE}
              loadMore={loadMoreSessions}
            />
          </div>
          <div className="lg:col-span-1 min-h-[400px]">
            <TxFeed
              initialEntries={txLog}
              pageSize={TX_LOG_PAGE_SIZE}
              loadMore={loadMoreTxLog}
            />
          </div>
        </div>

        {/* Voucher chart */}
        <VoucherChart />
      </main>
    </div>
  )
}
