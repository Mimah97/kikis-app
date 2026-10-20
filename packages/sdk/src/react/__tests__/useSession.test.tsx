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
import { useSession } from '../useSession.js'
import type {
  SessionCloseResult,
  SessionEvent,
  SessionEventPayloadMap,
  SessionHandle,
} from '../../types.js'

function newClient(): KikisAppClient {
  return new KikisAppClient({
    wallet: Keypair.random().secret(),
    network: 'testnet',
    commitmentSecret: Keypair.random().secret(),
  })
}

/**
 * Scriptable SessionHandle: the real listener registry shape plus an emit()
 * helper so tests can drive 'session:voucher' the way MppSessionClient does
 * during stream iteration. The stream emits one voucher per yielded item.
 */
function mockSession() {
  const listeners = new Map<SessionEvent, Set<(payload: unknown) => void>>()

  const emit = <E extends SessionEvent>(
    event: E,
    payload: SessionEventPayloadMap[E],
  ): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  const handle: SessionHandle = {
    channelId: 'C123',
    openTxHash: 'open-hash',
    async *stream() {
      // One voucher per iteration — mirrors MppSessionClient emitting
      // 'session:voucher' after each signed voucher.
      for (let i = 1; i <= 10; i++) {
        emit('session:voucher', {
          vouchersIssued: i,
          currentCumulative: (i * 0.0001).toFixed(7),
        })
        yield i
      }
    },
    async close(): Promise<SessionCloseResult> {
      return { closeTxHash: 'close-hash', totalPaid: '0.005', vouchersIssued: 5 }
    },
    async requestRefund() { return 'refund-hash' },
    async settleWithLatestVoucher() { return 'settle-hash' },
    async getDisputeStatus() { return 'open' },
    on<E extends SessionEvent>(
      event: E,
      listener: (payload: SessionEventPayloadMap[E]) => void,
    ) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      const stored = listener as (payload: unknown) => void
      set.add(stored)
      return () => {
        set?.delete(stored)
      }
    },
    removeAllListeners(event?: SessionEvent) {
      if (event === undefined) {
        listeners.clear()
      } else {
        listeners.delete(event)
      }
    },
    stats() {
      return { vouchersIssued: 0, currentCumulative: '0.0000000', channelId: 'C123', openTxHash: 'open-hash' }
    },
  }

  return {
    handle,
    emit,
    listenerCount: (event: SessionEvent): number => listeners.get(event)?.size ?? 0,
  }
}

function wrapper(client: KikisAppClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(KikisAppProvider, { client, children })
}

describe('useSession', () => {
  it('open → close transitions status and records vouchers', async () => {
    const client = newClient()
    client.openSession = async () => mockSession().handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })

    await waitFor(() => assert.equal(result.current.status, 'open'))
    assert.equal(result.current.session?.channelId, 'C123')

    await act(async () => {
      await result.current.close()
    })

    assert.equal(result.current.status, 'closed')
    assert.equal(result.current.vouchers, 5)
    assert.equal(result.current.cumulative, '0.005')
  })

  it('updates vouchers and cumulative in real time during stream iteration', async () => {
    const client = newClient()
    const mock = mockSession()
    client.openSession = async () => mock.handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })
    await waitFor(() => assert.equal(result.current.status, 'open'))

    // Nothing streamed yet — the hook still reports its initial values.
    assert.equal(result.current.vouchers, 0)
    assert.equal(result.current.cumulative, '0')

    // Consume the whole stream: the mock emits one 'session:voucher' per
    // iteration, exactly like the real client during an active stream.
    await act(async () => {
      for await (const _item of mock.handle.stream()) {
        // drain — each pull above pushed a voucher event into the hook
      }
    })

    assert.equal(result.current.vouchers, 10)
    assert.equal(result.current.cumulative, '0.0010000')
  })

  it('detaches the voucher listener on unmount', async () => {
    const client = newClient()
    const mock = mockSession()
    client.openSession = async () => mock.handle

    const { result, unmount } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })
    assert.equal(mock.listenerCount('session:voucher'), 1)

    unmount()
    assert.equal(
      mock.listenerCount('session:voucher'),
      0,
      'unmount must remove the session event listener',
    )

    // Emitting after unmount must reach nobody — no state update on an
    // unmounted component.
    act(() => {
      mock.emit('session:voucher', { vouchersIssued: 99, currentCumulative: '0.0099' })
    })
  })

  it('transitions status to closed when the session times out', async () => {
    const client = newClient()
    const mock = mockSession()
    client.openSession = async () => mock.handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })
    await waitFor(() => assert.equal(result.current.status, 'open'))

    // The SDK handle fires 'session:timeout' when maxDurationMs elapses and
    // auto-closes the session in the background.
    act(() => {
      mock.emit('session:timeout', { channelId: 'C123' })
    })

    await waitFor(() => assert.equal(result.current.status, 'closed'))
    assert.equal(result.current.error, null)
  })

  it('transitions status to error when auto-close fails after timeout', async () => {
    const client = newClient()
    const mock = mockSession()
    client.openSession = async () => mock.handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })
    await waitFor(() => assert.equal(result.current.status, 'open'))

    // The SDK handle fires 'session:close-failed' when the on-chain
    // auto-close rejects.
    act(() => {
      mock.emit('session:close-failed', {
        channelId: 'C123',
        error: new Error('auto-close rejected'),
      })
    })

    await waitFor(() => assert.equal(result.current.status, 'error'))
    assert.ok(result.current.error)
    assert.match(result.current.error?.message ?? '', /auto-close rejected/)
  })

  it('detaches timeout and close-failed listeners on unmount', async () => {
    const client = newClient()
    const mock = mockSession()
    client.openSession = async () => mock.handle

    const { result, unmount } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })
    assert.equal(mock.listenerCount('session:timeout'), 1)
    assert.equal(mock.listenerCount('session:close-failed'), 1)

    unmount()
    assert.equal(mock.listenerCount('session:timeout'), 0)
    assert.equal(mock.listenerCount('session:close-failed'), 0)
  })
})
