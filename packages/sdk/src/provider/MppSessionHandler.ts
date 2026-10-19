import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { stellar, close as channelClose, Store } from '@stellar/mpp/channel/server'
import { Mppx, Request as MppxRequest } from 'mppx/server'
import { Store as MppxStore } from 'mppx'
import type { KikisAppManifest } from '../types.js'
import { buildSessionSettlementTransaction, resolveVaultSettlementAddresses } from './internal/vaultSettlement.js'
import { extractPayerAddress } from './payer.js'
import {
  channelAuthorizer,
  onVerifiedCredential,
  withTypedChannelErrors,
  type ChannelVerifyCredential,
} from './mppCompatibility.js'
import type { Method } from 'mppx'
import { resolveLogger, type KikisAppLogger } from '../internal/logger.js'

/** Store shape extended with optional atomic update operation. */
export type ChannelStore = MppxStore.Store & {
  update?: (key: string, fn: (prev: unknown) => unknown) => Promise<unknown>
}

/** Expected payload shape for voucher cumulative amount entries. */
export interface VoucherStoreValue {
  amount: string
  [key: string]: unknown
}

/** Validates that a stored store value is an object containing a numeric string amount. */
export function isVoucherStoreValue(value: unknown): value is VoucherStoreValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.amount === 'string' && /^\d+$/.test(candidate.amount)
}

/** The last verified voucher: amount, its signature, and the payer it named. */
interface VerifiedVoucherRecord {
  amount: bigint
  signature: string
  payer: string | null
}

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/** Why a live session was flagged as orphaned (never cleanly closed). */
export type OrphanReason = 'connection-closed' | 'idle-timeout'

/** Latest signed state of an orphaned session, enough for the reconciler to settle. */
export interface OrphanedSessionInfo {
  /** Cumulative amount of the highest voucher seen (human-readable, 7 dp). */
  cumulativeAmount: string
  /** Hex-encoded signature of the highest voucher seen. */
  lastSignature: string
  /** Number of vouchers received before teardown. */
  voucherCount: number
  /** What triggered the orphan flag. */
  reason: OrphanReason
}

export interface MppSessionHandlerOptions {
  payeeSecretKey: string
  network: Network
  channelFactory: string
  rate: string
  assetContract?: string
  manifest: KikisAppManifest
  commitmentPublicKey: string
  /**
   * Transport this handler serves, reported to `onSettled` when the channel is
   * closed. Defaults to 'mpp-session'; the Fastify adapter passes
   * 'mpp-session-ws' when the WebSocket transport is the provider's primary
   * session mode (mirrors the Hono adapter's shared session state).
   */
  mode?: 'mpp-session' | 'mpp-session-ws'
  /**
   * Externally-owned store for channel session state. Inject a durable
   * backend (Redis, Supabase, etc.) to survive multi-process clusters and
   * restarts. Defaults to a fresh in-memory store when omitted.
   */
  sessionStore?: ChannelStore
  onSettled?: (txHash: string, totalPaid: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onCallbackError?: (err: unknown, cb: string) => void
  /**
   * Called when the client connection drops mid-session or the session goes
   * idle, before a clean close. Persist the session as `closing` so the
   * SessionReconciler can settle it with the latest signed voucher.
   */
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  /**
   * Flag the session orphaned after this many milliseconds with no voucher
   * activity. Disabled when unset.
   */
  idleTimeoutMs?: number
  /** Log sink for internal error paths. Defaults to a console-backed logger. */
  logger?: KikisAppLogger
}

export function createMppSessionHandler(opts: MppSessionHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const rateHuman = opts.rate
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const logger = resolveLogger(opts.logger)
  const voucherRecordKey = `kikis-app:session:voucher:${opts.channelFactory}`

  const innerStore = opts.sessionStore ?? Store.memory()

  // The last voucher mppx actually verified — amount, its signature, and the
  // payer it named. Only `commit` (called after a successful verify) may set
  // this; nothing derived from an unverified header may reach it.
  let record: VerifiedVoucherRecord | null = null
  let voucherCount = 0
  let sessionOpened = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // Set once a session is settled via DELETE so teardown handlers don't
  // re-flag an already-closed session as orphaned.
  let settledCleanly = false
  // Guards against registering more than one 'close' listener per session.
  let closeListenerArmed = false

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdleTimer(): void {
    if (!opts.idleTimeoutMs) return
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      void flagOrphan('idle-timeout')
    }, opts.idleTimeoutMs)
    // Don't keep the process alive solely for this timer.
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  // `innerStore` is either an injected externally-owned store (via
  // `opts.sessionStore`) or a fresh `Store.memory()` created inside this
  // closure. When injected, the store survives this handler being evicted and
  // recreated (multi-process clusters, restarts); otherwise `record` and
  // `innerStore` are lost together. This re-read protects against `record`
  // and `innerStore` disagreeing within a single handler's lifetime, and
  // restores persisted state across restarts when a durable store is injected.
  // Never overwrites an in-memory record that is already set. The persisted
  // voucherCount is restored with it so the counters the DELETE close path and
  // orphan reporting rely on survive the restart too (#52).
  async function loadPersistedRecord(): Promise<VerifiedVoucherRecord | null> {
    if (record) return record
    try {
      const stored = (await innerStore.get(voucherRecordKey)) as
        | { amount?: string; signature?: string; payer?: string | null; voucherCount?: number }
        | undefined
      if (!stored || typeof stored.amount !== 'string' || typeof stored.signature !== 'string') {
        return null
      }
      record = { amount: BigInt(stored.amount), signature: stored.signature, payer: stored.payer ?? null }
      if (typeof stored.voucherCount === 'number' && stored.voucherCount > voucherCount) {
        voucherCount = stored.voucherCount
      }
    } catch {
      // Corrupt or unreadable persisted record — proceed as though there is none.
      return null
    }
    return record
  }

  // Flag an open-but-unsettled session for the reconciler. Idempotent: a
  // session that was cleanly settled or already flagged is left untouched.
  async function flagOrphan(reason: OrphanReason): Promise<void> {
    await loadPersistedRecord()
    if (!sessionOpened || settledCleanly) return
    sessionOpened = false
    closeListenerArmed = false
    clearIdleTimer()

    const cumulativeAmount = record ? (Number(record.amount) / 1e7).toFixed(7) : '0.0000000'
    if (opts.onOrphaned) {
      try {
        await opts.onOrphaned(opts.channelFactory, {
          cumulativeAmount,
          lastSignature: record?.signature ?? '',
          voucherCount,
          reason,
        })
      } catch (err) {
        logger('error', '[mpp-session] onOrphaned handler failed', { error: err })
      }
    }
  }

  const wrappedStore: ChannelStore = {
    async get(key: string) { return innerStore.get(key) },
    async put(key: string, value: unknown) { return innerStore.put(key, value) },
    async delete(key: string) { return innerStore.delete(key) },
    ...(innerStore.update ? { update: innerStore.update.bind(innerStore) } : {}),
  }

  const mppx = Mppx.create({
    methods: [
      stellar.channel({
        channelFactory: opts.channelFactory,
        commitmentPublicKey: opts.commitmentPublicKey,
        network: networkId,
        rate: rateHuman,
        assetContract: opts.assetContract,
        store: wrappedStore,
        authorize: channelAuthorizer(payeeKeypair),
        onVerifiedCredential: onVerifiedCredential(async (credential: ChannelVerifyCredential) => {
          const payer = extractPayerAddress(credential)
          const amount = BigInt(credential.payload.amount)
          record = { amount, signature: credential.signature, payer }
          voucherCount += 1
          await innerStore.put(voucherRecordKey, {
            amount: amount.toString(),
            signature: credential.signature,
            payer,
            voucherCount,
          })
          if (opts.onVoucher) {
            try {
              await opts.onVoucher(opts.channelFactory, voucherCount, (Number(amount) / 1e7).toFixed(7), credential.signature)
            } catch (err) {
              opts.onCallbackError?.(err, 'onVoucher')
            }
          }
        }),
      }),
    ],
  })

  const handler: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      await loadPersistedRecord()
      if (!sessionOpened) {
        sessionOpened = true
        if (opts.onSessionOpen) {
          try {
            await opts.onSessionOpen(opts.channelFactory, record?.payer ?? null)
          } catch (err) {
            opts.onCallbackError?.(err, 'onSessionOpen')
          }
        }
      }
      armIdleTimer()

      if (req.method === 'DELETE') {
        settledCleanly = true
        clearIdleTimer()
        const totalPaid = record ? (Number(record.amount) / 1e7).toFixed(7) : '0.0000000'
        const payer = record?.payer ?? null
        const settlement = await buildSessionSettlementTransaction({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          channelFactory: opts.channelFactory,
          commitmentPublicKey: opts.commitmentPublicKey,
          assetContract: opts.assetContract,
          manifest: opts.manifest,
          cumulativeAmount: record?.amount ?? 0n,
          lastSignature: record?.signature ?? '',
          payer,
        })
        const addresses = resolveVaultSettlementAddresses(opts.manifest)
        void addresses
        const txHash = await channelClose(settlement)
        if (opts.onSettled) {
          try {
            await opts.onSettled(txHash, totalPaid, opts.mode ?? 'mpp-session', payer)
          } catch (err) {
            opts.onCallbackError?.(err, 'onSettled')
          }
        }
        res.status(200).json({ txHash, totalPaid })
        return
      }

      const mppxReq = new MppxRequest({
        method: req.method,
        url: req.originalUrl ?? req.url,
        headers: req.headers as Record<string, string>,
        body: req.body,
      })
      const result = await withTypedChannelErrors(() => mppx.handle(mppxReq))
      if (result.status === 402) {
        res.status(402)
        for (const [key, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(key, value as string)
        }
        res.send(result.body ?? '')
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }

  return handler
}
