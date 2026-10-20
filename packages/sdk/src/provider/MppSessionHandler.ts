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

interface ChannelState {
  record: VerifiedVoucherRecord | null
  voucherCount: number
  sessionOpened: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  settledCleanly: boolean
  closeListenerArmed: boolean
  innerStore: ReturnType<typeof Store.memory>
}

export function createMppSessionHandler(opts: MppSessionHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const rateHuman = opts.rate
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const logger = resolveLogger(opts.logger)
  const voucherRecordKey = (channelId: string) => `kikis-app:session:voucher:${channelId}`

  // Session state (record, voucherCount, idleTimer, innerStore) is keyed by
  // channel ID to isolate concurrent sessions and prevent multi-tenant cross-talk (#58).
  const channelStates = new Map<string, ChannelState>()

  function getOrCreateState(channelId: string): ChannelState {
    let state = channelStates.get(channelId)
    if (!state) {
      state = {
        record: null,
        voucherCount: 0,
        sessionOpened: false,
        idleTimer: null,
        settledCleanly: false,
        closeListenerArmed: false,
        innerStore: Store.memory(),
      }
      channelStates.set(channelId, state)
    }
    return state
  }

  function clearIdleTimer(state: ChannelState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer)
      state.idleTimer = null
    }
  }

  function deleteState(channelId: string): void {
    const state = channelStates.get(channelId)
    if (state) {
      clearIdleTimer(state)
      channelStates.delete(channelId)
    }
  }

  function armIdleTimer(channelId: string, state: ChannelState): void {
    if (!opts.idleTimeoutMs) return
    clearIdleTimer(state)
    state.idleTimer = setTimeout(() => {
      void flagOrphan(channelId, state, 'idle-timeout').finally(() => {
        deleteState(channelId)
        mppxInstances.delete(channelId)
      })
    }, opts.idleTimeoutMs)
    if (typeof state.idleTimer.unref === 'function') state.idleTimer.unref()
  }

  async function loadPersistedRecord(channelId: string, state: ChannelState): Promise<VerifiedVoucherRecord | null> {
    if (state.record) return state.record
    try {
      const stored = (await state.innerStore.get(voucherRecordKey(channelId))) as
        | { amount?: string; signature?: string; payer?: string | null; voucherCount?: number }
        | undefined
      if (!stored || typeof stored.amount !== 'string' || typeof stored.signature !== 'string') {
        return null
      }
      state.record = { amount: BigInt(stored.amount), signature: stored.signature, payer: stored.payer ?? null }
      if (typeof stored.voucherCount === 'number' && stored.voucherCount > state.voucherCount) {
        state.voucherCount = stored.voucherCount
      }
    } catch {
      return null
    }
    return state.record
  }

  async function flagOrphan(channelId: string, state: ChannelState, reason: OrphanReason): Promise<void> {
    await loadPersistedRecord(channelId, state)
    if (!state.sessionOpened || state.settledCleanly) return
    state.sessionOpened = false
    state.closeListenerArmed = false
    clearIdleTimer(state)

    const cumulativeAmount = state.record ? (Number(state.record.amount) / 1e7).toFixed(7) : '0.0000000'
    if (opts.onOrphaned) {
      try {
        await opts.onOrphaned(channelId, {
          cumulativeAmount,
          lastSignature: state.record?.signature ?? '',
          voucherCount: state.voucherCount,
          reason,
        })
      } catch (err) {
        logger('error', '[mpp-session] onOrphaned handler failed', { error: err })
      }
    }
  }

  async function commit(channelId: string, state: ChannelState, credential: ChannelVerifyCredential): Promise<void> {
    await loadPersistedRecord(channelId, state)
    const payload = credential.payload
    if (typeof payload?.amount !== 'string' || typeof payload.signature !== 'string') return
    let amount: bigint
    try {
      amount = BigInt(payload.amount)
    } catch {
      return
    }
    if (state.record && amount < state.record.amount) return

    const payer = state.record?.payer ?? extractPayerAddress(credential.source)
    state.record = { amount, signature: payload.signature, payer }
    state.voucherCount++
    await state.innerStore.put(voucherRecordKey(channelId), {
      amount: state.record.amount.toString(),
      signature: state.record.signature,
      payer: state.record.payer,
      voucherCount: state.voucherCount,
    })

    state.settledCleanly = false
    armIdleTimer(channelId, state)

    if (!state.sessionOpened) {
      state.sessionOpened = true
      if (opts.onSessionOpen) {
        Promise.resolve()
          .then(() => opts.onSessionOpen!(channelId, state.record!.payer))
          .catch((err) => {
            logger('error', '[mpp-session] onSessionOpen callback error', { error: err })
            opts.onCallbackError?.(err, 'onSessionOpen')
          })
      }
    }
    if (opts.onVoucher) {
      const humanAmount = (Number(state.record.amount) / 1e7).toFixed(7)
      Promise.resolve()
        .then(() => opts.onVoucher!(channelId, state.voucherCount, humanAmount, state.record!.signature))
        .catch((err) => {
          logger('error', '[mpp-session] onVoucher callback error', { error: err })
          opts.onCallbackError?.(err, 'onVoucher')
        })
    }
  }

  const mppxInstances = new Map<string, unknown>()

  function createChannelStore(state: ChannelState): ChannelStore {
    return {
      async get(key: string) { return state.innerStore.get(key) },
      async put(key: string, value: unknown) { return state.innerStore.put(key, value) },
      async delete(key: string) { return state.innerStore.delete(key) },
      async update(key: string, fn: (prev: unknown) => unknown) {
        const storeWithUpdate = state.innerStore as Partial<ChannelStore>
        if (typeof storeWithUpdate.update === 'function') {
          return storeWithUpdate.update(key, fn)
        }
        throw new Error('Store does not support atomic update operations')
      },
    }
  }

  function getMppxForChannel(channelId: string): unknown {
    let instance = mppxInstances.get(channelId)
    if (!instance) {
      const state = getOrCreateState(channelId)
      const wrappedStore = createChannelStore(state)
      instance = Mppx.create({
        secretKey: opts.payeeSecretKey,
        methods: [
          withTypedChannelErrors(
            onVerifiedCredential(
              stellar.channel({
                channel: channelId,
                commitmentKey: opts.commitmentPublicKey,
                network: networkId,
                store: wrappedStore,
                sourceAccount: payeeKeypair.publicKey(),
                feePayer: channelAuthorizer(payeeKeypair),
              }) as Method.AnyServer,
              (credential) => commit(channelId, state, credential),
            ),
          ),
        ],
      })
      mppxInstances.set(channelId, instance)
    }
    return instance
  }

  // Pre-initialize default channel instance so tests capturing commit at
  // construction time continue working identically.
  getMppxForChannel(opts.channelFactory)

  function extractChannelId(req: Request): string {
    const headerChan = req.headers['x-channel-id'] ?? req.headers['x-channel'] ?? req.headers['channel-id']
    if (typeof headerChan === 'string' && headerChan.trim()) {
      return headerChan.trim()
    }

    if (req.params) {
      const paramChan = req.params.channelId ?? req.params.channel_id ?? req.params.channel
      if (typeof paramChan === 'string' && paramChan.trim()) {
        return paramChan.trim()
      }
    }

    if (req.query) {
      const queryChan = req.query.channelId ?? req.query.channel_id ?? req.query.channel
      if (typeof queryChan === 'string' && queryChan.trim()) {
        return queryChan.trim()
      }
    }

    if (req.body && typeof req.body === 'object') {
      const body = req.body as Record<string, unknown>
      const bodyChan = body.channelId ?? body.channel_id ?? body.channel
      if (typeof bodyChan === 'string' && bodyChan.trim()) {
        return bodyChan.trim()
      }
    }

    const authHeader = req.headers['authorization'] ?? req.headers['payment']
    if (typeof authHeader === 'string') {
      try {
        const match = /(?:Payment|Bearer)?\s*([A-Za-z0-9+/=_-]+)/i.exec(authHeader)
        if (match && match[1]) {
          const decoded = Buffer.from(match[1], 'base64').toString('utf8')
          const parsed = JSON.parse(decoded)
          const credChan = parsed.channel ?? parsed.channelId ?? parsed.payload?.channel
          if (typeof credChan === 'string' && credChan.trim()) {
            return credChan.trim()
          }
        }
      } catch {
        // ignore
      }
    }

    return opts.channelFactory
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const channelId = extractChannelId(req)
    const state = getOrCreateState(channelId)
    const mppx = getMppxForChannel(channelId)

    try {
      if (req.method === 'DELETE') {
        await loadPersistedRecord(channelId, state)
        const body = req.body as { amount?: string; signature?: string } | undefined
        const bodyAmount = body?.amount ? BigInt(body.amount) : 0n
        const recordAmount = state.record?.amount ?? 0n
        let closeAmount: bigint
        let closeSig: string
        if (bodyAmount > recordAmount) {
          closeAmount = bodyAmount
          closeSig = body?.signature ?? state.record?.signature ?? ''
        } else {
          closeAmount = recordAmount
          closeSig = state.record?.signature ?? ''
        }

        if (closeAmount > 0n && closeSig) {
          const closePayer = state.record?.payer ?? null
          const closeTxHash = await channelClose({
            channel: channelId,
            amount: closeAmount,
            signature: Buffer.from(closeSig, 'hex'),
            feePayer: channelAuthorizer(payeeKeypair),
            network: networkId,
          })

          state.settledCleanly = true
          clearIdleTimer(state)

          if (opts.onSettled) {
            const totalPaid = (Number(closeAmount) / 1e7).toFixed(7)
            Promise.resolve()
              .then(() => opts.onSettled!(closeTxHash, totalPaid, opts.mode ?? 'mpp-session', closePayer))
              .catch((err) => {
                logger('error', '[mpp-session] onSettled callback error', { error: err })
                opts.onCallbackError?.(err, 'onSettled')
              })
          }

          const vaultContract = process.env.AGENT_VAULT_CONTRACT
          if (vaultContract) {
            const settlementAddresses = resolveVaultSettlementAddresses(
              vaultContract,
              payeeKeypair.publicKey(),
            )
            if (!settlementAddresses) {
              logger('warn', '[mpp-session] skipped session_settled vault record: payer address unavailable')
            } else {
              try {
                const { Networks } = await import('@stellar/stellar-sdk')
                const { Server } = await import('@stellar/stellar-sdk/rpc')
                const networkPassphrase = opts.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
                const rpcUrl = opts.network === 'mainnet'
                  ? 'https://mainnet.sorobanrpc.com'
                  : 'https://soroban-testnet.stellar.org'
                const server = new Server(rpcUrl)
                const payeePublicKey = payeeKeypair.publicKey()
                const sourceAccount = await server.getAccount(payeePublicKey)
                const tx = buildSessionSettlementTransaction(
                  sourceAccount,
                  vaultContract,
                  channelId,
                  settlementAddresses,
                  closeAmount,
                  state.voucherCount,
                  networkPassphrase,
                )
                const preparedTx = await server.prepareTransaction(tx)
                preparedTx.sign(payeeKeypair)
                await server.sendTransaction(preparedTx)
              } catch (recordErr) {
                logger('error', '[mpp-session] failed to record session_settled on vault', { error: recordErr })
              }
            }
          }

          res.json({ closeTxHash })
        } else {
          res.json({ closeTxHash: null, message: 'no vouchers received' })
        }

        // Clean up per-channel state so memory doesn't grow unboundedly (#58).
        await state.innerStore.delete(voucherRecordKey(channelId))
        deleteState(channelId)
        mppxInstances.delete(channelId)
        return
      }

      const fetchReq = MppxRequest.fromNodeListener(req, res)

      const result = await (mppx as unknown as {
        channel: (o: { amount: string; description?: string }) =>
          (r: globalThis.Request) => Promise<{
            status: number
            challenge?: globalThis.Response
            withReceipt?: (r: globalThis.Response) => globalThis.Response
          }>
      }).channel({
        amount: rateHuman,
        description: opts.manifest.name,
      })(fetchReq)

      if (result.status === 402) {
        const challenge = result.challenge!
        res.status(402)
        challenge.headers.forEach((v: string, k: string) => res.setHeader(k, v))
        const body = await challenge.text()
        res.send(body)
        return
      }

      if (!state.closeListenerArmed) {
        state.closeListenerArmed = true
        req.on('close', () => {
          void flagOrphan(channelId, state, 'connection-closed')
        })
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}
