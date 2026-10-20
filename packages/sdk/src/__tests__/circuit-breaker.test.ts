import { CircuitBreaker } from '../internal/retry';

describe('CircuitBreaker', () => {
  it('starts CLOSED and allows requests', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canRequest()).toBe(true);
  });

  it('trips OPEN after 5 consecutive failures', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canRequest()).toBe(false);
  });

  it('resets failure count on success', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 4; i++) {
      breaker.recordFailure();
    }
    breaker.recordSuccess();
    for (let i = 0; i < 4; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions to HALF_OPEN after cooldown and allows a single probe', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ cooldownMs: 30000, now: () => now });
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe('OPEN');

    now = 30000;
    expect(breaker.getState()).toBe('HALF_OPEN');
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.canRequest()).toBe(false);
  });

  it('closes the circuit on a successful half-open probe', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ cooldownMs: 30000, now: () => now });
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    now = 30000;
    expect(breaker.canRequest()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canRequest()).toBe(true);
  });

  it('re-opens the circuit on a failed half-open probe', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ cooldownMs: 30000, now: () => now });
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    now = 30000;
    expect(breaker.canRequest()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canRequest()).toBe(false);
  });
});
