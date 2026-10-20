/**
 * KikisApp Reference Agent — Phase 4
 *
 * Runs the full autonomous payment sequence from Section 10.1 of
 * KIKIS_APP_MASTER.md against live provider services on Stellar testnet.
 *
 * Run sequence:
 *   1. Initialize — derive keypair, log balance
 *   2. x402 discrete query (forced mode)
 *   3. MPP charge query (natural mode selection)
 *   4. MPP session — open + 50 SSE events + close (KEY DEMO: 50 interactions, 2 tx)
 *   5. Policy rejection — spend cap enforced locally, nothing broadcast
 *   6. Summary log + write agent/RUN_RESULTS.md
 *
 * WARNING: The mpp-session path uses stellar-experimental/one-way-channel,
 * an UNAUDITED contract. Do not use in production without an independent audit.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Keypair } from '@stellar/stellar-sdk'
import { Horizon } from '@stellar/stellar-sdk'
import { KikisAppClient, FileSpendStore, KikisAppPolicyRejectError, KikisAppTrustlineError } from '@kikis-app/kikis-app'

// ── Config ────────────────────────────────────────────────────────────────────

const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''
const PROVIDER_A_URL = (process.env['PROVIDER_A_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const PROVIDER_B_URL = (process.env['PROVIDER_B_URL'] ?? 'http://localhost:3002').replace(/\/$/, '')
const AGENT_DAILY_CAP_USDC = process.env['AGENT_DAILY_CAP_USDC'] ?? '0.002'
const COMMITMENT_SECRET = process.env['COMMITMENT_SECRET'] ?? ''
const AGENT_SPEND_STORE_PATH =
  process.env['AGENT_SPEND_STORE_PATH'] ??
  process.env['KIKIS_APP_SPEND_STORE_PATH'] ??
  path.join(os.homedir(), '.kikis-app', 'spend.json')

const HORIZON_URL =
  STELLAR_NETWORK === 'testnet'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org'

const EXPLORER_BASE = `https://stellar.expert/explorer/${STELLAR_NETWORK}/tx`

// ── Logging ───────────────────────────────────────────────────────────────────

function log(step: string, msg: string): void {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [${step}] ${msg}`)
}

function explorerLink(txHash: string): string {
  return `${EXPLORER_BASE}/${txHash}`
}

type AgentSession = Awaited<ReturnType<KikisAppClient['openSession']>>
type CloseResult = Awaited<ReturnType<AgentSession['close']>>

// ── Session registry & graceful shutdown ──────────────────────────────────────

const SESSION_CLOSE_TIMEOUT_MS = 5_000

const activeSessions = new Set<AgentSession>()
let shuttingDown = false

function trackSession(session: AgentSession): AgentSession {
  activeSessions.add(session)
  return session
}

function untrackSession(session: AgentSession): void {
  activeSessions.delete(session)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function closeSession(session: AgentSession, reason: string): Promise<CloseResult | null> {
  if (!activeSessions.has(session)) return null
  log('mpp-session', `Closing active session ${session.channelId} (${reason})...`)
  try {
    const result = await withTimeout(session.close(), SESSION_CLOSE_TIMEOUT_MS, 'session.close()')
    log('mpp-session', `Session ${session.channelId} closed. closeTxHash: ${result.closeTxHash ?? 'n/a'}`)
    if (result.closeTxHash) {
      log('mpp-session', `Channel close explorer: ${explorerLink(result.closeTxHash)}`)
    }
    return result
  } catch (err) {
    console.error(`[Agent] Failed to close session ${session.channelId} (${reason}):`, err)
    return null
  } finally {
    untrackSession(session)
  }
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  const sessions = Array.from(activeSessions)
  if (sessions.length === 0) {
    log('shutdown', `No active sessions to close (${reason}).`)
    process.exit(exitCode)
  }

  log('shutdown', `Closing ${sessions.length} active session(s) (${reason})...`)
  const results = await Promise.all(sessions.map((s) => closeSession(s, reason)))

  const recovered = results.filter((r): r is CloseResult => r !== null)
  log('shutdown', `Recovered ${recovered.length}/${sessions.length} session(s).`)
  for (const r of recovered) {
    log('shutdown', `  channel ${r.channelId} closeTxHash: ${r.closeTxHash ?? 'n/a'}`)
  }

  process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal, 0)
  })
}

process.once('uncaughtException', (err) => {
  console.error('[Agent] Uncaught exception:', err)
  void shutdown('uncaughtException', 1)
})

process.once('unhandledRejection', (reason) => {
  console.error('[Agent] Unhandled rejection:', reason)
  void shutdown('unhandledRejection', 1)
})

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Step 1: Initialize ────────────────────────────────────────────────────

  if (!AGENT_SECRET || !AGENT_SECRET.startsWith('S')) {
    console.error('FATAL: AGENT_SECRET is required and must be a valid Stellar secret key (S...)')
    process.exit(1)
  }

  const keypair = Keypair.fromSecret(AGENT_SECRET)
  const agentAddress = keypair.publicKey()

  const spendStore = new FileSpendStore(AGENT_SPEND_STORE_PATH)

  const client = new KikisAppClient({
    wallet: keypair,
    network: STELLAR_NETWORK,
    spendCap: { daily: AGENT_DAILY_CAP_USDC, asset: 'USDC' },
    spendStore,
    commitmentSecret: COMMITMENT_SECRET || undefined,
  })

  // Fetch USDC balance from Horizon — also serves as an early trustline check
  const horizonServer = new Horizon.Server(HORIZON_URL)
  let startingBalance = '0'
  let trustlineFound = false
  try {
    const account = await horizonServer.loadAccount(agentAddress)
    const usdcBalance = account.balances.find(
      (b) => 'asset_code' in b && b.asset_code === 'USDC',
    )
    if (usdcBalance) {
      startingBalance = usdcBalance.balance
      trustlineFound = true
    } else {
      log('Init', 'WARNING: No USDC trustline found — first payment will fail with KikisAppTrustlineError')
      log('Init', '  Create one: stellar tx new --source <SECRET_KEY> --network mainnet change-trust --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --limit 100000')
    }
  } catch (err) {
    log('Init', 'Warning: could not fetch balance from Horizon — continuing')
  }

  log('Init', `[KikisApp Agent] Started. Address: ${agentAddress} Balance: ${startingBalance} USDC`)
  log('Init', `Network: ${STELLAR_NETWORK}, DailyCap: ${AGENT_DAILY_CAP_USDC} USDC`)
  log('Init', `SpendStore: FileSpendStore (${AGENT_SPEND_STORE_PATH})`)
  log('Init', `Provider A: ${PROVIDER_A_URL}`)
  log('Init', `Provider B: ${PROVIDER_B_URL}`)

  const txHashes: {
    x402?: string
    mppCharge?: string
    channelOpen?: string
    channelClose?: string
  } = {}
  let closeResult: CloseResult | null = null

  // ── Step 2: x402 discrete query ───────────────────────────────────────────

  log('x402', 'Querying price endpoint with forced x402 mode...')
  const x402Result = await client.pay(`${PROVIDER_A_URL}/price`, { forceMode: 'x402' })

  if (!x402Result.txHash) {
    throw new Error(`x402 payment returned null txHash — settlement did not complete`)
  }

  txHashes.x402 = x402Result.txHash
  log('x402', `mode=${x402Result.mode} txHash=${x402Result.txHash} amount=${x402Result.amount}`)
  log('x402', `price=${JSON.stringify((x402Result.data as { price?: string })?.price)}`)
  log('x402', `explorer: ${explorerLink(x402Result.txHash)}`)

  // ── Step 3: MPP charge query ──────────────────────────────────────────────

  log('mpp-charge', 'Querying price endpoint (natural mode selection → mpp-charge)...')
  const chargeResult = await client.pay(`${PROVIDER_A_URL}/price`)

  log('mpp-charge', `mode=${chargeResult.mode} txHash=${chargeResult.txHash ?? 'null'} amount=${chargeResult.amount}`)
  log('mpp-charge', `price=${JSON.stringify((chargeResult.data as { price?: string })?.price)}`)
  if (chargeResult.txHash) {
    txHashes.mppCharge = chargeResult.txHash
    log('mpp-charge', `explorer: ${explorerLink(chargeResult.txHash)}`)
  }

  // ── Step 4: MPP session streaming ─────────────────────────────────────────
  log('mpp-session', 'Opening MPP session channel...')
  const session = trackSession(await client.openSession(`${PROVIDER_B_URL}/stream/orderbook`))

  if (session.openTxHash) {
    txHashes.channelOpen = session.openTxHash
  }
  log('mpp-session', `[Session] Opened. Channel: ${session.channelId} openTxHash: ${session.openTxHash ?? 'n/a (pre-deployed channel)'}`)
  if (session.openTxHash) {
    log('mpp-session', `Channel open explorer: ${explorerLink(session.openTxHash)}`)
  }

  // Consume exactly 50 SSE events from the session stream
  const TARGET_VOUCHERS = 50
  let voucherCount = 0

  try {
    for await (const _item of session.stream()) {
      voucherCount++

      if (voucherCount % 10 === 0) {
        const stats = session.stats()
        log('mpp-session', `[Session] Vouchers: ${stats.vouchersIssued}, Cumulative: $${stats.currentCumulative}`)
      }

      if (voucherCount >= TARGET_VOUCHERS) break
    }

    log('mpp-session', `Consumed ${voucherCount} vouchers. Closing session...`)
    closeResult = await closeSession(session, `consumed ${voucherCount} vouchers`)
  } finally {
    if (activeSessions.has(session)) {
      await closeSession(session, 'finally')
    }
  }

  if (!closeResult) {
    throw new Error('mpp-session close returned no result')
  }

  txHashes.channelClose = closeResult.closeTxHash
 

/* … truncated 4085 chars — edit only what you need near the top … */
