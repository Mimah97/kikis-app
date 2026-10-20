/**
 * Off-chain policy state for a Nulth ZK account.
 * Allowlist and daily cap live here — never published on-chain.
 */
export interface NulthPolicyState {
  /** Maximum daily spend in stroops (7-decimal USDC) */
  dailyCapStroops: bigint
  /**
   * Optional per-asset daily caps keyed by SAC asset contract address (C...).
   * When present, each asset is enforced independently against its own cap.
   */
  assetCaps?: Record<string, bigint>
  /** SHA-256 commitment to sorted allowlisted payee addresses (hex) */
  allowlistCommitment: string
  /** Allowed payee contract/account addresses — kept off-chain */
  allowedPayees: readonly string[]
  /** Cumulative spend for the current day bucket */
  dailySpendStroops: bigint
  /** Optional per-asset cumulative spend for the current day bucket, keyed by asset contract */
  assetSpendStroops?: Record<string, bigint>
  /** Ledger day bucket: ledger_sequence / 17280 */
  dayBucket: number
  /** Agent witness secret — binds proofs without exposing policy */
  witnessSecret: string
  /** Optional session expiry ledger */
  expiryLedger?: number
}

/** Inputs for building a payment authorization proof */
export interface PaymentAuthContext {
  /** Base64 Soroban auth entry preimage from x402 / KikisApp */
  authEntry: string
  /** Destination payee address (G... or C...) */
  payee: string
  /** Transfer amount in stroops */
  amountStroops: bigint
  /** SAC asset contract address */
  assetContract: string
  /** Current ledger sequence (for day bucket + expiry checks) */
  ledgerSequence: number
}

/** ZK auth proof attached to Soroban __check_auth */
export interface NulthProof {
  version: 1
  /** Groth16-style proof bytes (base64) — verified on-chain, policy stays private */
  proof: string
  /** Public inputs bound into the proof (no raw allowlist or cap values) */
  publicInputs: {
    authDigest: string
    allowlistCommitment: string
    capCommitment: string
    payeeHash: string
    amountStroops: string
    dayBucket: string
  }
}

/** Encoded signature payload for SorobanAddressCredentials.signature */
export interface NulthAuthSignature {
  nulth: 'zk-v1'
  proof: NulthProof
}

export interface NulthClientConfig {
  /** Nulth smart account contract address (C...) — the payer */
  nulthAccount: string
  /**
   * Network the client will authorize payments on.
   */
  network: 'testnet' | 'mainnet'
  /** Test-only SHA-512 proof stub. */
  prover?: 'mock'
  /** Off-chain policy state */
  policy: NulthPolicyState
  /** Optional verifier contract deployed alongside the Nulth account */
  verifierContract?: string
  /** Optional log sink for the mock-prover warning. */
  logger?: any
}

/**
 * Configuration for a Nulth signer.
 *
 * NOTE: `paymentContext` is deprecated. Mutating a shared config's
 * `paymentContext` before each signing call is racy under concurrency —
 * Payment B can overwrite the context while Payment A is awaiting proof
 * generation. Prefer `createScopedPaymentSigner(config, paymentContext)`,
 * which binds the context immutably in closure scope per payment.
 *
 * @deprecated Use `createScopedPaymentSigner` instead of setting this field.
 */
export interface NulthSignerConfig extends NulthClientConfig {
  /**
   * @deprecated Shared mutable payment context — racy under concurrency.
   * Use `createScopedPaymentSigner(config, paymentContext)` instead.
   */
  paymentContext?: PaymentAuthContext
}

export class NulthPolicyError extends Error {
  readonly code: 'payee_not_allowed' | 'daily_cap_exceeded' | 'asset_cap_exceeded' | 'session_expired' | 'auth_entry_mismatch'

  constructor(code: NulthPolicyError['code'], message: string) {
    super(message)
    this.name = 'NulthPolicyError'
    this.code = code
  }
}

export class NulthConfigError extends Error {
  readonly code = 'VAULT_CONFIG' as const

  constructor(message: string) {
    super(message)
    this.name = 'NulthConfigError'
  }
}
