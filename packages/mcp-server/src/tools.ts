/**
 * tools.ts
 *
 * MCP tool schema definitions, extracted from index.ts so they can be
 * imported and tested independently without triggering index.ts side-effects
 * (env validation, process.exit, server startup).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * Upper bound on how many streamed messages stream_session may pull in one
 * call. Each message costs one session voucher, and any voucher after the
 * first can reject mid-batch, so an unbounded batch could commit an arbitrary
 * slice of the caller's daily spend cap before failing.
 */
export const MAX_STREAM_MESSAGES = 50

/**
 * Pagination bounds for list_providers. The registry can scale to hundreds of
 * providers, so results are paged to keep tool responses within LLM context
 * limits and to bound tool call latency.
 */
export const DEFAULT_LIST_PROVIDERS_LIMIT = 20
export const MAX_LIST_PROVIDERS_LIMIT = 100

export const TOOLS: Tool[] = [
  {
    name: 'pay_for_data',
    description:
      'Pay for a single discrete data request from a KikisApp provider using per-request payment modes (x402 or mpp-charge). Automatically selects the best discrete payment mode based on the provider\'s manifest. For streaming or session-based providers (mpp-session or mpp-session-ws), use open_session instead.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL of the provider endpoint to pay for (e.g., https://api-a.kikis-app.xyz/price)',
        },
        max_amount: {
          type: 'string',
          description: 'Maximum amount in USDC to pay for this request (e.g., "0.01")',
        },
        preferred_mode: {
          type: 'string',
          enum: ['x402', 'mpp-charge'],
          description:
            'Optional preferred payment mode for discrete requests ("x402" or "mpp-charge"). If not specified, the best discrete mode is selected automatically. For streaming session modes (mpp-session or mpp-session-ws), use open_session instead.',
        },
      },
      required: ['url', 'max_amount'],
    },
  },
  {
    name: 'estimate_cost',
    description:
      'Estimate the financial cost of a provider data feed or API endpoint before paying, so an agent can plan budgets and request human approval if costs exceed thresholds. Returns the asset, amount, network fees, required trustlines, and payment mode. Supports both discrete per-request estimation and streaming session estimation (pass mode "mpp-session" or "mpp-session-ws" with an optional session_duration_seconds).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL of the provider endpoint to estimate (e.g., https://api-a.kikis-app.xyz/price)',
        },
        mode: {
          type: 'string',
          enum: ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'],
          description:
            'Optional payment mode to estimate. Discrete modes ("x402", "mpp-charge") estimate a single request; streaming modes ("mpp-session", "mpp-session-ws") estimate a session. If not specified, the best mode is selected automatically.',
        },
        session_duration_seconds: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional session duration in seconds for streaming session estimation (mpp-session or mpp-session-ws). Ignored for discrete modes.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'open_session',
    description:
      "Open a sustained MPP session with a provider for streaming data. Requires COMMITMENT_SECRET to be configured. Returns a channel_id — pass it to stream_session to pull data and to close_session when done, or the channel collateral can never be settled.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The base URL of the provider (e.g., https://api-b.kikis-app.xyz)',
        },
        initial_deposit: {
          type: 'string',
          description:
            "Amount in USDC you intend the channel to be funded with (e.g., \"1.0\"). KikisApp channels are pre-deployed and funded out-of-band before the agent runs — this is checked against the provider's advertised min_deposit as a safety guard, it does not itself move funds.",
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'stream_session',
    description:
      'Pull the next batch of streamed responses from a session opened with open_session. Each message sends a voucher and waits for the provider to acknowledge it. Call repeatedly to keep streaming, then call close_session to settle and release the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel_id returned by open_session',
        },
        max_messages: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_STREAM_MESSAGES,
          description: `Maximum number of messages to pull in this call (1 to ${MAX_STREAM_MESSAGES}, default 1)`,
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'close_session',
    description:
      "Close an MPP session opened with open_session, settling the channel on-chain with the highest signed voucher. This is required to release the session's locked collateral — an open session left unclosed keeps funds locked until the SDK's wall-clock auto-close guard fires.",
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel_id returned by open_session',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'request_refund',
    description:
      'Initiate an on-chain refund challenge for an MPP session channel when the provider has crashed or refuses to settle. Use this to recover locked collateral from a hung session. Returns the refundable amount and the dispute timelock ledger. After calling, monitor progress with get_dispute_status.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel_id returned by open_session',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'get_dispute_status',
    description:
      'Check the dispute status of an MPP session channel, including the current dispute state, remaining timelock ledgers before a refund can be finalized, and the refundable amount. Use after request_refund to monitor the refund window.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel_id returned by open_session',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'check_balance',
    description: 'Check the Stellar wallet balance for the configured account',
    inputSchema: {
      type: 'object',
      properties: {
        asset_code: {
          type: 'string',
          description:
            'Optional asset code to check (e.g., "USDC"). If not specified, returns native XLM balance.',
        },
        asset_issuer: {
          type: 'string',
          description: 'Optional asset issuer address for non-native assets',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_providers',
    description:
      'List available KikisApp providers from the registry. Can filter by capability tags (returns providers matching any of the given tags) and by network. Results are paginated: use limit (default 20, max 100) and offset to page through large registries.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'string',
          description: 'Comma-separated tags to filter providers (e.g., "price,stellar,dex")',
        },
        network: {
          type: 'string',
          enum: ['testnet', 'mainnet'],
          description: 'Filter by Stellar network',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_PROVIDERS_LIMIT,
          description: `Maximum number of providers to return (1 to ${MAX_LIST_PROVIDERS_LIMIT}, default ${DEFAULT_LIST_PROVIDERS_LIMIT})`,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Number of providers to skip before returning results (default 0)',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_spend_cap',
    description:
      'Check the current daily spend cap status, including configured daily cap, total spent today, and remaining spend allowance in USDC.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'check_vault_status',
    description:
      'Check the status of the configured smart vault (e.g. NulthVault or AgentVault), returning active allowlist, current ledger sequence, and session expiry ledger.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
]
