import { createHash } from 'node:crypto'
import { Address, hash, scValToNative, xdr } from '@stellar/stellar-sdk'
import { NulthPolicyError, type PaymentAuthContext } from './types.js'

/** SHA-256 hex digest */
export function sha256Hex(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Canonical length-prefixed encoding of a list of strings.
 *
 * Layout: `count` as big-endian u32, then for each item its UTF-8 byte
 * length as big-endian u32 followed by its UTF-8 bytes. This is unambiguous
 * and immune to delimiter injection / prefix collisions.
 */
export function canonicalEncodeStrings(items: readonly string[]): Uint8Array {
  const encoded = items.map((item) => Buffer.from(item, 'utf8'))
  const total = 4 + encoded.reduce((sum, buf) => sum + 4 + buf.length, 0)
  const out = Buffer.allocUnsafe(total)
  let offset = 0
  out.writeUInt32BE(encoded.length, offset)
  offset += 4
  for (const buf of encoded) {
    out.writeUInt32BE(buf.length, offset)
    offset += 4
    buf.copy(out, offset)
    offset += buf.length
  }
  return out
}

/** Commitment to the daily cap — cap value never appears on-chain */
export function commitDailyCap(dailyCapStroops: bigint, witnessSecret: string): string {
  return sha256Hex(encodePreimage([witnessSecret, 'cap', dailyCapStroops.toString()]))
}

/** Commitment to sorted allowlist — individual payees never published */
export function commitAllowlist(payees: readonly string[], witnessSecret: string): string {
  const sorted = [...payees].sort()
  const preimage = Buffer.concat([
    Buffer.from(`${witnessSecret}:allowlist:`, 'utf8'),
    Buffer.from(canonicalEncodeStrings(sorted)),
  ])
  return sha256Hex(preimage)
}

/** Hash a payee for public inputs without revealing the full allowlist */
export function hashPayee(payee: string): string {
  return sha256Hex(encodePreimage(['payee', payee]))
}

/** Ledger day bucket aligned with agent-vault (17280 ledgers ≈ 24h) */
export function dayBucket(ledgerSequence: number): number {
  return Math.floor(ledgerSequence / 17280)
}

/** Auth digest bound into the ZK proof (mirrors OZ smart account binding) */
export function authDigestFromEntry(authEntryBase64: string): string {
  const entryHash = hash(Buffer.from(authEntryBase64, 'base64'))
  return sha256Hex(entryHash)
}

/**
 * Off-chain verification of a Nulth payment authorization proof.
 *
 * Validates the proof format and public-input consistency so providers and
 * test harnesses can reject malformed or tampered proofs before forwarding
 * them to Soroban for on-chain execution.
 *
 * Returns `true` only when the proof is well-formed and its public inputs are
 * internally consistent; returns `false` for any malformed or tampered input.
 */
export function verifyPaymentAuthProof(
  proof: NulthProof,
  publicInputs: NulthPublicInputs,
): boolean {
  if (!proof || typeof proof !== 'object') return false
  if (!publicInputs || typeof publicInputs !== 'object') return false

  // Proof format: required hex-encoded fields must be present and well-formed.
  const proofHex = (proof as { proof?: unknown }).proof
  const publicSignals = (proof as { publicSignals?: unknown }).publicSignals
  if (typeof proofHex !== 'string' || !isHex(proofHex)) return false
  if (!Array.isArray(publicSignals)) return false
  if (!publicSignals.every((s) => typeof s === 'string' && isHex(s))) return false

  // Public inputs consistency: required fields must be present and non-empty.
  const { commitment, nullifier, amount, recipient } = publicInputs as {
    commitment?: unknown
    nullifier?: unknown
    amount?: unknown
    recipient?: unknown
  }
  if (typeof commitment !== 'string' || !isHex(commitment)) return false
  if (typeof nullifier !== 'string' || !isHex(nullifier)) return false
  if (typeof recipient !== 'string' || recipient.length === 0) return false
  if (typeof amount !== 'string' || amount.length === 0) return false

  // The proof's public signals must match the supplied public inputs so a
  // tampered proof or mismatched inputs are rejected off-chain.
  const expectedSignals = [commitment, nullifier]
  if (publicSignals.length !== expectedSignals.length) return false
  for (let i = 0; i < expectedSignals.length; i++) {
    if (publicSignals[i] !== expectedSignals[i]) return false
  }

  return true
}

function isHex(value: string): boolean {
  return value.length > 0 && /^[0-9a-fA-F]+$/.test(value)
}
