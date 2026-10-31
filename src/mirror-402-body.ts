import type { MiddlewareHandler } from 'hono'
import { decodePaymentRequiredHeader } from '@x402/core/http'

/**
 * Puts the v2 payment challenge in the 402 body as well as the header.
 *
 * `paymentMiddleware` answers an unpaid request with the challenge only in the
 * `PAYMENT-REQUIRED` header and an empty `{}` body, so anything reading the
 * body (a catalog probe, `curl`, an agent parsing JSON) sees no challenge. The
 * body is decoded from the header itself, so the two cannot disagree.
 *
 * Mount it BEFORE `paymentMiddleware`. It only rewrites responses that are 402
 * and carry the header; your own 402s and every other response pass through.
 */
export const mirrorPaymentRequiredBody: MiddlewareHandler = async (c, next) => {
  await next()
  const header = c.res.headers.get('PAYMENT-REQUIRED')
  if (c.res.status !== 402 || !header) return
  c.res = new Response(JSON.stringify(decodePaymentRequiredHeader(header)), { status: 402, headers: c.res.headers })
}
