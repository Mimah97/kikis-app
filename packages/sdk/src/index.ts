// Public API surface for @kikis-app/kikis-app.
//
// Everything a downstream consumer needs — types, errors, client, provider,
// and testing helpers — is re-exported here so custom stores, handlers, and
// middleware never have to reach into undocumented internal paths.

export * from './types.js'
export * from './errors.js'

// Provider internals that are part of the public integration surface.
export {
  InMemorySeenTxStore,
  SETTLEMENT_REPLAY_WINDOW_MS,
  MAX_SETTLEMENT_REPLAYS,
  checkSettlementReplay,
} from './provider/SeenTxStore.js'
export type {
  SettlementScope,
  SettlementRecord,
  SeenTxStore,
  SeenTxStoreOptions,
  InMemorySeenTxStoreOptions,
  SettlementReplayCheck,
} from './provider/SeenTxStore.js'

export type { OrphanedSessionInfo } from './provider/MppSessionHandler.js'
