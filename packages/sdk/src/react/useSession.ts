import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionHandle, SessionCloseResult } from '../types.js'
import { useKikisAppContext } from './context.js'

export type SessionStatus = 'idle' | 'opening' | 'open' | 'closing' | 'closed' | 'error'

export interface UseSessionResult {
  session: SessionHandle | null
  status: SessionStatus
  vouchers: number
  cumulative: string
  error: Error | null
  open: () => Promise<SessionHandle | null>
  close: () => Promise<SessionCloseResult | null>
}

/**
 * Manages MPP session lifecycle. On unmount, fires session.close() in the
 * background if status === 'open' (best-effort settlement).
 *
 * @example
 * const { session, open, close, vouchers, cumulative, status } = useSession(streamUrl)
 * useEffect(() => { open() }, [])
 */
export function useSession(url: string): UseSessionResult {
  const { client } = useKikisAppContext()
  const [session, setSession] = useState<SessionHandle | null>(null)
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [vouchers, setVouchers] = useState(0)
  const [cumulative, setCumulative] = useState('0')
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)
  const sessionRef = useRef<SessionHandle | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const unsubscribeLifecycleRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Detach the live-stats listener first so no voucher event can land on
      // an unmounted component (#15).
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      // Detach lifecycle listeners so a background timeout/close-failure can't
      // update state after unmount (#87).
      unsubscribeLifecycleRef.current?.()
      unsubscribeLifecycleRef.current = null
      const s = sessionRef.current
      if (s) {
        s.close().catch(() => {
          /* unmount best-effort */
        })
        sessionRef.current = null
      }
    }
  }, [])

  const open = useCallback(async (): Promise<SessionHandle | null> => {
    setStatus('opening')
    setError(null)
    try {
      const s = await client.openSession(url)
      sessionRef.current = s
      // Subscribe to per-voucher updates so vouchers/cumulative move in real
      // time during streaming instead of staying at their initial zeros until
      // close() resolves (#15). A previous session's listener (if any) is
      // detached before attaching the new one.
      unsubscribeRef.current?.()
      unsubscribeRef.current = s.on('session:voucher', (payload) => {
        if (!mountedRef.current) return
        setVouchers(payload.vouchersIssued)
        setCumulative(payload.currentCumulative)
      })
      // Subscribe to lifecycle events so a background wall-clock timeout or a
      // failed auto-close is reflected in React state instead of leaving the
      // UI stuck on status === 'open' (#87).
      unsubscribeLifecycleRef.current?.()
      const offTimeout = s.on('session:timeout', () => {
        if (!mountedRef.current) return
        sessionRef.current = null
        unsubscribeRef.current?.()
        unsubscribeRef.current = null
        setSession(null)
        setStatus('closed')
      })
      const offCloseFailed = s.on('session:close-failed', (payload) => {
        if (!mountedRef.current) return
        sessionRef.current = null
        unsubscribeRef.current?.()
        unsubscribeRef.current = null
        const e =
          payload instanceof Error
            ? payload
            : new Error(
                typeof payload === 'object' && payload !== null && 'error' in payload
                  ? String((payload as { error: unknown }).error)
                  : 'Session auto-close failed',
              )
        setSession(null)
        setError(e)
        setStatus('error')
      })
      unsubscribeLifecycleRef.current = () => {
        offTimeout()
        offCloseFailed()
      }
      if (mountedRef.current) {
        setSession(s)
        setStatus('open')
      }
      return s
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (mountedRef.current) {
        setError(e)
        setStatus('error')
      }
      return null
    }
  }, [client, url])

  const close = useCallback(async (): Promise<SessionCloseResult | null> => {
    const s = sessionRef.current
    if (!s) return null
    setStatus('closing')
    try {
      const r = await s.close()
      sessionRef.current = null
      // The session is settled — stop listening. The close result carries the
      // authoritative final totals below, so no further update can arrive.
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      unsubscribeLifecycleRef.current?.()
      unsubscribeLifecycleRef.current = null
      if (mountedRef.current) {
        setSession(null)
        setStatus('closed')
        setVouchers(r.vouchersIssued)
        setCumulative(r.totalPaid)
      }
      return r
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (mountedRef.current) {
        setError(e)
        setStatus('error')
      }
      return null
    }
  }, [])

  return { session, status, vouchers, cumulative, error, open, close }
}
