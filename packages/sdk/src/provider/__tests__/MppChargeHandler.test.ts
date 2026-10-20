import assert from 'node:assert/strict'
import { mock, describe, it } from 'node:test'
import { createServer } from 'node:http'
import express from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import type { KikisAppManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

let mockReceiptHeaders: Record<string, string> = {}
let mockStatus = 200

const actualMppxServer = await import('mppx/server')

mock.module('mppx/server', {
  namedExports: {
    ...actualMppxServer,
    Mppx: {
      create: () => ({
        'stellar/charge': () => async () => {
          if (mockStatus === 402) {
            return {
              status: 402,
              challenge: new globalThis.Response('challenge', { status: 402 }),
            }
          }
          return {
            status: 200,
            withReceipt: (res: globalThis.Response) => {
              const headers = new globalThis.Headers()
              for (const [k, v] of Object.entries(mockReceiptHeaders)) {
                headers.set(k, v)
              }
              return new globalThis.Response(res.body, { headers })
            },
          }
        },
      }),
    },
  },
})

const { createMppChargeHandler } = await import('../MppChargeHandler.js')

const manifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'MppChargeHandler Test Service',
  description: 'Unit test provider for MppChargeHandler',
  modes: ['mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-charge': { amount: '0.001', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

async function runRequest(opts: {
  headers?: Record<string, string>
  onSettled?: (txHash: string, amount: string, mode: 'mpp-charge', payer?: string | null) => Promise<void>
}): Promise<{ status: number; close: () => Promise<void> }> {
  const app = express()
  const handler = createMppChargeHandler({
    assetContract: ASSET_CONTRACT,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    amount: '0.001',
    manifest,
    onSettled: opts.onSettled as unknown as Parameters<typeof createMppChargeHandler>[0]['onSettled'],
  })

  app.use(handler)
  app.get('/price', (_req, res) => {
    res.json({ price: '42' })
  })

  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const url = `http://127.0.0.1:${port}/price`

      const res = await fetch(url, {
        headers: opts.headers ?? {},
      })

      resolve({
        status: res.status,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

describe('MppChargeHandler — receipt header formats and onSettled (#57)', () => {
  it('parses standard payment-receipt base64 JSON header and invokes onSettled', async () => {
    const rawJson = JSON.stringify({ reference: 'tx_payment_receipt_123' })
    mockReceiptHeaders = {
      'payment-receipt': Buffer.from(rawJson).toString('base64'),
    }
    mockStatus = 200

    let settledCall: { txHash: string; amount: string; mode: string } | null = null

    const req = await runRequest({
      headers: { 'x-payment-idempotency': 'idem-test-1' },
      onSettled: async (txHash, amount, mode) => {
        settledCall = { txHash, amount, mode }
      },
    })
    try {
      assert.equal(req.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.ok(settledCall)
      if (settledCall) {
        assert.equal(settledCall.txHash, 'tx_payment_receipt_123')
        assert.equal(settledCall.amount, '0.001')
        assert.equal(settledCall.mode, 'mpp-charge')
      }
    } finally {
      await req.close()
    }
  })

  it('parses legacy x-payment-response base64 JSON header and invokes onSettled', async () => {
    const rawJson = JSON.stringify({ reference: 'tx_legacy_response_456' })
    mockReceiptHeaders = {
      'x-payment-response': Buffer.from(rawJson).toString('base64'),
    }
    mockStatus = 200

    let settledTx: string | null = null

    const req = await runRequest({
      onSettled: async (txHash) => {
        settledTx = txHash
      },
    })
    try {
      assert.equal(req.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(settledTx, 'tx_legacy_response_456')
    } finally {
      await req.close()
    }
  })

  it('parses plain text x-stellar-tx-hash header and invokes onSettled', async () => {
    mockReceiptHeaders = {
      'x-stellar-tx-hash': '0xdeadbeef1234567890abcdef',
    }
    mockStatus = 200

    let settledTx: string | null = null

    const req = await runRequest({
      onSettled: async (txHash) => {
        settledTx = txHash
      },
    })
    try {
      assert.equal(req.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(settledTx, '0xdeadbeef1234567890abcdef')
    } finally {
      await req.close()
    }
  })

  it('parses mppx header with txHash property and invokes onSettled', async () => {
    const rawJson = JSON.stringify({ txHash: 'tx_from_mppx_header' })
    mockReceiptHeaders = {
      mppx: Buffer.from(rawJson).toString('base64'),
    }
    mockStatus = 200

    let settledTx: string | null = null

    const req = await runRequest({
      onSettled: async (txHash) => {
        settledTx = txHash
      },
    })
    try {
      assert.equal(req.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(settledTx, 'tx_from_mppx_header')
    } finally {
      await req.close()
    }
  })

  it('guarantees onSettled is invoked when receipt header is missing', async () => {
    mockReceiptHeaders = {}
    mockStatus = 200

    let onSettledCalled = false
    let settledTx: string | null = null

    const req = await runRequest({
      headers: { 'x-payment-idempotency': 'idem-empty-header-1' },
      onSettled: async (txHash) => {
        onSettledCalled = true
        settledTx = txHash
      },
    })
    try {
      assert.equal(req.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(onSettledCalled, true, 'onSettled must be invoked even when receipt header is missing')
      assert.equal(typeof settledTx, 'string')
    } finally {
      await req.close()
    }
  })

  it('guarantees onSettled is invoked with deterministic fallback when receipt header is malformed', async () => {
    mockReceiptHeaders = {
      'payment-receipt': Buffer.from('{"not_a_valid_json').toString('base64'),
    }
    mockStatus = 200

    let onSettledCalled = false
    let settledTx: string | null = null

    const req = await runRequest({
      headers: { 'x-payment-idempotency': 'idem-malformed-1' },
      onSettled: async (txHash) => {
        onSettledCalled = true
        settledTx = txHash
      },
    })
    try {
      assert.equal(req.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(onSettledCalled, true, 'onSettled must be called even with malformed receipt header')
      assert.ok(settledTx)
    } finally {
      await req.close()
    }
  })
})
