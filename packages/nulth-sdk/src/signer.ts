import type { SignAuthEntry } from '@stellar/stellar-sdk/contract'
import {
  assertAuthEntryMatchesContext,
  authDigestFromEntry,
  commitAllowlist,
  commitDailyCap,
  dayBucket,
  encodeAuthSignature,
  hashPayee,
  DEFAULT_PROVER,
  type ProverBackend,
  usdcToStroops,
} from './proof.js'
import { NulthClient } from './NulthClient.js'
import type { NulthClientConfig, PaymentAuthContext } from './types.js'

/** Compatible with @x402/stellar ClientStellarSigner */
export interface NulthStellarSigner {
  address: string
  signAuthEntry: SignAuthEntry
}

export interface NulthSignerConfig extends NulthClientConfig {
  /**
   * Pending payment context set before x402 signs auth entries.
   * @deprecated Shared mutable state causes race conditions under concurrent
   * payments. Use `createScopedPaymentSigner(config, paymentContext)` instead,
   * which binds the context immutably per payment.
   */
  paymentContext?: Omit<PaymentAuthContext, 'authEntry'>
}

/**
 * Create an x402-compatible signer that pays from a Nulth ZK account.
 * Proofs are built off-chain; allowlist and cap never leave the agent.
 *
 * @deprecated Prefer `createScopedPaymentSigner` for concurrent payments — this
 * signer reads `config.paymentContext`, which is shared mutable state.
 */
export function createNulthSigner(config: NulthSignerConfig): NulthStellarSigner {
  const client = new NulthClient(config)
  const nulthAccount = config.nulthAccount

  return {
    address: nulthAccount,
    signAuthEntry: async (authEntry) => {
      const ctx = config.paymentContext
      if (!ctx) {
        throw new Error(
          'Nulth paymentContext must be set before signing — call setNulthPaymentContext()',
        )
      }

      assertAuthEntryMatchesContext(authEntry, nulthAccount, ctx)

      const proof = client.buildPaymentAuthProof({
        authEntry,
        ...ctx,
      })

      return {
        signedAuthEntry: encodeAuthSignature(proof),
        signerAddress: nulthAccount,
      }
    },
  }
}

/**
 * Create a single-use signer whose payment context is bound immutably in closure
 * scope. Each payment should get its own scoped signer so concurrent payments
 * never cross-contaminate contexts.
 */
export function createScopedPaymentSigner(
  config: NulthClientConfig,
  paymentContext: Omit<PaymentAuthContext, 'authEntry'>,
): NulthStellarSigner {
  const client = new NulthClient(config)
  const nulthAccount = config.nulthAccount
  // Freeze a private copy so later mutation of the caller's object cannot leak in.
  const ctx: Omit<PaymentAuthContext, 'authEntry'> = Object.freeze({ ...paymentContext })

  return {
    address: nulthAccount,
    signAuthEntry: async (authEntry) => {
      assertAuthEntryMatchesContext(authEntry, nulthAccount, ctx)

      const proof = client.buildPaymentAuthProof({
        authEntry,
        ...ctx,
      })

      return {
        signedAuthEntry: encodeAuthSignature(proof),
        signerAddress: nulthAccount,
      }
    },
  }
}

/**
 * Bind the next payment's public context before x402 calls signAuthEntry.
 * @deprecated Mutates shared config and is unsafe under concurrency. Use
 * `createScopedPaymentSigner` instead.
 */
export function setNulthPaymentContext(
  config: NulthSignerConfig,
  context: Omit<PaymentAuthContext, 'authEntry'>,
): void {
  config.paymentContext = context
}

/** Helper to prepare payment context from manifest pricing */
export function paymentContextFromManifest(
  manifest: {
    payee: string
    asset_contract: string
    pricing: { x402?: { amount: string; payee?: string }; 'mpp-charge'?: { amount: string; payee?: string } }
  },
  mode: 'x402' | 'mpp-charge',
  ledgerSequence: number,
): Omit<PaymentAuthContext, 'authEntry'> {
  const pricing = manifest.pricing[mode]
  if (!pricing) {
    throw new Error(`manifest.pricing.${mode} missing`)
  }
  return {
    payee: pricing.payee ?? manifest.payee,
    amountStroops: usdcToStroops(pricing.amount),
    assetContract: manifest.asset_contract,
    ledgerSequence,
  }
}

/** Initialize off-chain policy from explicit allowlist + cap (hashed before use) */
export function createPolicyState(input: {
  dailyCapUsdc: string
  allowedPayees: readonly string[]
  witnessSecret: string
  expiryLedger?: number
  ledgerSequence?: number
}): import('./types.js').NulthPolicyState {
  const dailyCapStroops = usdcToStroops(input.dailyCapUsdc)
  const witnessSecret = input.witnessSecret
  return {
    dailyCapStroops,
    allowlistCommitment: commitAllowlist(input.allowedPayees, witnessSecret),
    allowedPayees: input.allowedPayees,
    dailySpendStroops: 0n,
    dayBucket: dayBucket(input.ledgerSequence ?? 0),
    witnessSecret,
    ...(input.expiryLedger !== undefined ? { expiryLedger: input.expiryLedger } : {}),
  }
}

export {
  authDigestFromEntry,
  commitAllowlist,
  commitDailyCap,
  dayBucket,
  hashPayee,
  DEFAULT_PROVER,
  ProverBackend,
  usdcToStroops,
}
