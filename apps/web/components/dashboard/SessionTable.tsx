'use client';

const PAGE_SIZE = 50

interface SessionTableProps {
  initialSessions?: Session[]
}

export function SessionTable({ initialSessions = [] }: SessionTableProps) {
  const [sessions, setSessions] = useState<Session[]>(initialSessions)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(initialSessions.length >= PAGE_SIZE)

  const refreshSessions = useCallback(async () => {
    const supabase = getSupabaseBrowserClient()
    const { data, error } = await supabase
      .from('public_sessions')
      .select(SESSION_COLUMNS)
      .order('opened_at', { ascending: false })
      .limit(PAGE_SIZE)

    if (error) {
      // Keep the rows already on screen instead of blanking the table.
      console.warn('[sessions] failed to refresh public_sessions:', error.message)
      setRefreshFailed(true)
      return
    }
    setRefreshFailed(false)
    if (data) {
      setSessions(data as Session[])
      setHasMore(data.length >= PAGE_SIZE)
    }
  }, [])

  const loadMore = useCallback(async () => {
    const cursor = sessions[sessions.length - 1]?.opened_at
    if (!cursor || loadingMore) return

    setLoadingMore(true)
    const supabase = getSupabaseBrowserClient()
    const { data, error } = await supabase
      .from('public_sessions')
      .select(SESSION_COLUMNS)
      .lt('opened_at', cursor)
      .order('opened_at', { ascending: false })
      .limit(PAGE_SIZE)

    if (error) {
      console.warn('[sessions] failed to load more public_sessions:', error.message)
      setRefreshFailed(true)
      setLoadingMore(false)
      return
    }

    const batch = (data ?? []) as Session[]
    setSessions((prev) => {
      const seen = new Set(prev.map((s) => s.id))
      return [...prev, ...batch.filter((s) => !seen.has(s.id))]
    })
    setHasMore(batch.length >= PAGE_SIZE)
    setLoadingMore(false)
  }, [sessions, loadingMore])

  useEffect(() => {
    if (!configured) return;

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      const { data, error: fetchError } = await supabase
        .from('sessions')
        .select('id, agent_id, status, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(50);

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
      } else {
        setSessions((data ?? []) as SessionRow[]);
      }
      setLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [configured]);

  if (!configured) {
    return <SetupNotice />;
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading sessions…</p>;
  }

  if (error) {
    return <p className="text-sm text-red-500">Failed to load sessions: {error}</p>;
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No sessions recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Session</th>
            <th className="py-2 pr-4 font-medium">Agent</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="border-b border-border/50">
              <td className="py-2 pr-4 font-mono text-xs">{session.id.slice(0, 8)}</td>
              <td className="py-2 pr-4 font-mono text-xs">
                {session.agent_id ? session.agent_id.slice(0, 8) : '—'}
              </td>
              <td className="py-2 pr-4">{session.status}</td>
              <td className="py-2 text-muted-foreground">
                {new Date(session.created_at).toLocaleString()}
              </td>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-default)]">
            {sessions.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-sm text-[var(--text-muted)]"
                >
                  No sessions yet.
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr
                  key={session.id}
                  className="hover:bg-[var(--bg-subtle)] transition-colors"
                >
                  <td className="px-4 py-3">
                    <AddressDisplay address={session.channel_id} network={session.network} accessibleLabel="channel" />
                  </td>
                  <td className="px-4 py-3">
                    <AddressDisplay address={session.payer} network={session.network} accessibleLabel="payer" />
                  </td>
                  <td className="px-4 py-3">
                    <ModeBadge mode="mpp-session" />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-[var(--text-primary)]">
                    {session.voucher_count}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={cn(
                        'number-lg text-[var(--text-primary)]',
                        session.status === 'open' && 'text-[var(--status-success)]',
                      )}
                    >
                      {Number(session.cumulative_amount).toFixed(7)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      {session.status === 'open' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
                      )}
                      <Badge variant={STATUS_VARIANT[session.status]}>
                        {session.status}
                      </Badge>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {session.settlement_tx_hash ? (
                      <TxHashLink
                        hash={session.settlement_tx_hash}
                        network={session.network}
                      />
                    ) : (
                      <span className="text-xs text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[var(--text-muted)]">
                    <RelativeTime date={session.opened_at} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {sessions.length > 0 && (
        <div className="flex items-center justify-center border-t border-[var(--border-default)] px-5 py-3">
          {hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="rounded-lg border border-[var(--border-default)] px-4 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-subtle)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? 'Loading…' : 'Load More'}
            </button>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">End of list</span>
          )}
        </div>
      )}
    </div>
  );
}
