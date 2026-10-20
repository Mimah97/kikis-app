/**
 * NulthVault — Nulth ZK account support for KikisApp SDK.
 *
 * Imports primitives, proof building, and signing from @kikis-app/nulth-sdk.
 */
import { rpc } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import type { KikisAppManifest, PaymentMode, VaultMode } from '../types.js'
import { KikisAppManifestError, KikisAppVaultConfigError } from '../errors.js'
import {
  NulthClient,
  NulthPolicyError,
  NulthConfigError,
  assertAuthEntryMatchesContext,
  commitAllowlist,
  commitDailyCap,
  hashPayee,
  dayBucket,
  authDigestFromEntry,
  insecureMockProof,
  encodeAuthSignature,
  decodeAuthSignature,
  createNulthSigner,
  createScopedPaymentSigner,
  setNulthPaymentContext,
  paymentContextFromManifest,
  createPolicyState,
  type NulthPolicyState,
  type PaymentAuthContext,
  type NulthProof,
  type NulthAuthSignature,
  type NulthClientConfig,
  type NulthStellarSigner,
  type NulthSignerConfig,
} from '@kikis-app/nulth-sdk'

export {
  NulthClient,
  NulthPolicyError,
  assertAuthEntryMatchesContext,
  commitAllowlist,
  commitDailyCap,
  hashPayee,
  dayBucket,
  dayBucket as dayBucketFromLedger,
  authDigestFromEntry,
  insecureMockProof,
  encodeAuthSignature,
  decodeAuthSignature,
  createNulthSigner,
  createScopedPaymentSigner,
  setNulthPaymentContext,
  paymentContextFromManifest,
  createPolicyState,
  type NulthPolicyState,
  type PaymentAuthContext,
  type NulthProof,
  type NulthAuthSignature,
  type NulthClientConfig,
  type NulthStellarSigner,
  type NulthSignerConfig,
}

// ---------------------------------------------------------------------------
// NulthVault public API
// ---------------------------------------------------------------------------

export interface NulthVaultConfig {
  mode: 'nulth'
  nulthAccount: string
  prover?: 'mock'
  witnessSecret: string
  allowedPayees: readonly string[]
  dailyCapUsdc: string
  expiryLedger?: number
  verifierContract?: string
  /**
   * Custom Soroban RPC URL used for ledger-sequence lookups.
   * Defaults to public Soroban endpoints for `network`.
   */
  sorobanRpcUrl?: string | undefined
  /**
   * Timeout in milliseconds for Soroban RPC requests.
   * Defaults to 10,000 ms (10s).
   */
  rpcTimeoutMs?: number | undefined
}

export function assertNulthVaultManifest(manifest: KikisAppManifest, nulthAccount: string): void {
  if (manifest.vault !== undefined && manifest.vault !== 'nulth') {
    throw new KikisAppManifestError(`Provider vault mode ${manifest.vault} does not match client nulth vault`)
  }
  if (manifest.nulth_account && manifest.nulth_account !== nulthAccount) {
    throw new KikisAppManifestError(`Manifest nulth_account ${manifest.nulth_account} does not match configured ${nulthAccount}`)
  }
}

export async function fetchLedgerSequence(
  network: 'testnet' | 'mainnet',
  options?: { sorobanRpcUrl?: string; rpcTimeoutMs?: number },
): Promise<number> {
  const rpcUrl =
    options?.sorobanRpcUrl ??
    (network === 'testnet' ? 'https://soroban-testnet.stellar.org' : 'https://soroban.stellar.org')
  const timeoutMs = options?.rpcTimeoutMs ?? 10_000
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })
  const latest = await Promise.race([
    server.getLatestLedger(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Soroban RPC request to ${rpcUrl} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const maybeTimer = timer as unknown as { unref?: () => void }
      maybeTimer.unref?.()
    }),
  ])
  return latest.sequence
}

export async function prepareNulthSigner(
  vault: NulthVaultConfig,
  manifest: KikisAppManifest,
  mode: PaymentMode,
  network: 'testnet' | 'mainnet',
  ledgerSequenceOverride?: number,
  rpcUrlOverride?: string,
  rpcTimeoutMsOverride?: number,
): Promise<{ signer: ClientStellarSigner; config: NulthSignerConfig }> {
  assertNulthVaultManifest(manifest, vault.nulthAccount)

  const prover = vault.prover ?? 'mock'
  if (network === 'mainnet' && prover === 'mock') {
    throw new KikisAppVaultConfigError(
      'nulth vault uses the insecure mock prover and cannot be used on mainnet',
    )
  }

  const ledgerSequence =
    ledgerSequenceOverride ??
    (await fetchLedgerSequence(network, {
      ...(vault.sorobanRpcUrl !== undefined ? { sorobanRpcUrl: vault.sorobanRpcUrl } : {}),
      ...(vault.rpcTimeoutMs !== undefined ? { rpcTimeoutMs: vault.rpcTimeoutMs } : {}),
    }))
  const policy = createPolicyState({
    dailyCapUsdc: vault.dailyCapUsdc,
    allowedPayees: vault.allowedPayees,
    witnessSecret: vault.witnessSecret,
    ledgerSequence,
    ...(vault.expiryLedger !== undefined ? { expiryLedger: vault.expiryLedger } : {}),
  })

  const config: NulthSignerConfig = {
    nulthAccount: vault.nulthAccount,
    network,
    prover,
    policy,
    ...(vault.verifierContract !== undefined ? { verifierContract: vault.verifierContract } : {}),
  }

  if (mode !== 'x402' && mode !== 'mpp-charge') {
    throw new KikisAppVaultConfigError(`Nulth ZK vault does not support payment mode: ${mode}`)
  }

  try {
    // Bind the payment context to an isolated, single-use signer so concurrent
    // payments never share mutable state on `config`.
    const paymentContext = paymentContextFromManifest(manifest, mode, ledgerSequence)
    const signer = createScopedPaymentSigner(config, paymentContext)
    return { signer: signer as ClientStellarSigner, config }
  } catch (err: unknown) {
    if (err instanceof KikisAppVaultConfigError) {
      throw err
    }
    if (
      err instanceof NulthConfigError ||
      (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'VAULT_CONFIG') ||
      (err instanceof Error && /mock prover|unknown prover|network must be/i.test(err.message))
    ) {
      throw new KikisAppVaultConfigError((err as Error).message, { cause: err })
    }
    throw err
  }
}

/**
 * Roll back an off-chain daily spend reservation after a failed Nulth payment
 * submission (e.g. Horizon 504, bad sequence number, or node drop).
 *
 * Delegates to `NulthClient.rollbackPayment`, which asserts the accumulator
 * cannot underflow before subtracting `amountStroops`.
 */
export function rollbackNulthSpend(client: NulthClient, amountStroops: bigint): void {
  client.rollbackPayment(amountStroops)
}

export type { VaultMode }
