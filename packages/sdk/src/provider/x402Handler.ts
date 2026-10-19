import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from '@x402/stellar/exact/facilitator'
import { ExactStellarScheme as ExactStellarServerScheme } from '@x402/stellar/exact/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import { createEd25519Signer } from '@x402/stellar'
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { Network as X402Network } from '@x402/core/types'
import type { KikisAppManifest } from '../types.js'
import { KikisAppManifestError, KikisAppNetworkError } from '../errors.js'
import { resolvePayee } from '../internal/payee.js'
import { usdcToUnits } from '../internal/usdc.js'
import { extractPayerAddress } from './payer.js'
import { resolveAssetContract } from '../internal/assetUtils.js'
import { resolveLogger, type KikisAppLogger } from '../internal/logger.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  checkSettlementReplay,
  type SeenTxStore,
} from './SeenTxStore.js'
import { readSettleResult } from './settleResult.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, X402Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

const OZ_FACILITATOR_URL = 'https://channels.openzeppelin.com/x402'

export interface X402HandlerOptions {
  payeeSecretKey: string
  network: Network
  amount: string
  assetContract?: string
  facilitatorApiKey?: string
  manifest: KikisAppManifest
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onCallbackError?: (err: unknown, cb: string) => void
  /**
   * Idempotency store guarding against duplicate settlement when an agent
   * retries the same signed payment. Defaults to a per-handler in-memory store.
   */
  seenTxStore?: SeenTxStore
  /** Optional secondary fallback store when seenTxStore is unavailable. */
  fallbackSeenTxStore?: SeenTxStore
  /** Log sink for internal error paths. Defaults to a console-backed logger. */
  logger?: KikisAppLogger
}

export function createX402Handler(opts: X402HandlerOptions): RequestHandler {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)
  const logger = resolveLogger(opts.logger)
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore({ logger })

  const useOzFacilitator = opts.network === 'mainnet' && opts.facilitatorApiKey

  // Mainnet: OZ hosted facilitator via x402ResourceServer
  // Testnet: local ExactStellarFacilitatorScheme (OZ facilitator does not serve testnet)
  const localFacilitator = new ExactStellarFacilitatorScheme([signer], {
    areFeesSponsored: true,
  })

  let ozServer: x402ResourceServer | null = null
  if (useOzFacilitator) {
    const apiKey = opts.facilitatorApiKey!
    const facilitator = new HTTPFacilitatorClient({
      url: OZ_FACILITATOR_URL,
      createAuthHeaders: async () => ({
        verify: { Authorization: `Bearer ${apiKey}` },
        settle: { Authorization: `Bearer ${apiKey}` },
        supported: { Authorization: `Bearer ${apiKey}` },
      }),
    })
    ozServer = new x402ResourceServer(facilitator)
    ozServer.register(caip2, new ExactStellarServerScheme())
  }

  const amountInBaseUnits = String(usdcToUnits(opts.amount))
  const payTo = resolvePayee(opts.manifest, 'x402')

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const endpoint = req.path || req.originalUrl
      const assetContract = resolveAssetContract(
        opts.manifest,
        'x402',
        endpoint,
        opts.assetContract,
      )
      const requirements = {
        scheme: 'exact' as const,
        network: caip2,
        asset: assetContract,
        amount: amountInBaseUnits,
        payTo,
        maxTimeoutSeconds: 60,
        extra: {
          areFeesSponsored: true,
          ...(useOzFacilitator ? {} : { facilitatorAddresses: [payeeKeypair.publicKey()] }),
        },
      }

      // Shared unpaid/failed-settlement response: it always carries the same
      // payment requirements header an unpaid request would, so the agent can
      // retry, and never an X-Payment-Response header. It is defined here
      // because the requirements depend on the asset contract resolved for this
      // request's endpoint.
      const respondPaymentRequired = async (error: string, reason?: string): Promise<void> => {
        const body = { error, ...(reason ? { reason } : {}) }
        if (ozServer) {
          const resourceInfo = {
            url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
            description: opts.manifest.name,
          }
          const paymentRequired = await ozServer.createPaymentRequiredResponse(
            [requirements],
            resourceInfo,
          )
          res
            .status(402)
            .setHeader('Content-Type', 'application/json')
            .setHeader('X-Payment-Requirements', encodePaymentRequiredHeader(paymentRequired))
            .json(body)
        } else {
          const x402Response = {
            x402Version: 2,
            resource: {
              url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
              description: opts.manifest.name,
            },
            accepts: [requirements],
          }
          res
            .status(402)
            .setHeader('Content-Type', 'application/json')
            .setHeader('X-Payment-Requirements', encodePaymentRequiredHeader(x402Response))
            .json(body)
        }
      }

      // Malformed payment header response: HTTP 400 with a typed error body and
      // fresh payment requirements so the client can retry with a valid header.
      // Never leaks internal stack traces.
      const respondMalformedHeader = async (): Promise<void> => {
        const body = { error: 'malformed_payment_header' }
        if (ozServer) {
          const resourceInfo = {
            url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
            description: opts.manifest.name,
          }
          const paymentRequired = await ozServer.createPaymentRequiredResponse(
            [requirements],
            resourceInfo,
          )
          res
            .status(400)
            .setHeader('Content-Type', 'application/json')
            .setHeader('X-Payment-Requirements', encodePaymentRequiredHeader(paymentRequired))
            .json(body)
        } else {
          const x402Response = {
            x402Version: 2,
            resource: {
              url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
              description: opts.manifest.name,
            },
            accepts: [requirements],
          }
          res
            .status(400)
            .setHeader('Content-Type', 'application/json')
            .setHeader('X-Payment-Requirements', encodePaymentRequiredHeader(x402Response))
            .json(body)
        }
      }

      const paymentHeader = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined

      if (!paymentHeader) {
        await respondPaymentRequired('Payment Required')
        return
      }

      // Idempotency: a retry of an already-settled payment replays the cached
      // settlement response instead of settling (and billing) a second time.
      // The key is scoped to this route so a payment settled elsewhere can
      // never replay here, and replays are capped + time-bounded.
      const idempotencyKey = await paymentIdempotencyKey(
        (name) => {
          const v = req.headers[name.toLowerCase()]
          return Array.isArray(v) ? v[0] : (v as string | undefined)
        },
        {
          method: req.method,
          path: req.originalUrl.split('?')[0]!,
          amount: requirements.amount,
          payTo: requirements.payTo,
        },
      )
      if (idempotencyKey) {
        const replayCheck = await checkSettlementReplay(seenTxStore, idempotencyKey, Date.now(), {
          fallbackStore: opts.fallbackSeenTxStore,
          logger: opts.logger,
        })
        if (replayCheck.kind === 'unavailable') {
          res.setHeader('Retry-After', '5')
          res.status(503).json({ error: 'Idempotency store unavailable', reason: replayCheck.error.message })
          return
        }
        if (replayCheck.kind === 'spent') {
          res.status(402).json({ error: 'Payment already used' })
          return
        }
        if (replayCheck.kind === 'replay') {
          if (replayCheck.record.headers) {
            for (const [k, val] of Object.entries(replayCheck.record.headers)) {
              res.setHeader(k, val)
            }
          }
          next()
          return
        }
      }

      // Decode the payment-signature header defensively. Malformed base64,
      // truncated JSON, or unexpected types must not crash the process; they
      // are surfaced as a clean 400 with fresh payment requirements.
      let payload: ReturnType<typeof decodePaymentSignatureHeader>
      try {
        payload = decodePaymentSignatureHeader(paymentHeader)
      } catch (err) {
        logger.warn?.('malformed payment-signature header', err)
        await respondMalformedHeader()
        return
      }

      let txHash: string | null = null
      // Extract payer public key defensively from the decoded x402 payload.
      // In the @x402/stellar ExactStellarScheme, the payer's G... address is at
      // payload.authorization.credentials[0].publicKey (StrKey-encoded G...).
      // Fall back to null if the path is absent — non-fatal 
