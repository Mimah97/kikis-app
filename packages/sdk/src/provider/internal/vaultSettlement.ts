import {
  Account,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

export interface VaultSettlementAddresses {
  payer: string
  payee: string
}

/**
 * A single settlement entry for the batch entrypoint. Mirrors the on-chain
 * `SettlementEntry` struct in `contracts/agent-vault/src/lib.rs`.
 */
export interface SettlementEntry {
  channelId: string
  payer: string
  cumulativeAmount: bigint
  voucherCount: number
}

/**
 * Return correctly attributed vault-event participants, or null when the
 * payer could not be extracted. Publishing no audit event is safer than
 * knowingly attributing the provider as both sides of the settlement.
 */
export function resolveVaultSettlementAddresses(
  vault: string | null,
  payee: string,
): VaultSettlementAddresses | null {
  // The vault is the governed payer account: every settlement is attributed
  // to this vault instance regardless of which agent or payee originally
  // opened the channel. The SDK must never pass a third-party payer to the
  // vault, so a missing vault address falls back to null instead of silently
  // attributing the settlement elsewhere (#16).
  if (!vault) return null
  return { payer: vault, payee }
}

/**
 * Build the `record_session_settlement` transaction for a closed channel.
 *
 * The transaction source is the payee, because the vault authorizes the record
 * with the allowlisted payee's own signature — never the vault admin's. The
 * source-account credential added by `prepareTransaction` therefore satisfies
 * `payee.require_auth()` on the contract, so a provider never needs the admin
 * secret to emit `session_settled`.
 *
 * Kept free of RPC calls so it is unit-testable without a network round trip.
 */
export function buildSessionSettlementTransaction(
  source: Account,
  vaultContractId: string,
  channelId: string,
  addresses: VaultSettlementAddresses,
  amount: bigint,
  voucherCount: number,
  networkPassphrase: string,
): Transaction {
  const vault = new Contract(vaultContractId)
  const op = vault.call(
    'record_session_settlement',
    nativeToScVal(channelId, { type: 'address' }),
    nativeToScVal(addresses.payer, { type: 'address' }),
    nativeToScVal(addresses.payee, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(voucherCount, { type: 'u32' }),
  )
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
}

/**
 * Encode a `SettlementEntry` as the Soroban struct value expected by the
 * contract's `record_session_settlements_batch` entrypoint.
 */
function encodeSettlementEntry(entry: SettlementEntry): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('channel_id'),
      val: nativeToScVal(entry.channelId, { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('payer'),
      val: nativeToScVal(entry.payer, { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('cumulative_amount'),
      val: nativeToScVal(entry.cumulativeAmount, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('voucher_count'),
      val: nativeToScVal(entry.voucherCount, { type: 'u32' }),
    }),
  ])
}

/**
 * Build the `record_session_settlements_batch` transaction for a set of closed
 * channels. The payee is authorized once for the whole batch, so a provider
 * settling many channels at an epoch rollover submits a single transaction
 * instead of one per channel (#88).
 *
 * The transaction source is the payee for the same reason as the single
 * settlement builder: the vault authorizes the allowlisted payee's own
 * signature, never the vault admin's.
 *
 * Kept free of RPC calls so it is unit-testable without a network round trip.
 */
export function buildSessionSettlementBatchTransaction(
  source: Account,
  vaultContractId: string,
  payee: string,
  entries: SettlementEntry[],
  networkPassphrase: string,
): Transaction {
  const vault = new Contract(vaultContractId)
  const op = vault.call(
    'record_session_settlements_batch',
    nativeToScVal(payee, { type: 'address' }),
    xdr.ScVal.scvVec(entries.map(encodeSettlementEntry)),
  )
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
}