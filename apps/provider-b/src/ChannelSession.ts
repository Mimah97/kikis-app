import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  kikisAppHono,
  mppSessionWsVerified,
  registerProvider,
  signManifest,
  reconcileAbandonedSessions,
  type ReconciliationStats,
} from '@kikis-app/kikis-app/provider/hono'
import { Store } from '@stellar/mpp/channel/server'
import {
  buildManifest,
  HORIZON_URLS,
  SESSION_RATE,
  USDC_ISSUERS,
  type Network,
} from './manifest.js'
import type { Env } from './env.js'
import { createSessionWriters } from './sessionWrites.js'
import { resolveAssetContract } from './config.js'

/**
 * How long a successful provider registration is considered fresh. Within this
 * window a Durable Object wake-up skips the Supabase upsert entirely (#110).
 */
const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000

/** Durable Object storage key holding the last successful registration time. */
const LAST_REGISTERED_AT_KEY = 'last_registered_at'

interface OrderBookLevel {
  price: string
  amount: string
}

interface OrderBookResponse {
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
}

/**
 * Start the periodic orderbook push for a paid WebSocket connection.
 *
 * The interval is self-terminating. An abnormal disconnect — edge isolate
 * eviction, client crash, a broken pipe on send — never fires onClose, so
 * push() checks the socket's readyState on every tick and tears the timer
 * down itself. Without that guard a phantom interval keeps polling Horizon
 * every 5 seconds and burning Durable Object CPU time for as long as the
 * object lives.
 *
 * `stop()` must also be called from the socket's onClose/onError handlers for
 * clean teardown.
 */
export function startOrderbookPush(
  socket: { send: (data: string) => void; readyState: number },
  fetchSnapshot: () => Promise<unknown>,
  intervalMs = 5_000,
): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const push = async (): Promise<void> => {
    if (stopped) return
    if (socket.readyState !== 1) {
      // The socket is already gone (abnormal disconnect — onClose will not
      // fire). Stop polling instead of querying Horizon forever.
      stop()
      return
    }

    let snapshot: unknown
    try {
      snapshot = await fetchSnapshot()
    } catch (err) {
      // Horizon blip — keep the interval alive; the next tick retries.
      console.error('[horizon] orderbook ws error:', err)
      return
    }

    if (stopped) return
    try {
      socket.send(JSON.stringify(snapshot))
    } catch (err) {
      console.error('[horizon] orderbook ws error:', err)
      // send() throwing (broken pipe) means the client disappeared without a
      // close frame — stop the interval rather than retrying every tick.
      stop()
    }
  }

  void push()
  if (!stopped) {
    timer = setInterval(() => void push(), intervalMs)
  }
  return { stop }
}

/**
 * The mpp-session provider, hosted inside a single Durable Object.
 *
 * This is not an optimisation, it is a correctness requirement. The SDK's
 * session middleware keeps `lastCumulativeAmount`, `voucherCount`,
 * `lastSignatureHex` and `sessionPayerAddress` in closure scope, and the mppx
 * channel store it builds is `Store.memory()`. That was sound on Railway,
 * where one process served an entire session.
 *
 * On plain Workers it is not: MppSessionClient issues one HTTP request per
 * voucher, so voucher N and voucher N+1 routinely land in different isolates.
 * A fresh isolate starts at `lastCumulativeAmount = 0n` with an empty
 * signature, and the DELETE close path then falls back to trusting the
 * client-supplied amount and signature instead of the provider's own tracked
 * values. That is the exact protection the SDK added, defeated by the runtime.
 *
 * A Durable Object restores the single-process assumption the SDK is written
 * against: one instance per channel contract, serialized execution, and memory
 * that persists between requests.
 *
 * The SDK receives a store backed by this object's persistent storage, so mppx
 * channel state survives isolate eviction.
 *
 * The session counters moved into that store as well (#52): every verified
 * voucher commits its cumulative amount, signature, payer and voucher count to
 * the persistent store, and the DELETE close path reloads them from storage
 * before building the close transaction — it never falls back to
 * client-supplied values. An eviction mid-session therefore cannot reset the
 * counters or make the settlement trust a self-reported amount again.
 */
export class ChannelSession extends DurableObject<Env> {
  private app: Hono | null = null

  /**
   * In-flight registration promise. Concurrent buildApp() calls on the same
   * instance share this so overlapping wake-ups fire at most one upsert (#110).
   */
  private registrationInFlight: Promise<void> | null = null

  /**
   * True while a reconciliation cycle is running. Durable Object input gates
   * only serialize storage operations — reconcileAbandonedSessions awaits
   * Supabase and Soroban RPC calls, during which the next 15-minute cron tick
   * can interleave. Overlapping runs would try to close the same channels
   * on-chain twice (#28).
   */
  private isReconciling = false

  /**
   * Register this provider with the registry, throttled to once per
   * REGISTRATION_TTL_MS. Reads `last_registered_at` from Durable Object
   * storage so the throttle survives hibernation and isolate eviction, and
   * deduplicates concurrent attempts via `registrationInFlight`.
   */
  private async registerProviderThrottled(
    supabase: SupabaseClient,
    manifest: ReturnType<typeof buildManifest>,
    baseUrl: string,
    payeeSecret: string,
  ): Promise<void> {
    if (this.registrationInFlight) {
      return this.registrationInFlight
    }

    const run = async (): Promise<void> => {
      const lastRegisteredAt = await this.ctx.storage.get<number>(LAST_REGISTERED_AT_KEY)
      if (typeof lastRegisteredAt === 'number' && Date.now() - lastRegisteredAt < REGISTRATION_TTL_MS) {
        return
      }

      const signed = signManifest(manifest, payeeSecret)
      await registerProvider({ supabase, manifest: signed, baseUrl, verified: true })
      await this.ctx.storage.put(LAST_REGISTERED_AT_KEY, Date.now())
    }

    this.registrationInFlight = run().finally(() => {
      this.registrationInFlight = null
    })
    return this.registrationInFlight
  }

  private buildApp(): Hono {
    const env = this.env
    const network: Network = env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    const assetContract = resolveAssetContract(env, network)
    const channelContract = env.CHANNEL_CONTRACT_ID ?? ''

    // mpp-session cannot verify a voucher without the commitment key, so fail
    // loudly here rather than serving a provider that rejects every payment.
    const commitmentPublicKey = env.COMMITMENT_PUBLIC_KEY
    if (!commitmentPublicKey) {
      throw new Error('COMMITMENT_PUBLIC_KEY is required for mpp-session')
    }

    const manifest = buildManifest({
      network,
      payee: env.STELLAR_PAYEE_ADDRESS,
      assetContract,
      channelContract,
    })

    const supabase: SupabaseClient | null =
      env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
        ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
        : null

    if (supabase && env.STELLAR_PAYEE_SECRET) {
      const baseUrl = env.PUBLIC_BASE_URL ?? 'https://api-b.kikis-app.xyz'
      const payeeSecret = env.STELLAR_PAYEE_SECRET
      this.ctx.waitUntil(
        this.registerProviderThrottled(supabase, manifest, baseUrl, payeeSecret).catch((err) => {
          console.error('[registry] Failed to register provider-b:', err)
        }),
      )
    }

    const providerUrl = `${env.PUBLIC_BASE_URL ?? 'https://api-b.kikis-app.xyz'}/stream/orderbook`

    const sessionWriters = createSessionWriters(supabase, {
      payee: env.STELLAR_PAYEE_ADDRESS,
      network,
      channelContract,
      providerUrl,
    })

    const sessionStore = this.ctx?.storage
      ? Store.from({
          get: (key: string) => this.ctx.storage.get(key),
          put: (key: string, value: unknown) => this.ctx.storage.put(key, value),
          delete: async (key: string) => { await this.ctx.storage.delete(key) },
        })
      : Store.memory()

    const app = new Hono()

    app.use(
      '*',
      kikisAppHono({
        modes: ['mpp-session', 'mpp-session-ws'],
        pricing: {
          'mpp-session': { rate: SESSION_RATE, channelFactory: channelContract },
          'mpp-session-ws': { rate: SESSION_RATE, channelFactory: channelContract },
        },
        asset: 'USDC',
        assetContract,
        payee: env.STELLAR_PAYEE_ADDRESS,
        network,
        payeeSecretKey: env.STELLAR_PAYEE_SECRET,
        commitmentPublicKey,
        sessionStore,
        manifest,
        ...sessionWriters,
      }),
    )

    // WebSocket transport (mpp-session-ws). Registered before the SSE data
    // route: the kikisAppHono middleware above verifies the handshake's
    // Payment credential (MPP_SESSION_WS_VERIFIED); upgrade requests are
    // answered with 101 here, everything else falls through to the data route.
    const fetchOrderbook = async () => {
      const params = new URLSearchParams({
        selling_asset_type: 'native',
        buying_asset_type: 'credit_alphanum4',
        buying_asset_code: 'USDC',
        buying_asset_issuer: USDC_ISSUERS[networ

/* … truncated 5188 chars — edit only what you need near the top … */
