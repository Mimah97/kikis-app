import { config as loadDotenv } from 'dotenv'
import path from 'path'
import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { KikisAppClient, FileSpendStore } from '@kikis-app/kikis-app'
import type { SessionHandle } from '@kikis-app/kikis-app'
import { createClient } from '@supabase/supabase-js'
import { TOOLS } from './tools.js'
import {
  handlePayForData,
  handleOpenSession,
  handleStreamSession,
  handleCloseSession,
  handleCheckBalance,
  handleListProviders,
  handleCheckSpendCap,
  handleCheckVaultStatus,
  type HandlerDeps,
  type PayForDataArgs,
  type OpenSessionArgs,
  type StreamSessionArgs,
  type CloseSessionArgs,
  type CheckBalanceArgs,
  type ListProvidersArgs,
} from './handlers.js'
// Load environment variables (supports .env files for external secret management)
const envPath = process.env.KIKIS_APP_ENV_FILE
if (envPath) {
  loadDotenv({ path: envPath })
} else {
  loadDotenv()
}

// Environment variables
const STELLAR_SECRET = process.env.STELLAR_SECRET || process.env.KIKIS_APP_WALLET_SECRET
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'testnet') as 'testnet' | 'mainnet'
const COMMITMENT_SECRET = process.env.COMMITMENT_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY

// Per-tool execution timeout (default 30s). Overridable via env for operators.
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const parsedToolTimeout = Number(process.env.KIKIS_APP_TOOL_TIMEOUT_MS)
const TOOL_TIMEOUT_MS =
  Number.isFinite(parsedToolTimeout) && parsedToolTimeout > 0
    ? parsedToolTimeout
    : DEFAULT_TOOL_TIMEOUT_MS

if (process.env.SUPABASE_SERVICE_KEY) {
  console.warn('WARNING: Using SUPABASE_SERVICE_KEY bypasses RLS. Use an anon key for list_providers (anon + public_read_providers RLS is sufficient).')
}

if (!STELLAR_SECRET) {
  console.error('Error: STELLAR_SECRET or KIKIS_APP_WALLET_SECRET environment variable is required')
  process.exit(1)
}

const KIKIS_APP_DAILY_CAP = process.env.KIKIS_APP_DAILY_CAP
if (!KIKIS_APP_DAILY_CAP) {
  console.error('Error: KIKIS_APP_DAILY_CAP environment variable is required to prevent unbounded spending')
  process.exit(1)
}

const spendStorePath = process.env.KIKIS_APP_SPEND_STORE_PATH || path.join(os.homedir(), '.kikis-app', 'spend.json')

// Initialize KikisApp client
const client = new KikisAppClient({
  wallet: STELLAR_SECRET,
  network: STELLAR_NETWORK,
  commitmentSecret: COMMITMENT_SECRET,
  spendCap: { daily: KIKIS_APP_DAILY_CAP, asset: 'USDC' },
  spendStore: new FileSpendStore(spendStorePath),
})

// Initialize Supabase client for provider registry
let supabase: ReturnType<typeof createClient> | null = null
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
}

// Sessions opened via open_session, keyed by channelId, so a later
// close_session/stream_session call in the same server process can find the
// live handle again. If the process restarts, in-flight sessions are not
// recoverable here — the SDK's own maxDurationMs guard still auto-closes the
// underlying channel on-chain so collateral is never stranded indefinitely.
const openSessions = new Map<string, SessionHandle>()

// Shared dependency bundle passed into every handler
const deps: HandlerDeps = {
  client,
  openSessions,
  supabase: supabase as HandlerDeps['supabase'],
  stellarSecret: STELLAR_SECRET,
  stellarNetwork: STELLAR_NETWORK,
}

// Tool definitions live in tools.ts so they can be imported and tested
// independently without triggering index.ts side-effects.

// Create MCP server
const server = new Server(
  {
    name: '@kikis-app/mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS }
})

// In-flight tool executions keyed by MCP request id, so a cancellation
// notification can abort the matching AbortController.
const inFlightTools = new Map<string | number, AbortController>()

// Listen for MCP protocol cancellation notifications and abort the matching
// in-flight tool execution.
server.setNotificationHandler(
  { method: 'notifications/cancelled' } as never,
  async (notification: { params?: { requestId?: string | number } }) => {
    const requestId = notification?.params?.requestId
    if (requestId === undefined) return
    const controller = inFlightTools.get(requestId)
    if (controller) {
      controller.abort(new Error('Tool execution cancelled by MCP client'))
    }
  }
)

// Call tool handler — delegates to pure handler functions in handlers.ts
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params
  const requestId = extra?.requestId as string | number | undefined

  const controller = new AbortController()
  if (requestId !== undefined) {
    inFlightTools.set(requestId, controller)
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(
        `Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`
      )
      controller.abort(err)
      reject(err)
    }, TOOL_TIMEOUT_MS)
  })

  const runTool = async () => {
    switch (name) {
      case 'pay_for_data':
        return await handlePayForData(args as unknown as PayForDataArgs, deps)

      case 'open_session':
        return await handleOpenSession(args as unknown as OpenSessionArgs, deps, COMMITMENT_SECRET)

      case 'stream_session':
        return await handleStreamSession(args as unknown as StreamSessionArgs, deps)

      case 'close_session':
        return await handleCloseSession(args as unknown as CloseSessionArgs, deps)

      case 'check_balance':
        return await handleCheckBalance(args as unknown as CheckBalanceArgs, deps)

      case 'list_providers':
        return await handleListProviders(args as unknown as ListProvidersArgs, deps)

      case 'check_spend_cap':
        return await handleCheckSpendCap(deps)

      case 'check_vault_status':
      case 'get_vault_status':
        return await handleCheckVaultStatus(deps)

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  try {
    return await Promise.race([runTool(), timeoutPromise])
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        },
      ],
      isError: true,
    }
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (requestId !== undefined) {
      inFlightTools.delete(requestId)
    }
  }
})

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('@kikis-app/mcp-server running on stdio')
}

main().catch((error) => {
  console.error('Server error:', error)
  process.exit(1)
})
