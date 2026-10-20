/**
 * Retry utilities with exponential backoff and a lightweight circuit breaker.
 */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds. Defaults to 250. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds. Defaults to 5000. */
  maxDelayMs?: number;
  /** Optional predicate to decide whether an error is retryable. */
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with exponential backoff retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(error)) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the circuit. Defaults to 5. */
  failureThreshold?: number;
  /** Cooldown in milliseconds before a half-open probe. Defaults to 30000. */
  cooldownMs?: number;
  /** Time window in milliseconds for counting consecutive failures. Defaults to 60000. */
  windowMs?: number;
  /** Injectable clock for testing. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Lightweight circuit breaker tracking consecutive failures per instance.
 *
 * States:
 * - CLOSED: requests flow normally; failures are counted.
 * - OPEN: requests fast-fail until the cooldown elapses.
 * - HALF_OPEN: a single probe request is allowed; success closes the circuit,
 *   failure re-opens it.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private firstFailureAt = 0;
  private openedAt = 0;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30000;
    this.windowMs = options.windowMs ?? 60000;
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  /**
   * Returns true when a request may proceed. In HALF_OPEN only a single probe
   * is permitted at a time.
   */
  canRequest(): boolean {
    this.maybeTransitionToHalfOpen();
    if (this.state === 'OPEN') {
      return false;
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) {
        return false;
      }
      this.probeInFlight = true;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.firstFailureAt = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    const now = this.now();

    if (this.state === 'HALF_OPEN') {
      this.trip(now);
      return;
    }

    if (this.state === 'OPEN') {
      return;
    }

    if (this.consecutiveFailures === 0) {
      this.firstFailureAt = now;
    } else if (now - this.firstFailureAt > this.windowMs) {
      // Window elapsed; restart the count.
      this.firstFailureAt = now;
      this.consecutiveFailures = 0;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.trip(now);
    }
  }

  private trip(now: number): void {
    this.state = 'OPEN';
    this.openedAt = now;
    this.probeInFlight = false;
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
      this.probeInFlight = false;
    }
  }
}
