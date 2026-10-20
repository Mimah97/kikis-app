import { TESTNET_USDC_CONTRACT, type Network } from './manifest.js'
import type { Env } from './env.js'

/**
 * Resolve the USDC asset contract for `network`. Mirrors provider-a's
 * `resolveAssetContract`: an explicit `USDC_ASSET_CONTRACT` always wins,
 * testnet falls back to the well-known testnet SAC, and mainnet without one
 * configured is a hard failure rather than a silently empty asset contract.
 */
export function resolveAssetContract(env: Env, network: Network): string {
  if (env.USDC_ASSET_CONTRACT) return env.USDC_ASSET_CONTRACT
  if (network === 'testnet') return TESTNET_USDC_CONTRACT
  throw new Error('USDC_ASSET_CONTRACT is required for mainnet')
}

/**
 * A Stellar secret key is a 56-character StrKey starting with `S`.
 */
export function isValidStellarSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length === 56 && value.startsWith('S')
}

/**
 * Return the names of environment variables that are unset or malformed.
 * Values are never included — only names, so this is safe to log or return
 * to a caller directly.
 */
export function findConfigProblems(env: Env): string[] {
  const problems: string[] = []

  if (!isValidStellarSecret(env.STELLAR_PAYEE_SECRET)) {
    problems.push('STELLAR_PAYEE_SECRET')
  }
  if (!env.STELLAR_PAYEE_ADDRESS) {
    problems.push('STELLAR_PAYEE_ADDRESS')
  }
  if (!env.COMMITMENT_PUBLIC_KEY) {
    problems.push('COMMITMENT_PUBLIC_KEY')
  }
  if (!env.CHANNEL_CONTRACT_ID) {
    problems.push('CHANNEL_CONTRACT_ID')
  }

  const network: Network = env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  if (network === 'mainnet' && !env.USDC_ASSET_CONTRACT) {
    problems.push('USDC_ASSET_CONTRACT')
  }

  return problems
}

/**
 * Validate required worker environment variables at cold start. Logs the
 * exact missing/malformed keys (never their values) and returns the list so
 * callers can fail fast or surface it on `/health`.
 */
export function validateWorkerEnv(env: Env): string[] {
  const problems = findConfigProblems(env)
  if (problems.length > 0) {
    console.error(
      `[worker] invalid environment configuration: missing or malformed ${problems.join(', ')}`,
    )
  }
  return problems
}
