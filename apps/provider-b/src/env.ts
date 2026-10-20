import type { ChannelSession } from './ChannelSession.js'

export interface Env {
  CHANNEL_SESSION: DurableObjectNamespace<ChannelSession>
  STELLAR_NETWORK?: string
  STELLAR_PAYEE_SECRET: string
  STELLAR_PAYEE_ADDRESS: string
  CHANNEL_CONTRACT_ID?: string
  COMMITMENT_PUBLIC_KEY?: string
  USDC_ASSET_CONTRACT?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  /** Public origin recorded on settlement, e.g. https://api-b.kikis-app.xyz */
  PUBLIC_BASE_URL?: string
}

/**
 * Result of validating the worker environment at cold start.
 * `missing` lists required keys that are absent/empty; `invalid` lists keys
 * that are present but malformed (e.g. a Stellar secret key of the wrong shape).
 */
export interface EnvValidationResult {
  ok: boolean
  missing: string[]
  invalid: string[]
}

const STELLAR_SECRET_RE = /^S[A-Z2-7]{55}$/
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Validate required worker environment variables using runtime checks.
 * Fails fast at cold start so missing/malformed secrets surface immediately
 * instead of crashing mid-transaction at payment time.
 */
export function validateWorkerEnv(env: Partial<Env> | undefined): EnvValidationResult {
  const missing: string[] = []
  const invalid: string[] = []

  const required: Array<keyof Env> = ['STELLAR_PAYEE_SECRET', 'STELLAR_PAYEE_ADDRESS']
  for (const key of required) {
    if (!isNonEmptyString(env?.[key])) missing.push(key)
  }

  const secret = env?.STELLAR_PAYEE_SECRET
  if (isNonEmptyString(secret) && !STELLAR_SECRET_RE.test(secret)) {
    invalid.push('STELLAR_PAYEE_SECRET')
  }

  const address = env?.STELLAR_PAYEE_ADDRESS
  if (isNonEmptyString(address) && !STELLAR_ADDRESS_RE.test(address)) {
    invalid.push('STELLAR_PAYEE_ADDRESS')
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid }
}

/**
 * Assert the environment is valid, throwing a descriptive error at cold start.
 * Logs malformed Stellar secret keys immediately so they are visible in logs.
 */
export function assertWorkerEnv(env: Partial<Env> | undefined): void {
  const result = validateWorkerEnv(env)
  if (result.ok) return

  if (result.invalid.includes('STELLAR_PAYEE_SECRET')) {
    console.error('[env] Malformed STELLAR_PAYEE_SECRET: expected 56 chars starting with "S"')
  }
  if (result.missing.length > 0) {
    console.error(`[env] Missing required environment variables: ${result.missing.join(', ')}`)
  }
  if (result.invalid.length > 0) {
    console.error(`[env] Invalid environment variables: ${result.invalid.join(', ')}`)
  }

  throw new Error(
    `Invalid worker environment (missing: [${result.missing.join(', ')}], invalid: [${result.invalid.join(', ')}])`,
  )
}
