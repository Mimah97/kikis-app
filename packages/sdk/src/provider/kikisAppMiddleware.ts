import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createX402Handler } from './x402Handler.js'
import { createMppChargeHandler } from './MppChargeHandler.js'
import { createMppSessionHandler } from './MppSessionHandler.js'
import type { KikisAppManifest, PaymentMode } from '../types.js'
import { signManifest } from '../manifest/sign.js'
import type { SeenTxStore } from './SeenTxStore.js'
import type { OrphanedSessionInfo } from './MppSessionHandler.js'
import type { ChannelStore } from './ChannelStore.js'
import type { KikisAppLogger } from '../internal/logger.js'
import { resolvePaymentMode } from './internal/detectPaymentMode.js'

export interface KikisAppMiddlewareOptions {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string }
  }
  asset?: string
  /** Stellar Asset Contract address for the payment asset */
  assetContract?: string
  payee: string
  network: 'testnet' | 'mainnet'
  /** Private key (S...) of the server/payee account */
  payeeSecretKey: string
  /** Required for x402 mode */
  facilitatorApiKey?: string
  /** Required for mpp-session mode — ed25519 public key (G...) for verifying commitments */
  commitmentPublicKey?: string
  /** Full KikisApp manifest — served at /.well-known/kikis-app.json */
  manifest: KikisAppManifest
  /**
   * Called after each successful on-chain settlement.
   * `payer` is the Stellar G... public key of the agent that paid.
   * May be `null` if the payer address could not be extracted from the payment headers.
   */
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  /**
   * Called when a new mpp-session is opened (first voucher received).
   * `payer` is the Stellar G... public key of the agent that opened the channel.
   * May be `null` if the payer address could not be extracted.
   */
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  /** Called after each verified voucher in an mpp-session */
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  /** Called if any of the above callbacks throw an error */
  onCallbackError?: (err: unknown, cbName: string) => void
  /**
   * Called when an mpp-session connection drops or goes idle before a clean
   * close. Persist the session as `closing` for the SessionReconciler.
   */
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  /** Idle timeout (ms) after which an mpp-session is flagged orphaned. */
  idleTimeoutMs?: number
  /**
   * Idempotency store shared by the x402 and mpp-charge handlers to dedupe
   * duplicate settlement on agent retries. Defaults to per-handler in-memory.
   */
  seenTxStore?: SeenTxStore
  /**
   * Durable channel store for mpp-session state (e.g. Redis, Supabase).
   * Defaults to an in-memory store when omitted.
   */
  sessionStore?: ChannelStore
  /**
   * Structured log sink for every adapter diagnostic (settlement errors,
   * callback failures, orphaned sessions). Defaults to a console-backed logger.
   */
  logger?: KikisAppLogger
}

/**
 * Express middleware factory for KikisApp provider endpoints.
 *
 * Automatically serves /.well-known/kikis-app.json and enforces payment
 * verification for all three modes (x402, mpp-charge, mpp-session).
 *
 * @example
 * ```ts
 * import { kikisApp } from '@kikis-app/sdk/provider'
 *
 * app.use('/price', kikisApp({
 *   modes: ['x402', 'mpp-charge'],
 *   pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
 *   ...
 * }))
 * ```
 */
export function kikisApp(opts: KikisAppMiddlewareOptions): RequestHandler {
  const startTime = Date.now()
  const signedManifest = signManifest(opts.manifest, opts.payeeSecretKey)

  // Register each handler under its payment mode so routing is explicit and
  // never depends on insertion order.
  const handlerMap = new Map<PaymentMode, RequestHandler>()

  if (opts.modes.includes('x402')) {
    const x402Price = opts.pricing.x402
    if (x402Price) {
      handlerMap.set(
        'x402',
        createX402Handler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          amount: x402Price,
          ...(opts.assetContract ? { assetContract: opts.assetContract } : {}),
          ...(opts.facilitatorApiKey ? { facilitatorApiKey: opts.facilitatorApiKey } : {}),
          manifest: signedManifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.seenTxStore ? { seenTxStore: opts.seenTxStore } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        }),
      )
    }
  }

  if (opts.modes.includes('mpp-charge')) {
    const chargePrice = opts.pricing['mpp-charge']
    if (chargePrice) {
      handlerMap.set(
        'mpp-charge',
        createMppChargeHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          amount: chargePrice,
          ...(opts.assetContract ? { assetContract: opts.assetContract } : {}),
          manifest: signedManifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.seenTxStore ? { seenTxStore: opts.seenTxStore } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        }),
      )
    }
  }

  if (opts.modes.includes('mpp-session')) {
    const sessionPricing = opts.pricing['mpp-session']
    if (sessionPricing) {
      if (!opts.commitmentPublicKey) {
        throw new Error('kikis-app: mpp-session mode requires commitmentPublicKey')
      }
      handlerMap.set(
        'mpp-session',
        createMppSessionHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          channelFactory: sessionPricing.channelFactory,
          rate: sessionPricing.rate,
          ...(opts.assetContract ? { assetContract: opts.assetContract } : {}),
          manifest: signedManifest,
          commitmentPublicKey: opts.commitmentPublicKey,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onSessionOpen ? { onSessionOpen: opts.onSessionOpen } : {}),
          ...(opts.onVoucher ? { onVoucher: opts.onVoucher } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.onOrphaned ? { onOrphaned: opts.onOrphaned } : {}),
          ...(opts.idleTimeoutMs != null ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
          ...(opts.sessionStore ? { sessionStore: opts.sessionStore } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        }),
      )
    }
  }

  // Modes this provider actually registered — routing resolves against this
  // set, so a mode that was never configured can never be selected.
  const availableModes = new Set(handlerMap.keys())

  return (req: Request, res: Response, next: NextFunction): void => {
    // Serve signed manifest at /.well-known/kikis-app.json
    if (req.path === '/.well-known/kikis-app.json') {
      res.json(signedManifest)
      return
    }

    // Serve health check endpoint
    if (req.path === '/health') {
      res.json({
        status: 'ok',
        'kikis-app': opts.manifest['kikis-app'],
        network: opts.network,
        payee: opts.payee,
        modesActive: opts.modes,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      })
      return
    }

    // No handlers — pass through
    if (handlerMap.size === 0) {
      next()
      return
    }

    // Route by mode, not by priority (#44). An mpp-charge credential
    // (`Authorization: Payment ...` issued for the charge intent) or an
    // explicit `x-preferred-mode: mpp-charge` must reach the charge handler
    // even when mpp-session is also enabled — otherwise every non-x402
    // request was answered with a session challenge and charge clients could
    // not pay dual-mode providers. x402 clients keep routing by
    // `payment-signature` / `x-payment`; unauthenticated requests still
    // receive the default challenge (session, the

/* … truncated 669 chars — edit only what you need near the top … */
