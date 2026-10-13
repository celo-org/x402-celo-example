/**
 * The merchant over real HTTP, for A2A v1.0 clients and for v0.3 clients
 * (the wire the x402 transport spec's examples and Google's a2a-x402 use).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { AGENT_CARD_PATH, TaskState } from '@a2a-js/sdk'
import { ClientFactory } from '@a2a-js/sdk/client'
import { LegacyJsonRpcTransport } from '@a2a-js/sdk/compat/v0_3/client'
import { createA2AApp } from '../../src/a2a/app.js'
import { X402_EXTENSION_URI, X402_METADATA_KEYS } from '../../src/a2a/x402/constants.js'
import { getPaymentStatus, paymentSubmittedMetadata } from '../../src/a2a/x402/encoding.js'
import { x402A2AClient } from '../../src/a2a/x402/client.js'
import { cardAt, merchant, signedPayload } from './harness.js'

let server: Server
let base = ''
let m: ReturnType<typeof merchant>

beforeAll(async () => {
  m = merchant()
  // The card needs the URL before listening; a placeholder port is replaced below.
  const { app, card } = createA2AApp(cardAt('http://127.0.0.1:0/'), m.executor)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const i of card.supportedInterfaces) i.url = `${base}/`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** Signs a fresh authorization (new nonce) per payment, like a real buyer. */
const freshPayload = () => {
  const p = signedPayload()
  ;(p.payload.authorization as { nonce: string }).nonce = `0x${crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')}`
  return p
}
const payer = { createPaymentPayload: async () => freshPayload() }

/** A raw A2A v0.3 JSON-RPC call, the way v0.3 clients put it on the wire. */
async function v03(method: string, params: unknown) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-A2A-Extensions': X402_EXTENSION_URI },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  return (await res.json()) as { result?: any; error?: { code: number; message: string } }
}

describe('A2A v0.3 clients', () => {
  it('serves a v0.3 agent card that declares the required x402 extension', async () => {
    const card = (await (await fetch(`${base}/${AGENT_CARD_PATH}`)).json()) as any
    expect(card.protocolVersion).toBe('0.3')
    expect(card.url).toBe(`${base}/`)
    expect(card.capabilities.extensions).toContainEqual(expect.objectContaining({ uri: X402_EXTENSION_URI, required: true }))
  })

  it('completes the payment flow on the raw v0.3 wire (message/send, kind, X-A2A-Extensions)', async () => {
    const quote = await v03('message/send', {
      message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'network report please' }] },
    })
    expect(quote.error).toBeUndefined()
    expect(quote.result.kind).toBe('task')
    expect(quote.result.status.state).toBe('input-required')
    const meta = quote.result.status.message.metadata
    expect(meta[X402_METADATA_KEYS.status]).toBe('payment-required')
    expect(meta[X402_METADATA_KEYS.required].x402Version).toBe(2)

    const paid = await v03('message/send', {
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        taskId: quote.result.id,
        contextId: quote.result.contextId,
        parts: [{ kind: 'text', text: 'paying' }],
        metadata: paymentSubmittedMetadata(freshPayload()),
      },
    })
    expect(paid.error).toBeUndefined()
    expect(paid.result.status.state).toBe('completed')
    expect(paid.result.status.message.metadata[X402_METADATA_KEYS.status]).toBe('payment-completed')
    expect(paid.result.status.message.metadata[X402_METADATA_KEYS.receipts][0]).toMatchObject({ success: true, transaction: '0xsettled' })
    expect(paid.result.artifacts[0].parts[0]).toMatchObject({ kind: 'text', text: 'block 123' })
  })

  it('rejects a v0.3 request that does not activate the required extension', async () => {
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send',
        params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
      }),
    })
    const body = (await res.json()) as { error?: { message: string } }
    expect(body.error?.message).toMatch(/extension/i)
  })

  it('pays through the SDK v0.3 client transport with x402A2AClient', async () => {
    const transport = new LegacyJsonRpcTransport({ endpoint: `${base}/` })
    const { result, receipts } = await x402A2AClient(transport, payer).sendMessage('network report please')
    expect('status' in result && result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(receipts[0]).toMatchObject({ success: true })
  })
})

describe('A2A v1.0 clients', () => {
  it('still pay through the default client', async () => {
    const a2a = await new ClientFactory().createFromUrl(base)
    const { result, receipts } = await x402A2AClient(a2a, payer).sendMessage('network report please')
    expect('status' in result && result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(getPaymentStatus('status' in result ? result.status?.message?.metadata : undefined)).toBe('payment-completed')
    expect(receipts[0]).toMatchObject({ success: true })
  })
})

