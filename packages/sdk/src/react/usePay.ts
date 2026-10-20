import { useCallback, useEffect, useRef, useState } from 'react'
import { useKikisApp } from './context.js'
import type { PaymentOptions, PaymentResult } from '../types.js'

export interface UsePayState {
  loading: boolean
  result: PaymentResult | null
  error: Error | null
  pay: (options?: PaymentOptions) => Promise<PaymentResult | null>
  reset: () => void
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false
    }
  }
  return true
}

export function usePay(url: string, options?: PaymentOptions): UsePayState {
  const client = useKikisApp()
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<PaymentResult | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const optionsRef = useRef<PaymentOptions | undefined>(options)

  if (!shallowEqual(optionsRef.current, options)) {
    optionsRef.current = options
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const pay = useCallback(
    async (overrideOptions?: PaymentOptions): Promise<PaymentResult | null> => {
      if (inFlightRef.current) return null
      inFlightRef.current = true

      const controller = new AbortController()
      abortRef.current = controller

      if (mountedRef.current) {
        setLoading(true)
        setError(null)
      }

      try {
        const mergedOptions = overrideOptions ?? optionsRef.current
        const res = await client.pay(url, {
          ...mergedOptions,
          signal: controller.signal,
        })
        if (mountedRef.current && !controller.signal.aborted) {
          setResult(res)
        }
        return res
      } catch (err) {
        if (mountedRef.current && !controller.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)))
        }
        return null
      } finally {
        inFlightRef.current = false
        if (abortRef.current === controller) {
          abortRef.current = null
        }
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [client, url],
  )

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
    setLoading(false)
  }, [])

  return { loading, result, error, pay, reset }
}
