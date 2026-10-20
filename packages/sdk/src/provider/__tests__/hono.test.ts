import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { kikisAppHono, type KikisAppHonoOptions } from '../hono.js'
import type { KikisAppManifest } from '../../types.js'
import { InMemorySeenTxStore, paymentIdempotencyKey } from '../SeenTxStore.js'
import { usdcToStroops } from '../../internal/usdc.js'

// Generate fresh keypairs — avoids hardcoding secrets while keeping tests self-contained
const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Test Service',
  description: 'Unit test provider',
  modes: ['x402', 'mpp-charge', 'mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

const BASE_OPTS = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
}

function makeApp(overrides: Partial<KikisAppHonoOptions> = {}) {
  const app = new Hono()
  app.use(
    '*',
    kikisAppHono({
      ...BASE_OPTS,
      modes: ['x402', 'mpp-charge', 'mpp-session'],
      pricing: {
        x402: '0.001',
        'mpp-charge': '0.0008',
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
      ...overrides,
    }),
  )
  app.get('/price', (c) => c.json({ price: '42' }))
  return app
}

describe('kikisAppHono — manifest endpoint', () => {
  it('serves /.well-known/kikis-app.json', async () => {
    const app = makeApp({ modes: [] as ('x402' | 'mpp-charge' | 'mpp-session')[], pricing: {} })
    const res = await app.request('/.well-known/kikis-app.json')
    assert.equal(res.status, 200)
    const body = await res.json() as { name: string }
    assert.equal(body.name, manifest.name)
  })

  it('passes through when no modes are configured', async () => {
    const app = makeApp({ modes: [], pricing: {} })
    const res = await app.request('/price')
    assert.equal(res.status, 200)
  })
})

describe('kikisAppHono — CORS preflight', () => {
  it('handles OPTIONS preflight with payment CORS headers when cors is enabled', async () => {
    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      cors: true,
    })
    const res = await app.request('/price', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://agent.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'payment-signature, x-preferred-mode',
      },
    })
    assert.ok(res.status === 200 || res.status === 204, `expected 200/204, got ${res.status}`)
    const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const h of ['payment-signature', 'x-payment', 'x-preferred-mode', 'authorization', 'content-type']) {
      assert.ok(allowHeaders.includes(h), `expected Access-Control-Allow-Headers to include ${h}`)
    }
    const exposeHeaders = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase()
    for (const h of ['x-payment-requirements', 'x-payment-response', 'payment-receipt']) {
      assert.ok(exposeHeaders.includes(h), `expected Access-Control-Expose-Headers to include ${h}`)
    }
  })

  it('does not short-circuit OPTIONS when cors is disabled', async () => {
    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
    })
    const res = await app.request('/price', { method: 'OPTIONS' })
    assert.notEqual(res.status, 204)
  })
})

describe('kikisAppHono — x402 flow', () => {
  it('returns 402 with X-Payment-Requirements when no payment header', async () => {
    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
    assert.ok(
      res.headers.get('x-payment-requirements'),
      'expected X-Payment-Requirements header',
    )
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'Payment Required')
  })

  it('routes to x402 handler when x-preferred-mode: x402 header is set', async () => {
    const app = makeApp({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    const res = await app.request('/price', {
      headers: { 'x-preferred-mode': 'x402' },
    })
    assert.equal(res.status, 402)
    assert.ok(res.headers.get('x-payment-requirements'))
  })
})

describe('kikisAppHono — mpp-charge flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = makeApp({
      modes: ['mpp-charge'],
      pricing: { 'mpp-charge': '0.0008' },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
  })
})

describe('kikisAppHono — mpp-session flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = makeApp({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
  })

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const app = makeApp({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 200)
    const body = await res.json() as { closeTxHash: null }
    assert.equal(body.closeTxHash, null)
  })
})

describe('kikisAppHono — mpp-session-ws flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = makeApp({
      modes: ['mpp-session-ws'],
      pricing: {
        'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
  })

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const app = makeApp({
      modes: ['mpp-session-ws'],
      pricing: {
        'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 200)
    const body = await res.json() as { closeTxHash: null }
    assert.equal(body.closeTxHash, null)
  })
})

describe('kikisAppHono — constructor validation', () => {
  it('throws when mpp-session mode is enabled without commitmentPublicKey', () => {
    const { commitmentPublicKey: _ignored, ...withoutCommitment } = BASE_OPTS
    assert.throws(
      () =>
        kikisAppHono({
          ...withoutCommitment,
          modes: ['mpp-session'],
          pricing: {
            'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
          },
        }),
      /commitmentPublicKey/,
    )
  })
})

describe('kikisAppHono — settlement idempotency', () => {
  const X402_AMOUNT = String(usdcToStroops('0.001'))

  it('replays cached settlement on duplicate payment-signature header', async () => {
    const seenStore = new InMemorySeenTxStore()
    const settled: string[] = []

    const key = await paymentIdempotencyKey(
      (n) => (n === 'payment-signature' ? 'SIG' : undefined),
      {
        method: 'GET',
        path: '/price',
        amount: X402_AMOUNT,
        payTo: payeeKeypair.publicKey(),
      },
    )
    assert.ok(key)
    await seenStore.set(key, {
      txHash: 'CACHED_TX_HASH',
      headers: { 'X-Payment-Response': 'cached-response' },
      createdAt: Date.now(),
    })

    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: seenStore,
      onSettled: async (txHash: string) => { settled.push(txHash) },
    })

    const res = await app.request('/price', {
      headers: { 'payment-signature': 'SIG' },
    })
    assert.equal(res.status, 200)
    const data = (await res.json()) as { price: string }
    assert.equal(data.price, '42')
    assert.equal(res.headers.get('x-payment-response'), 'cached-response')

    await new Promise((r) => setImmediate(r))
    assert.equal(settled.length, 0)
  })

  it('rejects the second replay with 402 and does not run the route handler again', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    let handlerRuns = 0
    const app = new Hono()
    app.use(
      '*',
      kikisAppHono({
        ...BASE_OPTS,
        modes: ['x402'],
        pricing: { x402: '0.001' },
        seenTxStore: seenStore,
      }),
    )
    app.get('/price', (c) => {
      handlerRuns++
      return c.json({ price: '42' })
    })

    const first = await app.request('/price', {
      headers: { 'payment-signature': 'SIG' },
    })
    assert.equal(first.status, 200)

    const second = await app.request('/price', {
      headers: { 'payment-signature': 'SIG' },
    })
    assert.equal(second.status, 402)
    assert.equal(handlerRuns, 1)
  })
})
