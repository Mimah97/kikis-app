import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createX402Handler } from './x402Handler.js'
import { createMppChargeHandler } from './MppChargeHandler.js'
import { createMppSessionHandler } from './MppSessionHandler.js'
import { signManifest } from '../manifest/sign.js'
import type { KikisAppManifest, PaymentMode } from '../types.js'
import type { SeenTxStore } from './SeenTxStore.js'
import type { OrphanedSessionInfo } from './MppSessionHandler.js'
import type { KikisAppLogger } from '../internal/logger.js'
import { resolvePaymentMode } from './internal/detectPaymentMode.js'

export interface KikisAppFastifyOptions {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string }
    /** WebSocket transport variant of mpp-session — same channel, WS streaming */
    'mpp-session-ws'?: { rate: string; channelFactory: string }
  }
  asset?: string
  assetContract?: string
  payee: string
  network: 'testnet' | 'mainnet'
  payeeSecretKey: string
  facilitatorApiKey?: string
  commitmentPublicKey?: string
  manifest: KikisAppManifest
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onCallbackError?: (err: unknown, cbName: string) => void
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  idleTimeoutMs?: number
  seenTxStore?: SeenTxStore
  /**
   * Structured log sink for every adapter diagnostic (settlement errors,
   * callback failures, orphaned sessions). Defaults to a console-backed logger.
   */
  logger?: KikisAppLogger
  /**
   * Path for the built-in health probe endpoint. Defaults to `/health`.
   * Set to `false` to disable the endpoint entirely.
   */
  healthPath?: string | false
}

// ---------------------------------------------------------------------------
// Request body buffering
//
// Fastify's request.raw is a Node IncomingMessage stream. Payment verification
// hooks may read from it (or Fastify's own body parser may have already
// consumed it). To guarantee downstream route handlers receive the complete
// payload, we buffer the raw stream once and replay it via a fresh Readable
// that is swapped in for request.raw. The buffered bytes are also exposed as
// request.body when Fastify has not already parsed a body.
// ---------------------------------------------------------------------------

/** Upper bound on buffered request body size (bytes). Guards against unbounded
 * memory use from high-volume streaming payloads. */
const MAX_BUFFERED_BODY_BYTES = 10 * 1024 * 1024

/**
 * Buffer the raw request stream and install a replayable replacement so that
 * both payment verification and the downstream route handler can read the
 * full body. Safe to call multiple times; only buffers once per request.
 */
async function bufferRequestBody(fastifyRequest: FastifyRequest): Promise<void> {
  const raw = fastifyRequest.raw as IncomingMessage & { __kikisBodyBuffered?: boolean }
  if (raw.__kikisBodyBuffered) return
  raw.__kikisBodyBuffered = true

  // If Fastify already parsed a body, the stream is drained; nothing to buffer.
  if (fastifyRequest.body !== undefined && fastifyRequest.body !== null) return

  const method = (raw.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return

  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of raw) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      total += buf.length
      if (total > MAX_BUFFERED_BODY_BYTES) {
        // Refuse to buffer unbounded payloads; leave the stream as-is so the
        // route handler can still consume it directly.
        return
      }
      chunks.push(buf)
    }
  } catch {
    // Stream already consumed or errored — leave it untouched.
    return
  }

  const body = Buffer.concat(chunks)

  // Expose parsed body when possible so Fastify route handlers see it.
  if (body.length > 0 && fastifyRequest.body === undefined) {
    const contentType = String(raw.headers['content-type'] ?? '')
    if (contentType.includes('application/json')) {
      try {
        fastifyRequest.body = JSON.parse(body.toString('utf8'))
      } catch {
        // Not valid JSON — leave body undefined; raw replay still works.
      }
    }
  }

  // Replace the drained stream with a fresh Readable that replays the bytes.
  const { Readable } = await import('node:stream')
  const replay = Readable.from(body.length > 0 ? [body] : [])
  // Preserve the original request metadata the route handler may rely on.
  Object.assign(replay, {
    headers: raw.headers,
    method: raw.method,
    url: raw.url,
    httpVersion: raw.httpVersion,
    socket: raw.socket,
  })
  fastifyRequest.raw = replay as unknown as IncomingMessage
}

// ---------------------------------------------------------------------------
// Express-compatible shim over Node's raw http objects
//
// Fastify's request.raw / reply.raw are plain Node IncomingMessage /
// ServerResponse. The Express-style handlers in this SDK call APIs that only
// exist on Express's extended versions (req.get, req.protocol, req.originalUrl,
// res.status, res.json, res.send, res.setHeader). This function builds a
// minimal shim so those calls work without modifying any handler.
// ---------------------------------------------------------------------------
function buildExpressShims(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  fastifyRequest: FastifyRequest,
  fastifyReply: FastifyReply,
): { req: Request; res: Response } {
  // --- Request shim ---
  const req = rawReq as unknown as Request
  const urlStr = rawReq.url ?? '/'
  const parsedUrl = new URL(urlStr, 'http://placeholder')

  // Express-style header getter
  const reqGet = (name: string): string | undefined => {
    const val = rawReq.headers[name.toLowerCase()]
    return Array.isArray(val) ? val[0] : val
  }

  if (!('get' in req && typeof (req as any).get === 'function')) {
    Object.defineProperty(req, 'get', { value: reqGet, configurable: true })
    Object.defineProperty(req, 'header', { value: reqGet, configurable: true })
  }
  if (!('protocol' in req)) {
    Object.defineProperty(req, 'protocol', {
      get: () => (fastifyRequest.protocol ?? 'http'),
      configurable: true,
    })
  }
  if (!('originalUrl' in req)) {
    Object.defineProperty(req, 'originalUrl', { value: urlStr, configurable: true })
  }
  if (!('path' in req)) {
    Object.defineProperty(req, 'path', { value: parsedUrl.pathname, configurable: true })
  }
  if (!('query' in req)) {
    const q: Record<string, string> = {}
    parsedUrl.searchParams.forEach((v, k) => { q[k] = v })
    Object.defineProperty(req, 'query', { value: q, configurable: true })
  }

  // --- Response shim ---
  // `res` and `rawRes` are the same object: the Express surface is defined
  // directly onto the Node ServerResponse. Capture the native methods before
  // any of them are shadowed, or setHeader/end recurse into themselves.
  const res = rawRes as unknown as Response
  const nativeSetHeader = rawRes.setHeader.bind(rawRes)
  const nativeGetHeader = rawRes.getHeader.bind(rawRes)
  const nativeEnd = rawRes.end.bind(rawRes)

  // Collect headers written via shim and flush at send time
  const extraHeaders: Record<string, string | string[]> = {}

  const resSend = (body?: unknown): Response => {
    if (!rawRes.headersSent) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        nativeSetHeader(k, v)
      }
      if (typeof body === 'string') {
        nativeEnd(body)
      } else if (body !== undefined && body !== null) {
        if (!nativeGetHeader('content-type')) {
          nativeSetHeader('Content-Type', 'application/json')
        }
        nativeEnd(JSON.stringify(body))
      } else {
        nativeEnd()
      }
    }
    return res
  }

  const resJson = (data: unknown): Response => {
    if (!nativeGetHeader('content-type')) {
      nativeSetHeader('Content-Type', 'application/json')
    }
    return resSend(data)
  }

  const resStatus = (code: number): Response => {
    rawRes.statusCode = code
    return res
  }

  const resSet = (field: string | Record<string, string | string[]>, val?: string | string[]): Response => {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) nativeSetHeader(k, v)
    } else if (val !== undefined) {
      extraHeaders[field] = val
      nativeSetHeader(field, val)
    }
    return res
  }

  const resSetHeader = (name: string, value: string | number | readonly string[]): Response => {
    nativeSetHeader(name, value as string)
    return res
  }

  if (!('status' in res && typeof (res as any).status === 'function')) {
    Object.defineProperty(res, 'status', { value: resStatus, configurable: true })
    Object.defineProperty(res, 'json', { value: resJson, configurable: true })
    Object.defineProperty(res, 'send', { value: resSend, configurable: true })
    Object.defineProperty(res, 'set', { value: resSet, configurable: true })
    Object.defineProperty(res, 'setHeader', { value: resSetHeader, configurable: true })
    Object.defineProperty(res, 'end', {
      value: (data?: unknown) => { nativeEnd(data) },
      configurable: true,
    })
  }

  return { req, res }
}

/**
 * Run an Express-style handler against a Fastify request/reply pair.
 *
 * If the handler writes a response directly (e.g. 402 challenge, error, or
 * session DELETE), we hijack the reply so Fastify does not try to serialise
 * a second response. If the handler calls next() without responding (settled
 * payment pass-through), we do not hijack, allowing Fastify to execute the
 * downstream route handler.
 */
function runExpressHandler(
  handler: RequestHandler,
  fastifyRequest: FastifyRequest,
  fastifyReply: FastifyReply,
): Promise<void> {
  const rawRes = fastifyReply.raw
  const { req, res } = buildExpressShims(
    fastifyRequest.raw,
    rawRes,
    fastifyRequest,
    fastifyReply,
  )
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      if (err != null) return reject(err)
      if (rawRes.writableEnded || rawRes.headersSent) fastifyReply.hijack()
      resolve()
    }
    Promise.resolve(handler(req, res, (err?: unknown) => finish(err))).then(() => finish(), finish)
  })
}

/**
 * Context key set by the mpp-session-ws middleware after a request's payment
 * credential has been verified, so the app's WebSocket upgrade route can
 * refuse to upgrade unauthenticated handshakes. Mirrors the Hono adapter's
 * `MPP_SESSION_WS_VERIFIED`.
 */
export const MPP_SESSION_WS_VERIFIED = 'kikis-app.mppSessionWs.verified'

/**
 * True when the kikisAppFastify mpp-session-ws middleware has verified the
 * payment credential for this request.
 */
export function isMppSessionWsVerified(request: FastifyRequest): boolean {
  return (request as any)[MPP_SESSION_WS_VERIFIED] === true
}

/**
 * Fastify plugin that mounts the kikis-app payment middleware.
 *
 * Usage:
 * ```ts
 * import Fastify from 'fastify'
 * import { kikisAppFastify } from '@kikis-app/sdk/provider/fastify'
 *
 * const app = Fastify()
 * await app.register(kikisAppFastify, { ...options })
 * ```
 */
export const kikisAppFastify: FastifyPluginAsync<KikisAppFastifyOptions> = async (
  fastify,
  options,
) => {
  const {
    modes,
    pricing,
    payee,
    network,
    payeeSecretKey,
    facilitatorApiKey,
    commitmentPublicKey,
    manifest,
    onSettled,
    onSessionOpen,
    onVoucher,
    onCallbackError,
    onOrphaned,
    idleTimeoutMs,
    seenTxStore,
    logger,
    healthPath = '/health',
  } = options

  const startedAt = Date.now()

  // -------------------------------------------------------------------------
  // Built-in health probe endpoint (mirrors Express kikisAppMiddleware /health)
  // -------------------------------------------------------------------------
  if (healthPath !== false) {
    fastify.get(healthPath, async (_request, reply) => {
      return reply.code(200).send({
        status: 'ok',
        network,
        payee,
        modesActive: modes,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      })
    })
  }

  // -------------------------------------------------------------------------
  // Payment middleware
  // -------------------------------------------------------------------------
  const x402Handler = createX402Handler({
    pricing: pricing.x402,
    payee,
    network,
    payeeSecretKey,
    facilitatorApiKey,
    asset: options.asset,
    assetContract: options.assetContract,
    onSettled,
    onCallbackError,
    seenTxStore,
    logger,
  })

  const mppChargeHandler = createMppChargeHandler({
    pricing: pricing['mpp-charge'],
    payee,
    network,
    payeeSecretKey,
    commitmentPublicKey,
    onSettled,
    onCallbackError,
    seenTxStore,
    logger,
  })

  const mppSessionHandler = createMppSessionHandler({
    pricing: pricing['mpp-session'],
    payee,
    network,
    payeeSecretKey,
    commitmentPublicKey,
    onSessionOpen,
    onVoucher,
    onOrphaned,
    idleTimeoutMs,
    logger,
  })

  fastify.addHook('onRequest', async (request, reply) => {
    const mode = resolvePaymentMode(request.headers as Record<string, string | undefined>, modes)
    if (mode === 'x402') {
      await runExpressHandler(x402Handler, request, reply)
    } else if (mode === 'mpp-charge') {
      await runExpressHandler(mppChargeHandler, request, reply)
    } else if (mode === 'mpp-session') {
      await runExpressHandler(mppSessionHandler, request, reply)
    }
  })

  // Expose the signed manifest at a well-known route
  fastify.get('/.well-known/kikis-app.json', async (_request, reply) => {
    const signed = await signManifest(manifest, payeeSecretKey)
    return reply.code(200).send(signed)
  })
}
