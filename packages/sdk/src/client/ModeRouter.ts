import { Validator, type Schema } from '@cfworker/json-schema'
import type { KikisAppManifest, PaymentMode, HttpRequestOptions } from '../types.js'
import {
  KikisAppError,
  KikisAppManifestError,
  KikisAppManifestTimeoutError,
  KikisAppManifestSunsetError,
  KikisAppNoSupportedModeError,
  KikisAppPolicyRejectError,
  KikisAppClientVersionError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { usdcToStroops } from '../internal/usdc.js'
import { noopLogger, type KikisAppLogger } from '../internal/logger.js'
import schema from '../schemas/kikis-app.schema.json' assert { type: 'json' }
import pkg from '../../package.json' assert { type: 'json' }
import { verifyManifestSignature } from '../manifest/sign.js'

const validator = new Validator(schema as unknown as Schema, '7')

const SDK_VERSION = pkg.version as string

function parseMajorMinor(version: string): [number, number] {
  const parts = version.split('.')
  return [Number.parseInt(parts[0] ?? '0', 10), Number.parseInt(parts[1] ?? '0', 10)]
}

function isVersionBelow(a: string, b: string): boolean {
  const [aMajor, aMinor] = parseMajorMinor(a)
  const [bMajor, bMinor] = parseMajorMinor(b)
  return aMajor < bMajor || (aMajor === bMajor && aMinor < bMinor)
}

function assertClientVersionSupported(manifest: KikisAppManifest, baseUrl: string): void {
  const minVersion = manifest.min_client_version
  if (minVersion && isVersionBelow(SDK_VERSION, minVersion)) {
    throw new KikisAppClientVersionError(
      `SDK version ${SDK_VERSION} is below the minimum required version ${minVersion} for provider at ${baseUrl}. Please upgrade the SDK.`,
    )
  }
}

function assertManifestActive(manifest: KikisAppManifest, baseUrl: string): void {
  const sunsetAt = manifest.sunset_at
  if (!sunsetAt) return

  const sunsetTime = Date.parse(sunsetAt)
  if (!Number.isFinite(sunsetTime)) {
    throw new KikisAppManifestError(
      `Manifest at ${baseUrl} contains an invalid sunset_at timestamp: ${sunsetAt}`,
    )
  }

  if (sunsetTime <= Date.now()) {
    throw new KikisAppManifestSunsetError(
      `Manifest for provider at ${baseUrl} sunset at ${sunsetAt} and can no longer be used`,
    )
  }
}

/**
 * Enforce the per-endpoint `deprecated` and `sunset_at` metadata for the URL
 * being paid. `pay()` never learns the HTTP method, so a path shared by more
 * than one descriptor (e.g. GET and POST on `/infer`) is refused only when
 * every matching descriptor has sunset. Paths the manifest does not list keep
 * today's behavior. Query strings and hashes are ignored because only
 * `URL.pathname` is compared.
 */
export function assertEndpointActive(
  manifest: KikisAppManifest,
  url: string,
  logger?: KikisAppLogger,
): void {
  const pathname = new URL(url).pathname
  const matches = Object.entries(manifest.endpoints).filter(
    ([, descriptor]) => descriptor.path === pathname,
  )
  if (matches.length === 0) return

  const now = Date.now()
  const allSunset = matches.every(([, descriptor]) => {
    const sunsetAt = descriptor.sunset_at
    return typeof sunsetAt === 'string' && Date.parse(sunsetAt) <= now
  })
  if (allSunset) {
    const [key, descriptor] = matches[0]!
    throw new KikisAppManifestSunsetError(
      `Endpoint '${key}' (${pathname}) sunset at ${descriptor.sunset_at} and can no longer be used`,
    )
  }

  const deprecated = matches.find(([, descriptor]) => descriptor.deprecated === true)
  if (deprecated && logger) {
    const [key, descriptor] = deprecated
    const sunsetSuffix = descriptor.sunset_at ? `; sunset_at ${descriptor.sunset_at}` : ''
    logger(
      'warn',
      `[KikisApp] WARNING: ${manifest.name} → ${pathname}; endpoint '${key}' is deprecated${sunsetSuffix}`,
    )
  }
}

/**
 * Validate semantic constraints for manifest fields beyond JSON schema syntax.
 * Enforces:
 * - All keys in `latency_hints` must be a subset of declared `regions`.
 * - If `assets` is defined, it must be a non-empty array whose first entry
 *   (`assets[0]`) matches the root-level `asset` and `asset_contract`.
 */
export function assertManifestValid(manifest: KikisAppManifest, baseUrl?: string): void {
  const context = baseUrl ? ` at ${baseUrl}` : ''
  if (manifest.latency_hints !== undefined) {
    if (!Array.isArray(manifest.regions) || manifest.regions.length === 0) {
      throw new KikisAppManifestError(
        `Invalid manifest${context}: latency_hints defined without declaring regions`,
      )
    }
    const regionSet = new Set(manifest.regions)
    for (const region of Object.keys(manifest.latency_hints)) {
      if (!regionSet.has(region)) {
        throw new KikisAppManifestError(
          `Invalid manifest${context}: latency_hints key '${region}' is not declared in regions (${manifest.regions.join(', ')})`,
        )
      }
    }
  }

  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw new KikisAppManifestError(
        `Invalid manifest${context}: assets must be a non-empty array when defined`,
      )
    }
    for (let i = 0; i < manifest.assets.length; i++) {
      const a = manifest.assets[i]
      if (!a || typeof a.asset !== 'string' || typeof a.asset_contract !== 'string') {
        throw new KikisAppManifestError(
          `Invalid manifest${context}: assets[${i}] must define asset and asset_contract strings`,
        )
      }
    }
    const first = manifest.assets[0]!
    if (first.asset !== manifest.asset || first.asset_contract !== manifest.asset_contract) {
      throw new KikisAppManifestError(
        `Invalid manifest${context}: assets[0] (${first.asset}:${first.asset_contract}) must match root asset fields (${manifest.asset}:${manifest.asset_contract})`,
      )
    }
  }
}

interface CacheEntry {
  manifest: KikisAppManifest
  fetchedAt: number
  expiresAt: number
}

const CACHE_TTL_MS = 60_000
const DEFAULT_MANIFEST_CACHE_MAX_SIZE = 512
const DEFAULT_MANIFEST_TIMEOUT_MS = 5_000

/**
 * Simple LRU cache backed by Map's insertion-order guarantee.
 * Bounds memory for long-running agents that contact many unique endpoints.
 */
class LruCache<K, V> {
  private map = new Map<K, V>()

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }
    this.map.set(key, value)
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }
}

/** In-memory manifest cache keyed by base URL, bounded to avoid unbounded heap growth. */
const manifestCache = new LruCache<string, CacheEntry>(DEFAULT_MANIFEST_CACHE_MAX_SIZE)

/** In-flight fetch promises keyed by base URL to coalesce concurrent requests. */
const inFlightFetches = new Map<string, Promise<KikisAppManifest>>()

/**
 * Override the manifest cache's max size (default 512). Affects the shared,
 * process-wide cache used by all KikisAppClient instances.
 */
export function configureManifestCache(maxSize: number): void {
  if (!Number.isInteger(maxSize) || maxSize <= 0) {
    throw new KikisAppManifestError('Invalid manifest cache size: ' + maxSize)
  }
  manifestCache.setMaxSize(maxSize)
}

/**
 * Evict a provider's cached manifest immediately, forcing the next
 * `fetchManifest(baseUrl)` to re-fetch and re-validate it. Use when a
 * provider signals that their manifest changed.
 */
export function clearManifestCache(baseUrl?: string): void {
  if (baseUrl) {
    manifestCache.delete(baseUrl)
    inFlightFetches.delete(baseUrl)
  } else {
    manifestCache = new LruCache<string, CacheEntry>(DEFAULT_MANIFEST_CACHE_MAX_SIZE)
    inFlightFetches.clear()
  }
}

/**
 * Options for {@link fetchManifest}. `fetch` lets enterprise agents route
 * manifest discovery through a custom dispatcher (e.g. an undici
 * `EnvHttpProxyAgent` or SOCKS5 agent) instead of the global fetch.
 */
export interface FetchManifestOptions {
  timeoutMs?: number
  retry?: RetryPolicy
  logger?: KikisAppLogger
  fetch?: typeof fetch
}

/**
 * Fetch and validate a provider's manifest from `{baseUrl}/.well-known/kikis-app.json`.
 * Results are cached for 60 seconds and concurrent calls are coalesced.
 */
export async function fetchManifest(
  baseUrl: string,
  options: FetchManifestOptions = {},
): Promise<KikisAppManifest> {
  const { timeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS, retry, logger = noopLogger } = options
  const fetchImpl = options.fetch ?? fetch

  const cached = manifestCache.get(baseUrl)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.manifest
  }

  const inFlight = inFlightFetches.get(baseUrl)
  if (inFlight) return inFlight

  const url = new URL('/.well-known/kikis-app.json', baseUrl).toString()

  const promise = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await withRetry(
        () =>
          fetchImpl(url, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          }),
        retry,
      )
    } catch (err) {
      if (controller.signal.aborted) {
        throw new KikisAppManifestTimeoutError(
          `Timed out fetching manifest from ${url} after ${timeoutMs}ms`,
        )
      }
      throw wrapFetchError(err, `Failed to fetch manifest from ${url}`)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw httpStatusToError(response.status, `Failed to fetch manifest from ${url}`)
    }

    let manifest: KikisAppManifest
    try {
      manifest = (await response.json()) as KikisAppManifest
    } catch (err) {
      throw new KikisAppManifestError(`Manifest at ${url} is not valid JSON: ${String(err)}`)
    }

    const result = validator.validate(manifest)
    if (!result.valid) {
      const details = result.errors.map((e) => `${e.instanceLocation}: ${e.error}`).join('; ')
      throw new KikisAppManifestError(`Invalid manifest at ${url}: ${details}`)
    }

    assertManifestValid(manifest, baseUrl)
    assertManifestActive(manifest, baseUrl)
    assertClientVersionSupported(manifest, baseUrl)

    if (manifest.signature) {
      await verifyManifestSignature(manifest, baseUrl)
    }

    const now = Date.now()
    manifestCache.set(baseUrl, {
      manifest,
      fetchedAt: now,
      expiresAt: now + CACHE_TTL_MS,
    })

    return manifest
  })()

  inFlightFetches.set(baseUrl, promise)
  try {
    return await promise
  } finally {
    inFlightFetches.delete(baseUrl)
  }
}

/**
 * Select the payment mode to use for a request given the manifest's declared
 * modes and the caller's preference. Falls back to the manifest's default mode.
 */
export function selectMode(
  manifest: KikisAppManifest,
  preferred?: PaymentMode,
): PaymentMode {
  const supported = manifest.payment_modes
  if (preferred) {
    if (!supported.includes(preferred)) {
      throw new KikisAppNoSupportedModeError(
        `Provider ${manifest.name} does not support payment mode '${preferred}' (supported: ${supported.join(', ')})`,
      )
    }
    return preferred
  }
  const fallback = manifest.default_mode ?? supported[0]
  if (!fallback) {
    throw new KikisAppNoSupportedModeError(
      `Provider ${manifest.name} declares no payment modes`,
    )
  }
  return fallback
}

/**
 * Compute the price in stroops for a given endpoint and mode from the manifest.
 */
export function priceForEndpoint(
  manifest: KikisAppManifest,
  endpointKey: string,
  mode: PaymentMode,
): bigint {
  const descriptor = manifest.endpoints[endpointKey]
  if (!descriptor) {
    throw new KikisAppManifestError(
      `Provider ${manifest.name} does not declare endpoint '${endpointKey}'`,
    )
  }
  const price = descriptor.price
  const amount = typeof price === 'string' ? price : price[mode]
  if (!amount) {
    throw new KikisAppNoSupportedModeError(
      `Endpoint '${endpointKey}' does not declare a price for mode '${mode}'`,
    )
  }
  return usdcToStroops(amount)
}

/**
 * Enforce a caller-supplied policy against the manifest before paying.
 */
export function assertPolicy(
  manifest: KikisAppManifest,
  options: HttpRequestOptions,
): void {
  const policy = options.policy
  if (!policy) return
  if (policy.maxPriceUsdc !== undefined) {
    const max = usdcToStroops(policy.maxPriceUsdc)
    for (const [key, descriptor] of Object.entries(manifest.endpoints)) {
      const price = descriptor.price
      const amount = typeof price === 'string' ? price : price[manifest.default_mode ?? 'x402']
      if (amount && usdcToStroops(amount) > max) {
        throw new KikisAppPolicyRejectError(
          `Endpoint '${key}' price ${amount} exceeds policy maxPriceUsdc ${policy.maxPriceUsdc}`,
        )
      }
    }
  }
  if (policy.allowedProviders && !policy.allowedProviders.includes(manifest.name)) {
    throw new KikisAppPolicyRejectError(
      `Provider '${manifest.name}' is not in the allowedProviders policy`,
    )
  }
}
