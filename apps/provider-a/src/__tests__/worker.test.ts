import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import worker, { clearOrderBookCache, getOrderBook, type Env } from '../worker.js'
import { TESTNET_USDC_CONTRACT } from '../manifest.js'

const mockCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'

const mockEnv: Env = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
  STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
  PUBLIC_BASE_URL: 'https://api-a.kikis-app.xyz',
  USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
}

describe('provider-a worker payment path & routes', () => {
  it('/health bypasses payment middleware and returns 200 OK', async () => {
    const req = new Request('http://localhost/health')
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 200)
    const body = (await res.json()) as { status: string; network: string; payee: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.network, 'testnet')
    assert.equal(typeof body.payee, 'string')
  })

  it('/.well-known/kikis-app.json serves a signed manifest with status 200', async () => {
    const req = new Request('http://localhost/.well-known/kikis-app.json')
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      signature?: string
      payee?: string
      modes?: string[]
      pricing?: Record<string, unknown>
    }

    assert.ok(body.signature, 'Manifest must contain signature property (issue #134)')
    assert.equal(body.payee, mockEnv.STELLAR_PAYEE_ADDRESS)
    assert.ok(Array.isArray(body.modes))
    assert.ok(body.modes.includes('x402'))
    assert.ok(body.modes.includes('mpp-charge'))
  })

  it('/price returns 402 Payment Required with parsed WWW-Authenticate payment challenge', async () => {
    const req = new Request('http://localhost/price')
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 402)

    // Verify WWW-Authenticate or X-Payment-Requirements header
    const authHeader = res.headers.get('WWW-Authenticate') || res.headers.get('X-Payment-Requirements')
    assert.ok(authHeader, 'Response must include payment challenge header')

    // Verify header contains Payment / mpp-charge / x402 details
    assert.ok(
      authHeader.includes('Payment') || authHeader.includes('x402') || authHeader.includes('mpp-charge'),
      'Challenge header must specify payment requirements',
    )
  })

  it('OPTIONS /price preflight responds with 204 and CORS allow headers', async () => {
    const req = new Request('http://localhost/price', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://agent.example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Payment-Signature, X-Payment',
      },
    })
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 204)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*')

    const allowHeaders = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase()
    assert.ok(allowHeaders.includes('payment-signature'), 'must allow Payment-Signature header')
    assert.ok(allowHeaders.includes('x-payment'), 'must allow X-Payment header')

    const exposeHeaders = (res.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase()
    assert.ok(exposeHeaders.includes('x-payment-requirements'), 'must expose X-Payment-Requirements header')
    assert.ok(exposeHeaders.includes('x-payment-response'), 'must expose X-Payment-Response header')
    assert.ok(exposeHeaders.includes('payment-receipt'), 'must expose Payment-Receipt header')
  })

  it('GET /health returns 503 misconfigured when STELLAR_PAYEE_SECRET is unset', async () => {
    const badEnv = { ...mockEnv, STELLAR_PAYEE_SECRET: undefined } as unknown as Env
    const req = new Request('http://localhost/health')
    const res = await worker.fetch(req, badEnv, mockCtx)

    assert.equal(res.status, 503)
    const body = (await res.json()) as { status: string; missing?: string[] }
    assert.equal(body.status, 'misconfigured')
    assert.ok(body.missing?.includes('STELLAR_PAYEE_SECRET'))
  })

  it('GET /health returns 503 misconfigured on mainnet with USDC_ASSET_CONTRACT unset', async () => {
    const badEnv = {
      ...mockEnv,
      STELLAR_NETWORK: 'mainnet',
      USDC_ASSET_CONTRACT: undefined,
    } as unknown as Env
    const req = new Request('http://localhost/health')
    const res = await worker.fetch(req, badEnv, mockCtx)

    assert.equal(res.status, 503)
    const body = (await res.json()) as { status: string; missing?: string[] }
    assert.equal(body.status, 'misconfigured')
    assert.ok(body.missing?.includes('USDC_ASSET_CONTRACT'))
  })
})

const ORDERBOOK_SNAPSHOT = {
  asks: [{ price: '0.1000000', amount: '100.0000000' }],
  bids: [{ price: '0.0900000', amount: '200.0000000' }],
}

const okOrderBook = () =>
  new Response(JSON.stringify(ORDERBOOK_SNAPSHOT), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('provider-a orderbook cache & 429 resilience', () => {
  it('coalesces 50 concurrent orderbook reads into exactly 1 Horizon query', async (t) => {
    clearOrderBookCache()
    let horizonCalls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      horizonCalls++
      await new Promise((resolve) => setTimeout(resolve, 25))
      return okOrderBook()
    })

    const results = await Promise.all(
      Array.from({ length: 50 }, () => getOrderBook('testnet', 1)),
    )

    assert.equal(horizonCalls, 1, 'a concurrent burst must produce a single Horizon REST query')
    for (const result of results) {
      assert.equal(result.stale, false)
      assert.equal(result.data.asks[0]?.price, ORDERBOOK_SNAPSHOT.asks[0]!.price)
    }
  })

  it('serves the cached snapshot within the 2s TTL without re-querying Horizon', async (t) => {
    clearOrderBookCache()
    let horizonCalls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      horizonCalls++
      return okOrderBook()
    })

    await getOrderBook('testnet', 1)
    await getOrderBook('testnet', 1)
    await getOrderBook('testnet', 1)
    assert.equal(horizonCalls, 1)
  })

  it('falls back to the most recent snapshot when Horizon returns 429', async (t) => {
    clearOrderBookCache()
    const start = Date.now()
    let now = start
    t.mock.method(Date, 'now', () => now)

    let horizonResponse: () => Response = okOrderBook
    let horizonCalls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      horizonCalls++
      return horizonResponse()
    })

    // Prime the cache with a healthy snapshot at `start`.
    const primed = await getOrderBook('testnet', 1)
    assert.equal(primed.stale, false)

    // Past the 2s TTL, within the 30s stale window: Horizon now rate-limits.
    now = start + 5_000
    horizonResponse = () => new Response('rate limited', { status: 429 })

    const result = await getOrderBook('testnet', 1)
    assert.equal(horizonCalls, 2)
    assert.equal(result.stale, true, 'a 429 must be answered from the cached snapshot')
    assert.equal(result.data.asks[0]?.price, ORDERBOOK_SNAPSHOT.asks[0]!.price)
  })

  it('rethrows when Horizon fails and no cached snapshot is available', async (t) => {
    clearOrderBookCache()
    t.mock.method(globalThis, 'fetch', async () => new Response('rate limited', { status: 429 }))

    await assert.rejects(() => getOrderBook('testnet', 1), /Horizon responded 429/)
  })

  it('stops serving snapshots older than the 30s stale window', async (t) => {
    clearOrderBookCache()
    const start = Date.now()
    let now = start
    t.mock.method(Date, 'now', () => now)

    let horizonResponse: () => Response = okOrderBook
    t.mock.method(globalThis, 'fetch', async () => horizonResponse())

    await getOrderBook('testnet', 1)
    now = start + 31_000
    horizonResponse = () => new Response('rate limited', { status: 429 })

    await assert.rejects(() => getOrderBook('testnet', 1), /Horizon responded 429/)
  })
})
