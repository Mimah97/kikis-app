import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseSessionStore } from '../SessionStore.js'
import type { SessionState } from '../../types.js'
import { KikisAppVoucherMonotonicityError, KikisAppNetworkError } from '../../errors.js'

function mockSupabase(opts: {
  queryError?: string
  upsertError?: string
  updateError?: string
  insertError?: { message: string; code?: string } | string
  data?: Record<string, unknown> | null
  onUpsert?: (payload: Record<string, unknown>, options?: unknown) => void
  onInsert?: (payload: Record<string, unknown>) => void
  onUpdate?: (payload: Record<string, unknown>, eqField?: string, eqVal?: string) => void
}): SupabaseClient {
  return {
    from(_table: string) {
      let updatePayload: Record<string, unknown> | null = null
      let eqField: string | undefined
      let eqVal: string | undefined
      return {
        select(_cols: string) {
          return {
            eq(_field: string, _val: string) {
              return {
                maybeSingle() {
                  return Promise.resolve({
                    data: opts.data ?? null,
                    error: opts.queryError ? { message: opts.queryError } : null,
                  })
                },
              }
            },
          }
        },
        insert(payload: Record<string, unknown>) {
          opts.onInsert?.(payload)
          opts.onUpsert?.(payload)
          const err =
            typeof opts.insertError === 'string'
              ? { message: opts.insertError }
              : opts.insertError ?? null
          return Promise.resolve({
            data: null,
            error: err,
          })
        },
        upsert(payload: Record<string, unknown>, options?: unknown) {
          opts.onUpsert?.(payload, options)
          return Promise.resolve({
            data: null,
            error: opts.upsertError ? { message: opts.upsertError } : null,
          })
        },
        update(payload: Record<string, unknown>) {
          updatePayload = payload
          const query = {
            eq(field: string, val: string) {
              eqField = field
              eqVal = val
              opts.onUpdate?.(updatePayload!, field, val)
              return query
            },
            lt(_field: string, _val: string) {
              return query
            },
            select(_cols?: string) {
              let matched = false
              if (opts.data && opts.data[eqField ?? 'channel_id'] === eqVal) {
                if (updatePayload && 'cumulative_amount' in updatePayload) {
                  const existingAmt = Number(opts.data['cumulative_amount'])
                  const newAmt = Number(updatePayload['cumulative_amount'])
                  if (newAmt > existingAmt) {
                    matched = true
                  }
                } else {
                  matched = true
                }
              }
              return Promise.resolve({
                data: matched ? [{ [eqField ?? 'channel_id']: eqVal }] : [],
                error: opts.updateError ? { message: opts.updateError } : null,
              })
            },
            then(
              onFulfilled: (res: { data: unknown; error: unknown }) => unknown,
              onRejected?: (err: unknown) => unknown,
            ) {
              return Promise.resolve({
                data: null,
                error: opts.updateError ? { message: opts.updateError } : null,
              }).then(onFulfilled, onRejected)
            },
          }
          return query
        },
      }
    },
  } as unknown as SupabaseClient
}

const sampleRow = {
  channel_id: 'channel_123',
  payee: 'GPAYEE123',
  payer: 'GPAYER123',
  channel_contract: 'CCONTRACT123',
  network: 'testnet',
  cumulative_amount: '0.0050000',
  last_signature: 'sig_abc',
  status: 'open',
  opened_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  settlement_tx_hash: null,
}

const sampleState: SessionState = {
  channel_id: 'channel_123',
  payee: 'GPAYEE123',
  payer: 'GPAYER123',
  channel_contract: 'CCONTRACT123',
  network: 'testnet',
  cumulative_amount: '0.0050000',
  last_signature: 'sig_abc',
  status: 'open',
  opened_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  settlement_tx_hash: null,
}

describe('SupabaseSessionStore', () => {
  it('returns channel_contract and network from get()', async () => {
    const store = new SupabaseSessionStore(mockSupabase({ data: sampleRow }))
    const session = await store.get('channel_123')
    assert.ok(session)
    assert.equal(session.channel_contract, 'CCONTRACT123')
    assert.equal(session.network, 'testnet')
    assert.equal(session.channel_id, 'channel_123')
    assert.equal(session.payee, 'GPAYEE123')
    assert.equal(session.payer, 'GPAYER123')
  })

  it('upsert() sends non-null values for NOT NULL columns (channel_id, payee, payer, channel_contract) and network', async () => {
    const upserts: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: null,
        onUpsert: (payload) => {
          upserts.push(payload)
        },
      }),
    )

    await store.upsert('channel_123', sampleState)

    assert.equal(upserts.length, 1)
    const payload = upserts[0]
    assert.ok(payload)
    assert.ok(payload.channel_id, 'channel_id must not be null/undefined')
    assert.ok(payload.payee, 'payee must not be null/undefined')
    assert.ok(payload.payer, 'payer must not be null/undefined')
    assert.ok(payload.channel_contract, 'channel_contract must not be null/undefined')
    assert.equal(payload.channel_contract, 'CCONTRACT123')
    assert.equal(payload.network, 'testnet')
    assert.equal(payload.channel_id, 'channel_123')
  })

  it('setStatus() calls update with a payload that has no cumulative_amount key', async () => {
    const updates: { payload: Record<string, unknown>; eqField?: string | undefined; eqVal?: string | undefined }[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        onUpdate: (payload, eqField, eqVal) => {
          updates.push({ payload, eqField, eqVal })
        },
      }),
    )

    await store.setStatus('channel_123', 'closing')

    assert.equal(updates.length, 1)
    const update = updates[0]
    assert.ok(update)
    assert.equal('cumulative_amount' in update.payload, false)
    assert.equal(update.payload.status, 'closing')
    assert.ok(update.payload.updated_at)
    assert.equal(update.eqField, 'channel_id')
    assert.equal(update.eqVal, 'channel_123')
  })

  it('moving a stored session from open to closing at an unchanged amount resolves without throwing', async () => {
    const updates: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: sampleRow,
        onUpdate: (payload) => {
          updates.push(payload)
        },
      }),
    )

    await assert.doesNotReject(async () => {
      await store.setStatus('channel_123', 'closing')
    })
    assert.equal(updates.length, 1)
    const payload = updates[0]
    assert.ok(payload)
    assert.equal(payload.status, 'closing')
    assert.equal('cumulative_amount' in payload, false)
  })

  it('setStatus() writes settlement_tx_hash when one is passed', async () => {
    const updates: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        onUpdate: (payload) => {
          updates.push(payload)
        },
      }),
    )

    await store.setStatus('channel_123', 'closed', 'tx_settled_hash_999')

    assert.equal(updates.length, 1)
    const payload = updates[0]
    assert.ok(payload)
    assert.equal(payload.status, 'closed')
    assert.equal(payload.settlement_tx_hash, 'tx_settled_hash_999')
    assert.equal('cumulative_amount' in payload, false)
  })

  it('setStatus() rejects with KikisAppNetworkError when update fails', async () => {
    const store = new SupabaseSessionStore(
      mockSupabase({
        updateError: 'database unreachable',
      }),
    )

    await assert.rejects(
      () => store.setStatus('channel_123', 'closing'),
      KikisAppNetworkError,
    )
  })

  it('close() sends status: closed and no cumulative_amount', async () => {
    const updates: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        onUpdate: (payload) => {
          updates.push(payload)
        },
      }),
    )

    await store.close('channel_123')

    assert.equal(updates.length, 1)
    const payload = updates[0]
    assert.ok(payload)
    assert.equal(payload.status, 'closed')
    assert.equal('cumulative_amount' in payload, false)
  })

  it('upsert() rejects with KikisAppVoucherMonotonicityError when cumulative_amount <= stored, without calling client upsert', async () => {
    let upsertCalled = false
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: sampleRow, // cumulative_amount is 0.0050000
        onUpsert: () => {
          upsertCalled = true
        },
      }),
    )

    // Equal amount
    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0050000',
        }),
      KikisAppVoucherMonotonicityError,
    )
    assert.equal(upsertCalled, false)

    // Lower amount
    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0040000',
        }),
      KikisAppVoucherMonotonicityError,
    )
    assert.equal(upsertCalled, false)
  })

  // Issue #55 — Replace IEEE 754 parseFloat with Stroop BigInt Arithmetic
  it('enforces exact BigInt stroop monotonicity on sub-micro fractional amounts (0.0000001 USDC)', async () => {
    // 0.0000001 USDC = 1 stroop
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: {
          ...sampleRow,
          cumulative_amount: '0.0000002', // 2 stroops stored
        },
      }),
    )

    // Rejection on lower sub-micro amount (1 stroop <= 2 stroops)
    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0000001', // 1 stroop
        }),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppVoucherMonotonicityError)
        assert.match(err.message, /1 <= 2/)
        return true
      },
    )

    // Rejection on equal sub-micro amount (2 stroops <= 2 stroops)
    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0000002', // 2 stroops
        }),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppVoucherMonotonicityError)
        assert.match(err.message, /2 <= 2/)
        return true
      },
    )
  })

  it('avoids IEEE 754 floating point rounding drift on 7-decimal boundary comparisons', async () => {
    // In IEEE 754 64-bit float: 0.0000001 + 0.0000002 = 0.00000030000000000004
    // With BigInt stroops: exactly 3 stroops.
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: {
          ...sampleRow,
          cumulative_amount: '0.0000003', // 3 stroops
        },
      }),
    )

    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0000003',
        }),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppVoucherMonotonicityError)
        assert.match(err.message, /3 <= 3/)
        return true
      },
    )
  })

  // Issue #56 — Eliminate TOCTOU race condition with atomic SQL updates
  it('preserves strict monotonicity under 10 parallel voucher upserts on the same channel ID', async () => {
    // In-memory mock simulating a single row in Supabase with atomic conditional UPDATE:
    // UPDATE sessions SET ... WHERE channel_id = $id AND cumulative_amount < $new
    let currentRow: Record<string, unknown> = {
      ...sampleRow,
      channel_id: 'concurrent_chan',
      cumulative_amount: '0.0000000',
    }

    const concurrentSupabase = {
      from(_table: string) {
        let updatePayload: Record<string, unknown> | null = null
        let eqChan: string | undefined
        let ltAmount: string | undefined
        return {
          select(_cols: string) {
            return {
              eq(_f: string, _v: string) {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { ...currentRow }, error: null })
                  },
                }
              },
            }
          },
          update(payload: Record<string, unknown>) {
            updatePayload = payload
            const q = {
              eq(_field: string, val: string) {
                eqChan = val
                return q
              },
              lt(_field: string, val: string) {
                ltAmount = val
                return q
              },
              select(_cols?: string) {
                // Atomic compare-and-swap:
                // only update if currentRow.channel_id === eqChan AND BigInt(current) < BigInt(new)
                const currentStroops = BigInt(Math.round(Number(currentRow.cumulative_amount) * 1e7))
                const nextStroops = BigInt(Math.round(Number(updatePayload?.cumulative_amount ?? 0) * 1e7))
                if (currentRow.channel_id === eqChan && currentStroops < nextStroops) {
                  currentRow = { ...currentRow, ...updatePayload }
                  return Promise.resolve({ data: [{ channel_id: eqChan }], error: null })
                }
                return Promise.resolve({ data: [], error: null })
              },
            }
            return q
          },
        }
      },
    } as unknown as SupabaseClient

    const store = new SupabaseSessionStore(concurrentSupabase)

    // Launch 10 parallel upserts with amounts 0.0000001 through 0.0000010 (1 to 10 stroops)
    // in randomized / parallel order
    const amounts = [
      '0.0000005',
      '0.0000002',
      '0.0000010',
      '0.0000001',
      '0.0000007',
      '0.0000003',
      '0.0000009',
      '0.0000004',
      '0.0000008',
      '0.0000006',
    ]

    const results = await Promise.allSettled(
      amounts.map((amount) =>
        store.upsert('concurrent_chan', {
          ...sampleState,
          channel_id: 'concurrent_chan',
          cumulative_amount: amount,
        }),
      ),
    )

    // The final stored amount must be strictly the highest amount: '0.0000010'
    assert.equal(currentRow.cumulative_amount, '0.0000010')

    // At least one succeeded, and any failed promises failed with KikisAppVoucherMonotonicityError
    let successes = 0
    for (const res of results) {
      if (res.status === 'fulfilled') {
        successes++
      } else {
        assert.ok(
          res.reason instanceof KikisAppVoucherMonotonicityError,
          `Expected KikisAppVoucherMonotonicityError but got: ${res.reason}`,
        )
      }
    }
    assert.ok(successes >= 1, 'At least one upsert should succeed')
  })
})

