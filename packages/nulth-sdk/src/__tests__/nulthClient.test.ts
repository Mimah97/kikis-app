import { describe, it, expect, beforeEach } from 'vitest';
import { NulthClient } from '../NulthClient';

describe('NulthClient off-chain daily spend rollback', () => {
  let client: NulthClient;

  beforeEach(() => {
    client = new NulthClient();
  });

  it('rolls back the daily spend accumulator on failed submissions', () => {
    const before = client.getPolicy().dailySpendStroops;
    const amount = 1_000n;

    client.reserveSpend(amount);
    expect(client.getPolicy().dailySpendStroops).toBe(before + amount);

    client.rollbackPayment(amount);
    expect(client.getPolicy().dailySpendStroops).toBe(before);
  });

  it('restores the full remaining daily allowance after a rollback', () => {
    const cap = client.getPolicy().dailySpendCapStroops;
    const amount = 2_500n;

    client.reserveSpend(amount);
    client.rollbackPayment(amount);

    expect(client.getPolicy().dailySpendStroops).toBe(0n);
    expect(client.getRemainingDailyAllowance()).toBe(cap);
  });

  it('never lets the spend accumulator drop below zero', () => {
    expect(() => client.rollbackPayment(1n)).toThrow();
    expect(client.getPolicy().dailySpendStroops).toBe(0n);
  });
});
