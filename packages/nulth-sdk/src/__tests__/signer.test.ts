import { describe, it, expect, vi } from 'vitest';
import { createNulthSigner, createScopedPaymentSigner } from '../signer';
import type { NulthSignerConfig, PaymentContext } from '../types';

function makeConfig(overrides: Partial<NulthSignerConfig> = {}): NulthSignerConfig {
  return {
    privateKey: '0x' + '11'.repeat(32),
    network: 'testnet',
    ...overrides,
  } as NulthSignerConfig;
}

function makeContext(index: number): PaymentContext {
  return {
    amount: BigInt(index + 1) * 1000n,
    payeeHash: ('0x' + index.toString(16).padStart(64, '0')) as `0x${string}`,
    nonce: BigInt(index),
  } as PaymentContext;
}

describe('createScopedPaymentSigner', () => {
  it('binds payment context immutably in closure scope', async () => {
    const config = makeConfig();
    const ctx = makeContext(1);
    const signer = createScopedPaymentSigner(config, ctx);

    const entry = await signer.signAuthEntry();

    expect(entry.paymentContext).toEqual(ctx);
    expect(entry.paymentContext.amount).toBe(ctx.amount);
    expect(entry.paymentContext.payeeHash).toBe(ctx.payeeHash);
  });

  it('does not mutate the shared config object', async () => {
    const config = makeConfig();
    const ctx = makeContext(2);
    const signer = createScopedPaymentSigner(config, ctx);

    await signer.signAuthEntry();

    expect((config as Record<string, unknown>).paymentContext).toBeUndefined();
  });

  it('is single-use and rejects a second signing call', async () => {
    const config = makeConfig();
    const signer = createScopedPaymentSigner(config, makeContext(3));

    await signer.signAuthEntry();

    await expect(signer.signAuthEntry()).rejects.toThrow();
  });

  it('runs 20 parallel payments without cross-contaminating contexts', async () => {
    const config = makeConfig();
    const contexts = Array.from({ length: 20 }, (_, i) => makeContext(i));

    const entries = await Promise.all(
      contexts.map((ctx) => createScopedPaymentSigner(config, ctx).signAuthEntry()),
    );

    expect(entries).toHaveLength(20);
    entries.forEach((entry, i) => {
      expect(entry.paymentContext.amount).toBe(contexts[i].amount);
      expect(entry.paymentContext.payeeHash).toBe(contexts[i].payeeHash);
      expect(entry.paymentContext.nonce).toBe(contexts[i].nonce);
    });

    // Ensure no two entries share the same context (no overwrite).
    const amounts = new Set(entries.map((e) => e.paymentContext.amount.toString()));
    expect(amounts.size).toBe(20);
  });

  it('keeps legacy createNulthSigner working with an explicit context argument', async () => {
    const config = makeConfig();
    const ctx = makeContext(7);
    const signer = createNulthSigner(config);

    const entry = await signer.signAuthEntry(ctx);

    expect(entry.paymentContext).toEqual(ctx);
  });

  it('legacy createNulthSigner still reads deprecated config.paymentContext', async () => {
    const ctx = makeContext(8);
    const config = makeConfig({ paymentContext: ctx } as Partial<NulthSignerConfig>);
    const signer = createNulthSigner(config);

    const entry = await signer.signAuthEntry();

    expect(entry.paymentContext).toEqual(ctx);
  });
});
