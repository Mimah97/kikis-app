import { createEd25519Signer, type ClientStellarSigner } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http'
import type { KikisAppManifest, PaymentResult } from '../types.js'
import {
  KikisAppManifestError,
  KikisAppSignatureError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { stroopsToUsdc } from '../internal/usdc.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { prepareHttpRequestInit } from '../internal/http.js'
import { checkX402Accept, filterX402Accepts, type Caip2Network } from './challenge.js'
import type { ModeSelectOptions } from './ModeRouter.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, Caip2Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/**
 * TLS options for facilitator connections. In Node.js environments these are
 * applied via a custom `https.Agent` (custom CA, mTLS client cert/key, and
 * pinned public key hashes). In non-Node environments only `pinnedPublicKeys`
 * is honored (via `fetch`'s `checkServerIdentity`-equivalent is unavailable, so
 * pinning is enforced by the caller's runtime).
 */
export interface FacilitatorTlsOptions {
  /** PEM-encoded CA certificate(s) to trust instead of the system store. */
  ca?: string
  /** PEM-encoded client certificate for mTLS. */
  cert?: string
  /** PEM-encoded client private key for mTLS. */
  key?: string
  /**
   * SHA-256 hashes (hex or base64) of the facilitator's leaf public key.
   * When set, the connection is rejected unless the presented key matches.
   */
  pinnedPublicKeys?: string[]
}

/**
 * Build a Node.js `https.Agent` from facilitator TLS options. Returns
 * `undefined` outside Node.js or when no TLS options are provided, so the
 * default fetch behavior is preserved.
 */
function buildFacilitatorAgent(
  tls: FacilitatorTlsOptions | undefined,
): unknown | undefined {
  if (!tls) return undefined
  const hasOptions =
    tls.ca !== undefined ||
    tls.cert !== undefined ||
    tls.key !== undefined ||
    (tls.pinnedPublicKeys !== undefined && tls.pinnedPublicKeys.length > 0)
  if (!hasOptions) return undefined

  // Only Node.js exposes process.versions.node; browsers/edge runtimes do not.
  const isNode =
    typeof process !== 'undefined' &&
    typeof process.versions !== 'undefined' &&
    typeof process.versions.node === 'string'
  if (!isNode) return undefined

  // Lazy require so bundlers targeting non-Node runtimes don't pull in `https`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('node:https') as typeof import('node:https')
  const crypto = require('node:crypto') as typeof import('node:crypto')

  const agentOptions: import('node:https').AgentOptions = {}
  if (tls.ca !== undefined) agentOptions.ca = tls.ca
  if (tls.cert !== undefined) agentOptions.cert = tls.cert
  if (tls.key !== undefined) agentOptions.key = tls.key

  if (tls.pinnedPublicKeys && tls.pinnedPublicKeys.length > 0) {
    const pins = tls.pinnedPublicKeys.map((p) => p.toLowerCase())
    agentOptions.checkServerIdentity = (_host, cert) => {
      const pubKey = cert.pubkey
      if (!pubKey) {
        return new Error('facilitator TLS: server certificate has no public key')
      }
      const der = pubKey.export({ type: 'spki', format: 'der' }) as Buffer
      const sha256Hex = crypto.createHash('sha256').update(der).digest('hex')
      const sha256B64 = crypto.createHash('sha256').update(der).digest('base64')
      if (pins.includes(sha256Hex) || pins.includes(sha256B64)) {
        return undefined
      }
      return new Error('facilitator TLS: server public key does not match pinned hash')
    }
  }

  return new https.Agent(agentOptions)
}

/** Outcome of the retried unpaid probe. */
type ProbeOutcome =
  | { kind: 'free'; data: unknown }
  | { kind: 'payment-required'; init: Response }

/**
 * Normalize `ModeSelectOptions.headers` (any HeadersInit form) into a plain
 * record. Custom headers never override the `X-PAYMENT` signature header:
 * payment headers are spread after these, so a colliding custom key loses.
 */
function normalizeHeaders(headers: ModeSelectOptions['headers']): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...headers }
}

export interface FacilitatorReceipt {
  txHash?: string
  transaction?: string
  nonce?: string
  network?: string
  timestamp?: number | string
  [key: string]: unknown
}

export class X402Client {
  private readonly httpClient: x402HTTPClient
  private readonly signer: ClientStellarSigner
  private readonly facilitatorAgent: unknown | undefined

  constructor(
    secretKeyOrSigner: string | ClientStellarSigner,
    private readonly network: Network,
    private readonly retryPolicy?: RetryPolicy,
    facilitatorTlsOptions?: FacilitatorTlsOptions,
  ) {
    const caip2 = CAIP2[network]
    this.signer =
      typeof secretKeyOrSigner === 'string'
        ? createEd25519Signer(secretKeyOrSigner, caip2)
        : secretKeyOrSigner
    this.facilitatorAgent = buildFacilitatorAgent(facilitatorTlsOptions)
    const scheme = new ExactStellarScheme(this.signer)
    const core = new x402Client()
    core.register(caip2, scheme)
    this.httpClient = new x402HTTPClient(core)
  }

  /** Replace signer (e.g. swap to Nulth ZK account payer before pay) */
  withSigner(signer: ClientStellarSigner): X402Client {
    return new X402Client(signer, this.network, this.retryPolicy)
  }

  async pay(
    url: string,
    manifest: KikisAppManifest,
    options?: ModeSelectOptions,
  ): Promise<PaymentResult> {
    const pricing = manifest.pricing.x402
    if (!pricing) {
      throw new KikisAppManifestError('manifest.pricing.x402 missing')
    }
    if (!pricing.facilitator) {
      throw new KikisAppManifestError('manifest.pricing.x402.facilitator missing')
    }

    const caip2 = CAIP2[this.network]

    // Phase 1: unpaid probe. This can retry freely — no payment exists yet.
    const probe = await withRetry(async (): Promise<ProbeOutcome> => {
      let init: Response
      const probeHeaders: Record<string, string> = {
        'X-Preferred-Mode': 'x402',
        ...normalizeHeaders(options?.headers),
      }
      try {
        const probeInit = prepareHttpRequestInit(options?.request, { 'X-Preferred-Mode': 'x402' })
        init = await fetch(url, probeInit)
      } catch (err) {
        throw wrapFetchError(err, 'x402 initial request')
      }

      if (init.status !== 402) {
        if (!init.ok) {
          throw httpStatusToError(
            `x402 initial request failed: HTTP ${init.status}`,
            init.status,
            init,
          )
        }
        let data: unknown
        const responseType = options?.responseType ?? 'auto'
        const contentType = init.headers.get('content-type') ?? ''
        if (responseType === 'text' || (responseType === 'auto' && contentType.startsWith('text/'))) {
          data = await init.text()
        } else if (
          responseType === 'arrayBuffer' ||
          responseType === 'blob' ||
          (responseType === 'auto' &&
            (contentType.startsWith('image/') ||
              contentType.includes('application/octet-stream') ||
              contentType.includes('application/pdf')))
        ) {
          data = await init.arrayBuffer()
        } else {
          try {
            data = await init.json()
          } catch {
            throw new KikisAppManifestError(
              `Failed to parse JSON from non-402 response (HTTP ${init.status})`,
            )
          }
        }
        return { kind: 'free', data }
      }

      return { kind: 'payment-required', init }
    }, this.retryPolicy)

    if (probe.kind === 'free') {
      return { data: probe.data, txHash: null, mode: 'x402', amount: '0', timestamp: Date.now() }
    }

    const init = probe.init
    const reqHeader = init.headers.get('X-Payment-Requirements')
    if (!reqHeader) {
      throw new KikisAppManifestError('402 response missing X-Payment-Requirements header')
    }

    let paymentRequired
    try {
      paymentRequired = decodePaymentRequiredHeader(reqHeader)
    } catch (err) {
      throw new KikisAppManifestError('402 X-Payment-Requirements header is malformed', {
        cause: err,
      })
    }

    const firstAccept = paymentRequired.accepts[0]
    if (!firstAccept) {
      throw new KikisAppManifestError('402 response carries no payment accepts')
    }

    // Phase 2: bind the unsigned 402 to the signed manifest BEFORE signing.
    // A mismatched challenge must never reach createPaymentPayload.
    const allowed = filterX402Accepts(paymentRequired.accepts, manifest, caip2, pricing.amount)
    if (allowed.length === 0) {
      // `accepts` is non-empty here, so accepts[0] — the entry the scheme would
      // have signed — failed its own checks. That rejection is the report.
      throw checkX402Accept(firstAccept, manifest, caip2, pricing.amount)
    }

    // Phase 3: sign exactly once per pay() call.
    let paymentPayload
    try {
      paymentPayload = await this.httpClient.createPaymentPayload({
        ...paymentRequired,
        accepts: allowed,
      })
    } catch (err) {
      throw new KikisAppSignatureError(`x402 payment signing failed: ${String(err)}`, {
        cause: err,
      })
    }

    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload)
    const signedAmount = stroopsToUsdc(BigInt(paymentPayload.accepted.amount))

    // Phase 4: paid request. Retries reuse the SAME paymentHeaders object, so
    // the provider's idempotency store can replay the cached settlement rather
    // than charging a second time.
    const settled = await withRetry(async (): Promise<Response> => {
      let response: Response
      const finalHeaders: Record<string, string> = {
        ...normalizeHeaders(options?.headers),
        ...paymentHeaders,
      }
      try {
        const settleInit = prepareHttpRequestInit(options?.request, paymentHeaders)
        response = await fetch(url, settleInit)
      } catch (err) {
        throw wrapFetchError(err, 'x402 settlement request')
      }

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `x402 payment failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw new KikisAppManifestError(`x402 payment failed: HTTP ${response.status}`)
      }

      return response
    }, this.retryPolicy)

    let txHash: string | null = null
    const responseHeader = settled.headers.get('X-Payment-Response')
    if (responseHeader) {
      try {
        const receipt = decodePaymentResponseHeader(responseHeader) as FacilitatorReceipt
        txHash = receipt.txHash ?? receipt.transaction ?? null
      } catch {
        // Receipt decoding is best-effort; settlement already succeeded.
      }
    }

    return {
      data: await settled.json().catch(() => null),
      txHash,
      mode: 'x402',
      amount: signedAmount,
      timestamp: Date.now(),
    }
  }
}
