import {
  authDigestFromEntry,
  commitDailyCap,
  dayBucket,
  encodeAuthSignature,
  hashPayee,
  insecureMockProof,
  type ProverBackend,
  DEFAULT_PROVER,
} from './proof.js'
import type {
  NulthClientConfig,
  NulthPolicyState,
  NulthProof,
  PaymentAuthContext,
} from './types.js'
import { NulthPolicyError, NulthConfigError } from './types.js'

/**
 * Canonical binary preimage serializer.
 *
 * Encodes each field as a 32-bit big-endian length prefix followed by its
 * UTF-8 bytes (TLV-style). This removes any delimiter ambiguity: field
 * boundaries are determined solely by explicit lengths, so inputs containing
 * pipe characters (or any other byte) cannot shift the preimage boundary
 * parsing and spoof a different proof context.
 */
function encodePreimageField(field: string): Uint8Array {
  const bytes = new TextEncoder().encode(field)
  const out = new Uint8Array(4 + bytes.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}

function serializePreimage(fields: readonly string[]): Uint8Array {
  const encoded = fields.map(encodePreimageField)
  const total = encoded.reduce((sum, part) => sum + part.length, 0)
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const part of encoded) {
    buffer.set(part, offset)
    offset += part.length
  }
  return buffer
}

export class NulthClient {
  private policy: NulthPolicyState
  private readonly prover: ProverBackend

  constructor(private readonly config: NulthClientConfig) {
    this.policy = { ...config.policy }
    this.prover = config.prover ?? DEFAULT_PROVER
    if (this.prover !== 'mock') {
      throw new NulthConfigError(
        `NulthClient: unknown prover backend ${String(config.prover)}; only 'mock' is implemented`,
      )
    }
    if (config.network !== 'testnet') {
      throw new NulthConfigError(
        `NulthClient cannot use the insecure mock prover on mainnet; a production prover is required (network must be 'testnet', got ${String(config.network)})`,
      )
    }
    const warnMsg = 'NulthClient is using the insecure mock prover; proofs are not cryptographically sound'
    if (typeof config.logger === 'function') {
      config.logger('warn', warnMsg)
    } else if (config.logger && typeof config.logger.warn === 'function') {
      config.logger.warn(warnMsg)
    } else {
      console.warn(warnMsg)
    }
  }

  get nulthAccount(): string {
    return this.config.nulthAccount
  }

  get allowlistCommitment(): string {
    return this.policy.allowlistCommitment
  }

  get capCommitment(): string {
    return commitDailyCap(this.policy.dailyCapStroops, this.policy.witnessSecret)
  }

  /** Current off-chain daily spend (never published) */
  get dailySpendStroops(): bigint {
    return this.policy.dailySpendStroops
  }

  /** Prover backend selected for this client */
  get proverBackend(): ProverBackend {
    return this.prover
  }

  /**
   * Build a ZK proof that the payment satisfies off-chain policy.
   * Called by KikisApp before attaching the auth signature to the tx.
   */
  buildPaymentAuthProof(context: PaymentAuthContext): NulthProof {
    this.enforcePolicy(context)

    const bucket = dayBucket(context.ledgerSequence)
    if (bucket !== this.policy.dayBucket) {
      this.policy.dayBucket = bucket
      this.policy.dailySpendStroops = 0n
      this.policy.assetSpendStroops = {}
    }

    const authDigest = authDigestFromEntry(context.authEntry)
    const capCommitment = this.capCommitment
    const payeeHash = hashPayee(context.payee)
    const assetId = context.asset ?? ''

    // Canonical binary preimage: length-prefixed fields, no delimiters.
    const preimage = serializePreimage([
      authDigest,
      this.policy.allowlistCommitment,
      capCommitment,
      payeeHash,
      context.amountStroops.toString(),
      bucket.toString(),
      this.config.nulthAccount,
    ])

    const proof: NulthProof = {
      version: 1,
      proof: insecureMockProof(preimage),
      publicInputs: {
        authDigest,
        allowlistCommitment: this.policy.allowlistCommitment,
        capCommitment,
        payeeHash,
        amountStroops: context.amountStroops.toString(),
        dayBucket: bucket.toString(),
      },
    }

    this.policy.dailySpendStroops += context.amountStroops
    if (context.asset !== undefined) {
      const assetSpend = this.policy.assetSpendStroops ?? {}
      assetSpend[context.asset] = (assetSpend[context.asset] ?? 0n) + context.amountStroops
      this.policy.assetSpendStroops = assetSpend
    }
    return proof
  }

  /**
   * Roll back a previously reserved off-chain daily spend when the
   * corresponding transaction submission fails, restoring the available
   * daily allowance. Throws if the rollback would underflow the accumulator.
   */
  rollbackPayment(amountStroops: bigint): void {
    if (amountStroops < 0n) {
      throw new RangeError(`Invalid amountStroops: ${amountStroops}`)
    }
    if (this.policy.dailySpendStroops < amountStroops) {
      throw new NulthPolicyError(
        'rollback_underflow',
        `Cannot roll back ${amountStroops} stroops; current daily spend is ${this.policy.dailySpendStroops}`,
      )
    }
    this.policy.dailySpendStroops -= amountStroops
  }

  /** Encode proof for SorobanAddressCredentials.signature */
  encodeProof(proof: NulthProof): string {
    return encodeAuthSignature(proof)
  }

  private enforcePolicy(context: PaymentAuthContext): void {
    if (context.amountStroops < 0n) {
      throw new RangeError(`Invalid amountStroops: ${context.amountStroops}`)
    }
    if (!Number.isSafeInteger(context.ledgerSequence) || context.ledgerSequence < 0) {
      throw new RangeError(`Invalid ledgerSequence: ${context.ledgerSequence}`)
    }

    if (
      this.policy.expiryLedger !== undefined &&
      context.ledgerSequence > this.policy.expiryLedger
    ) {
      throw new NulthPolicyError('session_expired', 'Nulth session expired')
    }

    if (!this.policy.allowedPayees.includes(context.payee)) {
      throw new NulthPolicyError(
        'payee_not_allowed',
        `Payee ${context.payee} not in off-chain allowlist`,
      )
    }

    const bucket = dayBucket(context.ledgerSequence)
    const spend =
      bucket === this.policy.dayBucket ? this.policy.dailySpendStroops : 0n
    const projected = spend + context.amountStroops
    if (projected > this.policy.dailyCapStroops) {
      throw new NulthPolicyError('daily_cap_exceeded', 'Nulth daily cap exceeded')
    }

    if (context.asset !== undefined && this.policy.assetCaps !== undefined) {
      const assetCap = this.policy.assetCaps[context.asset]
      if (assetCap !== undefined) {
        const assetSpend =
          bucket === this.policy.dayBucket
            ? this.policy.assetSpendStroops?.[context.asset] ?? 0n
            : 0n
        const assetProjected = assetSpend + context.amountStroops
        if (assetProjected > assetCap) {
          throw new NulthPolicyError(
            'asset_cap_exceeded',
            `Nulth daily cap exceeded for asset ${context.asset}`,
          )
        }
      }
    }
  }
}
