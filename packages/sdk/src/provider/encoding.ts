/**
 * Web-standard binary/text codecs that run in any JavaScript runtime —
 * Cloudflare Workers, Bun, Deno, browsers, and Node.js.
 *
 * The Node-only `Buffer` global is unavailable on edge runtimes without a
 * polyfill, so the Workers-safe entry points (e.g. `provider/hono`) must use
 * these helpers instead of `Buffer.from(...)`.
 */

/**
 * Decode a base64 string to its UTF-8 text. Uses `atob` + `TextDecoder`
 * (both Web-standard) so multi-byte UTF-8 is preserved correctly — `atob`
 * alone yields a binary (latin1) string and corrupts non-ASCII bytes.
 */
export function base64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Decode a base64-encoded JSON payload from a payment header.
 *
 * Returns `undefined` instead of throwing when the input is not valid base64,
 * is not valid UTF-8 JSON, or does not decode to a plain object. This lets
 * provider middleware treat malformed `payment-signature` headers as a typed
 * client error (HTTP 400) rather than an uncaught exception (HTTP 500).
 */
export function decodeBase64Json<T = unknown>(b64: string): T | undefined {
  if (typeof b64 !== 'string' || b64.length === 0) return undefined
  try {
    const parsed = JSON.parse(base64ToUtf8(b64))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as T
  } catch {
    return undefined
  }
}

/**
 * Decode a hex string to a `Uint8Array`. Accepts an optional `0x` prefix.
 * Mirrors `Buffer.from(hex, 'hex')` but returns a plain `Uint8Array` (which
 * `Buffer` already extends, so existing consumers are unaffected).
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error('hexToBytes: hex string must have an even length')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Tolerated clock drift (in milliseconds) when validating authorization
 * expiration. A payload is considered expired only once the current time
 * exceeds its deadline by more than this skew, so minor clock differences
 * between client and provider do not reject otherwise-fresh signatures.
 */
export const CLOCK_SKEW_MS = 60_000

/**
 * Resolve the absolute expiration deadline (epoch milliseconds) of a decoded
 * x402 authorization payload.
 *
 * Accepts an explicit `expiresAt` (epoch seconds or milliseconds) and/or a
 * relative `maxTimeoutSeconds` window. When only a relative window is present
 * it is anchored to `issuedAt`/`validAfter` if available, otherwise to the
 * current clock. Returns `undefined` when the payload carries no temporal
 * bounds, so callers can decide whether to reject or allow it.
 */
export function resolveAuthorizationExpiry(
  payload: Record<string, unknown>,
  now: number = Date.now(),
): number | undefined {
  const toMillis = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Values below this threshold are treated as epoch seconds.
      return value < 1e12 ? value * 1000 : value
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed < 1e12 ? parsed * 1000 : parsed
      }
      const asDate = Date.parse(value)
      if (!Number.isNaN(asDate)) return asDate
    }
    return undefined
  }

  const explicit = toMillis(payload.expiresAt)
  if (explicit !== undefined) return explicit

  const timeoutSeconds = toMillis(payload.maxTimeoutSeconds)
  if (timeoutSeconds !== undefined) {
    const anchor =
      toMillis(payload.issuedAt) ??
      toMillis(payload.validAfter) ??
      now
    return anchor + timeoutSeconds
  }

  return undefined
}

/**
 * Returns `true` when the authorization payload's deadline has lapsed beyond
 * the tolerated clock skew. Payloads without any temporal bounds are treated
 * as non-expiring (returns `false`) to preserve backward compatibility.
 */
export function isAuthorizationExpired(
  payload: Record<string, unknown>,
  now: number = Date.now(),
  skewMs: number = CLOCK_SKEW_MS,
): boolean {
  const expiresAt = resolveAuthorizationExpiry(payload, now)
  if (expiresAt === undefined) return false
  return now > expiresAt + skewMs
}
