import { describe, expect, it } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import { mirrorPaymentRequiredBody } from '../src/mirror-402-body.js'

const CHALLENGE = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'http://localhost/premium', description: 'Premium content', mimeType: '' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:11142220',
      amount: '10000',
      asset: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    },
  ],
} as Parameters<typeof encodePaymentRequiredHeader>[0]

/** What paymentMiddleware does for an unpaid request: the header, and a `{}` body. */
const unpaid: MiddlewareHandler = async (c, next) => {
  if (c.req.path !== '/premium') return next()
  c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(CHALLENGE))
  return c.json({}, 402)
}

function app(withMirror: boolean) {
  const a = new Hono()
  if (withMirror) a.use(mirrorPaymentRequiredBody)
  a.use(unpaid)
  a.get('/own-402', (c) => c.json({ mine: true }, 402))
  a.get('/200-with-header', (c) => {
    c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(CHALLENGE))
    return c.json({ ok: true })
  })
  return a
}

describe('mirrorPaymentRequiredBody', () => {
  it('control: without it the unpaid 402 body is empty', async () => {
    const res = await app(false).request('/premium')
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({})
  })

  it('puts the decoded header into the 402 body', async () => {
    const res = await app(true).request('/premium')
    expect(res.status).toBe(402)
    const header = res.headers.get('PAYMENT-REQUIRED')
    expect(header).toBeTruthy()
    expect(res.headers.get('Content-Type')).toBe('application/json')
    const body = await res.json()
    expect(body).toEqual(decodePaymentRequiredHeader(header!))
    expect(body).toEqual(CHALLENGE)
  })

  it("leaves a seller's own 402 without the header unchanged", async () => {
    const res = await app(true).request('/own-402')
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ mine: true })
  })

  it('leaves a non-402 alone even when it carries the header', async () => {
    const res = await app(true).request('/200-with-header')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
