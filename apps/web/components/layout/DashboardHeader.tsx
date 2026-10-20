'use client'

import { ExternalLink } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { explorerHome, networkLabel } from '@/lib/explorer'

type Network = 'testnet' | 'mainnet'

const NETWORKS: Network[] = ['testnet', 'mainnet']

function resolveNetwork(value: string | null): Network {
  return value === 'mainnet' ? 'mainnet' : 'testnet'
}

export function DashboardHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const network = resolveNetwork(searchParams.get('network'))

  function handleNetworkChange(next: Network) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('network', next)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold text-[var(--text-primary)] tracking-tight">
              Route<span className="text-[var(--accent)]">Dock</span>
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[var(--status-success)]/30 bg-[var(--status-success)]/10 px-2.5 py-0.5 text-xs font-medium text-[var(--status-success)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
              {networkLabel()} Live
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div
              role="group"
              aria-label="Network selector"
              className="inline-flex items-center rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] p-0.5"
            >
              {NETWORKS.map((option) => {
                const active = option === network
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleNetworkChange(option)}
                    className={
                      active
                        ? 'rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-xs font-medium text-[var(--bg-surface)]'
                        : 'rounded-full px-2.5 py-0.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors'
                    }
                  >
                    {option === 'mainnet' ? 'Mainnet' : 'Testnet'}
                  </button>
                )
              })}
            </div>

            <a
              href={explorerHome()}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Stellar Expert
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </header>
  )
}
