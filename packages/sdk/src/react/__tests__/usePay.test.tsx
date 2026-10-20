import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook, act, waitFor } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { createElement, type ReactNode } from 'react'
import { KikisAppClient } from '../../client/KikisAppClient.js'
import { KikisAppProvider } from '../context.js'
import { usePay } from '../usePay.js'
import type { PaymentResult } from '../../types.js'

function wrapper(client: KikisAppClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(KikisAppProvider, { client, children })
}

describe('usePay', () => {
  it('transitions loading → result on success', async () => {
    const client = new KikisAppClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const fake: PaymentResult = {
      data: { ok: true },
      txHash: 'abc',
      mode: 'x402',
      amount: '0.001',
      timestamp: Date.now(),
    }
    client.pay = async () => fake

    const { result } = renderHook(() => usePay('https://x.test/price'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.pay()
    })

    await waitFor(() => assert.equal(result.current.loading, false))
    assert.equal(result.current.result, fake)
    assert.equal(result.current.error, null)
  })

  it('captures errors', async () => {
    const client = new KikisAppClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    client.pay = async () => {
      throw new Error('boom')
    }

    const { result } = renderHook(() => usePay('https://x.test/price'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.pay()
    })

    assert.ok(result.current.error instanceof Error)
    assert.equal(result.current.error?.message, 'boom')
    assert.equal(result.current.loading, false)
  })

  it('deduplicates rapid sequential clicks into one payment', async () => {
    const client = new KikisAppClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    let calls = 0
    let resolvePay: (value: PaymentResult) => void = () => {}
    const fake: PaymentResult = {
      data: { ok: true },
      txHash: 'dedupe',
      mode: 'x402',
      amount: '0.001',
      timestamp: Date.now(),
    }
    client.pay = () => {
      calls += 1
      return new Promise<PaymentResult>((resolve) => {
        resolvePay = resolve
      })
    }

    const { result } = renderHook(() => usePay('https://x.test/price'), {
      wrapper: wrapper(client),
    })

    await act(async () => {
      const first = result.current.pay()
      const second = result.current.pay()
      const third = result.current.pay()
      resolvePay(fake)
      await Promise.all([first, second, third])
    })

    assert.equal(calls, 1)
    assert.equal(result.current.result, fake)
    assert.equal(result.current.loading, false)
  })

  it('aborts pending payment on unmount without state update errors', async () => {
    const client = new KikisAppClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    let capturedSignal: AbortSignal | undefined
    client.pay = (_url: string, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal
      return new Promise<PaymentResult>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }

    const { result, unmount } = renderHook(() => usePay('https://x.test/price'), {
      wrapper: wrapper(client),
    })

    let pending: Promise<PaymentResult | null> = Promise.resolve(null)
    await act(async () => {
      pending = result.current.pay()
    })

    assert.ok(capturedSignal)
    assert.equal(capturedSignal?.aborted, false)

    unmount()

    assert.equal(capturedSignal?.aborted, true)
    await act(async () => {
      await pending
    })
  })

  it('keeps pay callback identity stable across re-renders', async () => {
    const client = new KikisAppClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    client.pay = async () => ({
      data: { ok: true },
      txHash: 'stable',
      mode: 'x402',
      amount: '0.001',
      timestamp: Date.now(),
    })

    const { result, rerender } = renderHook(
      () => usePay('https://x.test/price', { amount: '0.001' }),
      { wrapper: wrapper(client) },
    )
    const firstPay = result.current.pay

    rerender()
    rerender()

    assert.equal(result.current.pay, firstPay)
  })
})
