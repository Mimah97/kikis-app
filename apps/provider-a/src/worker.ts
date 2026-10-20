import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  kikisAppHono,
  registerProvider,
  signManifest,
  SupabaseSeenTxStore,
  InMemorySeenTxStore,
  type SeenTxStore,
} from '@kikis-app/kikis-app/provider/hono'
import {
  buildManifest,
  HORIZON_URLS,
  MPP_CHARGE_PRICE,
  TESTNET_USDC_CONTRACT,
  USDC_ISSUERS,
  X402_PRICE,
  type Network,
} from './manifest.js'

export interface Env {
  STELLAR_NETWORK?: string
  STELLAR_PAYEE_SECRET: string
  STELLAR_PAYEE_ADDRESS: string
  USDC_ASSET_CONTRACT?: string
  OPENZEPPELIN_API_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  /** Public origin used when recording settlements, e.g. https://api-a.kikis-app.xyz */
  PUBLIC_BASE_URL?: string
}

interface OrderBookLevel {
  price: string
  amount: string
}

interface OrderBookResponse {
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
}

function resolveNetwork(raw: string | undefined): Network {
  return raw === 'mainnet' ? 'mainnet' : 'testnet'
}

function resolveAssetContract(env: Env, network: Network): string {
  if (env.USDC_ASSET_CONTRACT) return env.USDC_ASSET_CONTRACT
  if (network === 'testnet') return TESTNET_USDC_CONTRACT
  throw new Error('USDC_ASSET_CONTRACT is required for mainnet')
}

/**
 * A Stellar secret key is a 56-character StrKey starting with 'S'.
 * We only check shape here — never log or return the value itself.
 */
function isStellarSecretKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.length === 56 && value.startsWith('S')
}

/**
 * Return the names of environment variables that are unset or malformed.
 * Values are never included — only names, so this is safe to log or return
 * to a caller directly. Shared by createApp (throws, caught by fetch() below)
 * and healthResponse (reports 503 without ever building the app).
 */
function findStartupProblems(env: Env, network: Network): string[] {
  const problems: string[] = []
  if (!isStellarSecretKey(env.STELLAR_PAYEE_SECRET)) {
    problems.push('STELLAR_PAYEE_SECRET')
  }
  if (!env.STELLAR_PAYEE_ADDRESS) {
    problems.push('STELLAR_PAYEE_ADDRESS')
  }
  if (network === 'mainnet' && !env.USDC_ASSET_CONTRACT) {
    problems.push('USDC_ASSET_CONTRACT')
  }
  return problems
}

/**
 * Validate required worker environment variables at cold start.
 * Throws with the exact missing/malformed key names so misconfiguration
 * fails fast during initialization instead of mid-transaction.
 */
export function validateWorkerEnv(env: Env): void {
  const network = resolveNetwork(env.STELLAR_NETWORK)
  const problems = findStartupProblems(env, network)
  if (problems.length > 0) {
    console.error(`[startup] Provider misconfigured: ${problems.join(', ')}`)
    throw new Error(`Provider misconfigured: ${problems.join(', ')} unset or malformed`)
  }
}

/**
 * Freshness window for the shared orderbook snapshot. Concurrent and
 * back-to-back /price requests within this window are served from memory.
 */
const ORDERBOOK_TTL_MS = 2_000
/**
 * How long a snapshot may keep serving paid requests after Horizon stopped
 * answering (429 rate limits, timeouts, 5xx). Past this age the provider
 * fails honestly with a 502 rather than quoting a stale mid-price.
 */
const ORDERBOOK_STALE_MAX_AGE_MS = 30_000

/** A cached orderbook snapshot, keyed by the Horizon query it came from. */
interface CachedOrderBook {
  key: string
  data: OrderBookResponse
  timestamp: number
}

/** Result of a (possibly cached) orderbook read. */
export interface OrderBookResult {
  data: OrderBookResponse
  /** True when Horizon was unreachable and a cached snapshot was served instead. */
  stale: boolean
}

/**
 * Module-scope cache shared by every /price request in this isolate, plus the
 * single in-flight fetch they coalesce onto.
 */
let cachedOrderBook: CachedOrderBook | null = null
let inFlightOrderBook: { key: string; promise: Promise<OrderBookResult> } | null = null

function orderBookCacheKey(network: Network, limit: number): string {
  return `${network}:${limit}`
}

/**
 * Drop the cached orderbook snapshot and any in-flight fetch.
 * Exposed for tests; production code never needs it.
 */
export function clearOrderBookCache(): void {
  cachedOrderBook = null
  inFlightOrderBook = null
}

/**
 * Fetch the XLM/USDC orderbook straight from Horizon's REST API.
 *
 * The Express build used `Horizon.Server(...).orderbook(...)`, which pulls the
 * whole `@stellar/stellar-sdk` (and axios) into the bundle for what is a single
 * GET. Calling the endpoint keeps the Worker small and drops the dependency.
 */
async function fetchOrderBook(network: Network, limit: number): Promise<OrderBookResponse> {
  const params = new URLSearchParams({
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    buying_asset_issuer: USDC_ISSUERS[network],
    limit: String(limit),
  })

  const response = await fetch(`${HORIZON_URLS[network]}/order_book?${params.toString()}`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Horizon responded ${response.status}`)
  }

  return (await response.json()) as OrderBookResponse
}

/**
 * One Horizon fetch whose failures fall back to the most recent snapshot.
 *
 * kikisAppHono settles payment before the endpoint handler runs, so a Horizon
 * hiccup here would fail a request the customer has already paid for. Serving
 * a snapshot up to {@link ORDERBOOK_STALE_MAX_AGE_MS} old keeps the paid
 * request succeeding; only a snapshot-free outage still fails.
 */
async function readOrderBookWithFallback(
  key: string,
  network: Network,
  limit: number,
): Promise<OrderBookResult> {
  try {
    const data = await fetchOrderBook(network, limit)
    cachedOrderBook = { key, data, timestamp: Date.now() }
    return { data, stale: false }
  } catch (err) {
    const snapshot = cachedOrderBook
    const ageMs = snapshot ? Date.now() - snapshot.timestamp : Number.POSITIVE_INFINITY
    if (snapshot && snapshot.key === key && ageMs <= ORDERBOOK_STALE_MAX_AGE_MS) {
      console.warn(`[horizon] serving ${ageMs}ms-old cached orderbook after fetch failure:`, err)
      return { data: snapshot.data, stale: true }
    }
    throw err
  }
}

/**
 * Read the orderbook through the isolate-level cache.
 *
 * - Requests within the {@link ORDERBOOK_TTL_MS} window are served from
 *   memory.
 * - Concurrent misses coalesce onto one in-flight Horizon query, so a burst
 *   of simultaneous /price requests produces exactly one REST call instead of
 *   tripping Horizon's 429 rate limit.
 * - When Horizon fails (429, timeout, 5xx) the most recent snapshot — up to
 *   {@link ORDERBOOK_STALE_MAX_AGE_MS} old — is served with `stale: true`
 *   rather than the paid request failing.
 */
export async function getOrderBook(network: Network, limit: number): Promise<OrderBookResult> {
  const key = orderBookCacheKey(network, limit)

  const snapshot = cachedOrderBook
  if (snapshot && snapshot.key === key && Date.now() - snapshot.timestamp <= ORDERBOOK_TTL_MS) {
    return { data: snapshot.data, stale: false }
  }

  const flight =
    inFlightOrderBook && inFlightOrderBook.key === key
      ? inFlightOrderBook
      : { key, promise: readOrderBookWithFallback(key, network, limit) }
  inFlightOrderBook = flight
  try {
    return await flight.promise
  } finally {
    if (inFlightOrderBook === flight) inFlightOrderBook = null
  }
}

function createApp(env: Env, ctx: ExecutionContext): Hono {
  const network = resolveNetwork(env.STELLAR_NETWORK)

  validateWorkerEnv(env)

  const assetContract = resolveAssetContract(env, network)
  const manifest = buildManifest({ network, payee: env.STELLAR_PAYEE_ADDRESS, assetContract })

  const supabase: SupabaseClient | null =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
      : null

  const seenTxStore: SeenTxStore = supabase
    ? new SupabaseSeenTxStore(supabase)
    : new InMemorySeenTxStore()

  if (supabase) {
    const baseUrl = env.PUBLIC_BASE_URL ?? 'https://api-a.kikis-app.xyz'
    const signed = signManifest(manifest, env.STELLAR_PAYEE_SECRET)
    ctx.waitUntil(
      registerProvider({ supabase, manifest: signed, baseUrl, verified: true }).catch((err) => {
        console.error('[registry] Failed to register provider-a:', err)
      }),
    )
  }

  const providerUrl = `${env.PUBLIC_BASE_URL ?? 'https://api-a.kikis-app.xyz'}/price`

  const app = new Hono()

  // Allow cross-origin browser agents to send payment headers on /price and
  // read payment requirem

/* … truncated 600 chars — edit only what you need near the top … */
