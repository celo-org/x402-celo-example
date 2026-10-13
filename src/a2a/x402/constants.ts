/**
 * Constants of the x402 A2A transport (x402-foundation/x402: specs/transports-v2/a2a.md).
 * The metadata keys, statuses and extension URI are unchanged from v1; only the
 * objects inside the metadata are x402 v2.
 */

/** Extension URI an agent card declares and a client activates. */
export const X402_EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1'

export const X402_METADATA_KEYS = {
  status: 'x402.payment.status',
  required: 'x402.payment.required',
  payload: 'x402.payment.payload',
  receipts: 'x402.payment.receipts',
  error: 'x402.payment.error',
} as const

export const PAYMENT_STATUSES = [
  'payment-required',
  'payment-submitted',
  'payment-rejected',
  'payment-verified',
  'payment-completed',
  'payment-failed',
] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/**
 * The transport spec only gives example codes, so these follow the established
 * a2a-x402 set, which existing A2A payment clients already understand.
 */
export const X402_ERROR_CODES = [
  'INSUFFICIENT_FUNDS',
  'INVALID_SIGNATURE',
  'EXPIRED_PAYMENT',
  'DUPLICATE_NONCE',
  'NETWORK_MISMATCH',
  'INVALID_AMOUNT',
  'SETTLEMENT_FAILED',
] as const
export type X402ErrorCode = (typeof X402_ERROR_CODES)[number]
