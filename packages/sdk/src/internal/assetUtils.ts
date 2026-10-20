import type { KikisAppManifest, AssetConfig, PaymentMode } from '../types.js'
import { KikisAppManifestError } from '../errors.js'

/**
 * Normalizes a manifest to always have an assets array.
 * Handles backward compatibility with root asset/asset_contract fields.
 */
export function normalizeManifestAssets(manifest: KikisAppManifest): AssetConfig[] {
  if (manifest.assets && manifest.assets.length > 0) {
    return manifest.assets
  }

  if (manifest.asset && manifest.asset_contract) {
    return [
      {
        asset: manifest.asset,
        asset_contract: manifest.asset_contract,
      },
    ]
  }

  throw new KikisAppManifestError(
    'Manifest must define either assets[] or root asset/asset_contract fields',
  )
}

/**
 * Finds eligible assets for a given mode and optional endpoint.
 * Returns all assets that match the criteria.
 */
export function getEligibleAssets(
  manifest: KikisAppManifest,
  mode: PaymentMode,
  endpoint?: string,
): AssetConfig[] {
  const assets = normalizeManifestAssets(manifest)

  return assets.filter((asset) => {
    // Check mode eligibility
    if (asset.modes && !asset.modes.includes(mode)) {
      return false
    }

    // Check endpoint eligibility
    if (endpoint && asset.endpoints && asset.endpoints.length > 0) {
      const trimmedEndpoint = endpoint.replace(/^\//, '')
      if (asset.endpoints.includes(endpoint) || asset.endpoints.includes(trimmedEndpoint)) {
        return true
      }

      // Check if endpoint matches a descriptor path or key in manifest.endpoints
      if (manifest.endpoints) {
        let pathname = endpoint
        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
          try {
            pathname = new URL(endpoint).pathname
          } catch {
            // invalid URL, keep endpoint as is
          }
        }
        const trimmedPathname = pathname.replace(/^\//, '')

        // Check if any matching endpoint descriptor matches
        const matchesEndpoint = Object.entries(manifest.endpoints).some(([key, desc]) => {
          const pathMatches =
            desc.path === pathname ||
            desc.path === endpoint ||
            desc.path.replace(/\/+$/, '') === pathname.replace(/\/+$/, '') ||
            desc.path.replace(/^\//, '') === trimmedPathname
          const keyMatches = key === endpoint || key === trimmedEndpoint
          if (pathMatches || keyMatches) {
            return (
              asset.endpoints!.includes(key) ||
              asset.endpoints!.includes(desc.path) ||
              asset.endpoints!.includes(desc.path.replace(/^\//, ''))
            )
          }
          return false
        })

        if (!matchesEndpoint) {
          return false
        }
      } else {
        return false
      }
    }

    return true
  })
}

/**
 * Resolves the asset contract for a mode and optional endpoint.
 *
 * A developer-supplied `explicitContract` always wins — even when the
 * manifest defines a multi-asset `assets` array — so a specific SAC contract
 * can be pinned deliberately during migration or testing (#45). Without it,
 * the contract comes from `selectAsset` (multi-asset `assets[]` when present,
 * root `asset_contract` for legacy manifests).
 */
export function resolveAssetContract(
  manifest: KikisAppManifest,
  mode: PaymentMode,
  endpoint?: string,
  explicitContract?: string,
): string {
  if (explicitContract) {
    if (!isSacContractAddress(explicitContract)) {
      throw new KikisAppManifestError(
        `explicitContract is not a valid Stellar asset contract address: '${explicitContract}'`,
      )
    }
    return explicitContract
  }
  return selectAsset(manifest, mode, endpoint).asset_contract
}

/**
 * SAC (Stellar Asset Contract) addresses are C-prefixed, 56-character
 * base32 strkeys — e.g. `CBIELTK6...QDAMA`.
 */
function isSacContractAddress(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value)
}

/**
 * Selects a single asset for payment, given a mode and optional endpoint.
 * Returns the first eligible asset, or throws if none are available.
 */
export function selectAsset(
  manifest: KikisAppManifest,
  mode: PaymentMode,
  endpoint?: string,
): AssetConfig {
  const eligible = getEligibleAssets(manifest, mode, endpoint)

  if (eligible.length === 0) {
    const endpointMsg = endpoint ? ` for endpoint '${endpoint}'` : ''
    throw new KikisAppManifestError(
      `No eligible assets found for mode '${mode}'${endpointMsg}`,
    )
  }

  return eligible[0]!
}

/**
 * Selects the first eligible asset that passes the supplied predicate,
 * iterating in manifest preference order. Used for dynamic asset fallback
 * negotiation (#99): when the primary asset fails a wallet preflight check
 * (e.g. missing trustline or insufficient balance), the next eligible asset
 * is tried instead of aborting.
 *
 * Returns the first passing asset, or `undefined` when none pass. Callers are
 * responsible for surfacing a combined error listing all attempted assets.
 */
export function selectAssetWithFallback(
  manifest: KikisAppManifest,
  mode: PaymentMode,
  endpoint: string | undefined,
  isEligible: (asset: AssetConfig) => boolean,
): AssetConfig | undefined {
  const eligible = getEligibleAssets(manifest, mode, endpoint)
  return eligible.find((asset) => isEligible(asset))
}

/**
 * Checks if a specific asset (by ticker or contract address) is eligible for a mode/endpoint.
 */
export function isAssetEligible(
  manifest: KikisAppManifest,
  assetIdentifier: string,
  mode: PaymentMode,
  endpoint?: string,
): boolean {
  const eligible = getEligibleAssets(manifest, mode, endpoint)

  return eligible.some(
    (asset) =>
      asset.asset === assetIdentifier || asset.asset_contract === assetIdentifier,
  )
}
