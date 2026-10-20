import type { SupabaseClient } from '@supabase/supabase-js'
import type { SessionState } from '../types.js'
import {
  KikisAppVoucherMonotonicityError,
  KikisAppNetworkError,
} from '../errors.js'
import { usdcToStroops } from '../internal/usdc.js'

// ── Interface ──────────────────────────────────────────────────────────────────

export interface SessionStore {
  get(channelId: string): Promise<SessionState | null>
  /** Enforce monotonic invariant at application level before writing (used for voucher amount advances) */
  upsert(channelId: string, state: SessionState): Promise<void>
  /** Update session status without altering cumulative_amount */
  setStatus(
    channelId: string,
    status: SessionState['status'],
    settlementTxHash?: string | null,
  ): Promise<void>
  close(channelId: string): Promise<void>
}

// ── Supabase implementation ────────────────────────────────────────────────────

export class SupabaseSessionStore implements SessionStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async get(channelId: string): Promise<SessionState | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .eq('channel_id', channelId)
      .maybeSingle()

    if (error) {
      throw new KikisAppNetworkError(`SessionStore.get failed: ${error.message}`)
    }
    if (!data) return null

    return {
      channel_id: data.channel_id as string,
      payee: data.payee as string,
      payer: data.payer as string,
      channel_contract: data.channel_contract as string,
      network: data.network as SessionState['network'],
      cumulative_amount: String(data.cumulative_amount),
      last_signature: data.last_signature as string,
      status: data.status as SessionState['status'],
      opened_at: data.opened_at as string,
      updated_at: data.updated_at as string,
      settlement_tx_hash: data.settlement_tx_hash as string | null,
    }
  }

  async upsert(channelId: string, state: SessionState): Promise<void> {
    const nextStroops = usdcToStroops(state.cumulative_amount)
    const now = new Date().toISOString()

    // Atomic conditional UPDATE: only advance if the row exists AND
    // the stored cumulative_amount is strictly less than the new amount.
    const { data, error: updateError } = await this.supabase
      .from('sessions')
      .update({
        payee: state.payee,
        payer: state.payer,
        channel_contract: state.channel_contract,
        network: state.network,
        cumulative_amount: state.cumulative_amount,
        last_signature: state.last_signature,
        status: state.status,
        opened_at: state.opened_at,
        updated_at: now,
        settlement_tx_hash: state.settlement_tx_hash,
      })
      .eq('channel_id', channelId)
      .lt('cumulative_amount', state.cumulative_amount)
      .select('channel_id')

    if (updateError) {
      if (updateError.message.includes('strictly increasing')) {
        throw new KikisAppVoucherMonotonicityError(
          `cumulative_amount must be strictly increasing (DB): ${updateError.message}`,
        )
      }
      throw new KikisAppNetworkError(`SessionStore.upsert failed: ${updateError.message}`)
    }

    if (data && data.length > 0) {
      // Row existed and was successfully advanced
      return
    }

    // Zero rows were updated. Either the session already exists (and the new
    // amount was not strictly greater), or this is the first voucher and the row
    // has not been created yet.
    const existing = await this.get(channelId)
    if (existing) {
      const prevStroops = usdcToStroops(existing.cumulative_amount)
      if (nextStroops <= prevStroops) {
        throw new KikisAppVoucherMonotonicityError(
          `cumulative_amount must be strictly increasing: ${nextStroops} <= ${prevStroops}`,
        )
      }
    }

    // Row does not exist; attempt initial INSERT.
    const { error: insertError } = await this.supabase.from('sessions').insert({
      channel_id: state.channel_id,
      payee: state.payee,
      payer: state.payer,
      channel_contract: state.channel_contract,
      network: state.network,
      cumulative_amount: state.cumulative_amount,
      last_signature: state.last_signature,
      status: state.status,
      opened_at: state.opened_at,
      updated_at: now,
      settlement_tx_hash: state.settlement_tx_hash,
    })

    if (insertError) {
      // If a concurrent insert beat us, re-check monotonicity against the stored row.
      if (
        insertError.code === '23505' ||
        insertError.message.includes('duplicate key') ||
        insertError.message.includes('unique')
      ) {
        const current = await this.get(channelId)
        if (current) {
          const prevStroops = usdcToStroops(current.cumulative_amount)
          if (nextStroops <= prevStroops) {
            throw new KikisAppVoucherMonotonicityError(
              `cumulative_amount must be strictly increasing: ${nextStroops} <= ${prevStroops}`,
            )
          }
        }
      }
      if (insertError.message.includes('strictly increasing')) {
        throw new KikisAppVoucherMonotonicityError(
          `cumulative_amount must be strictly increasing (DB): ${insertError.message}`,
        )
      }
      throw new KikisAppNetworkError(`SessionStore.upsert failed: ${insertError.message}`)
    }
  }

  async setStatus(
    channelId: string,
    status: SessionState['status'],
    settlementTxHash?: string | null,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    }
    if (settlementTxHash !== undefined) {
      payload.settlement_tx_hash = settlementTxHash
    }

    const { error } = await this.supabase
      .from('sessions')
      .update(payload)
      .eq('channel_id', channelId)

    if (error) {
      throw new KikisAppNetworkError(`SessionStore.setStatus failed: ${error.message}`)
    }
  }

  async close(channelId: string): Promise<void> {
    await this.setStatus(channelId, 'closed')
  }
}
