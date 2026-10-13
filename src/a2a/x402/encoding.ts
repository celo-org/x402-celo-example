/**
 * Read and write the x402.payment.* metadata on A2A messages.
 *
 * Getters accept untrusted metadata from the other agent and return undefined
 * for anything that is not a well-formed x402 v2 object, so callers never act
 * on a v1 or garbage payload. Builders drop undefined and null fields, which
 * strict facilitators reject.
 */
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types'
import { PAYMENT_STATUSES, X402_METADATA_KEYS, type PaymentStatus, type X402ErrorCode } from './constants.js'

export type Metadata = Record<string, unknown>

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isRequirement = (v: unknown): boolean =>
  isObject(v) &&
  typeof v.scheme === 'string' &&
  typeof v.network === 'string' &&
  typeof v.asset === 'string' &&
  typeof v.amount === 'string' &&
  typeof v.payTo === 'string'

/** Removes undefined and null values recursively; the result is plain JSON. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_k, v) => (v === null ? undefined : v)))

export function getPaymentStatus(meta: Metadata | undefined): PaymentStatus | undefined {
  const status = meta?.[X402_METADATA_KEYS.status]
  return PAYMENT_STATUSES.includes(status as PaymentStatus) ? (status as PaymentStatus) : undefined
}

export function getPaymentRequired(meta: Metadata | undefined): PaymentRequired | undefined {
  const value = meta?.[X402_METADATA_KEYS.required]
  if (!isObject(value) || value.x402Version !== 2) return undefined
  if (!Array.isArray(value.accepts) || !value.accepts.every(isRequirement)) return undefined
  return value as unknown as PaymentRequired
}

export function getPaymentPayload(meta: Metadata | undefined): PaymentPayload | undefined {
  const value = meta?.[X402_METADATA_KEYS.payload]
  if (!isObject(value) || value.x402Version !== 2) return undefined
  if (!isRequirement(value.accepted) || !isObject(value.payload)) return undefined
  return value as unknown as PaymentPayload
}

export function getReceipts(meta: Metadata | undefined): SettleResponse[] {
  const value = meta?.[X402_METADATA_KEYS.receipts]
  return Array.isArray(value) ? value.filter(isObject).map((r) => r as unknown as SettleResponse) : []
}

export function getPaymentError(meta: Metadata | undefined): string | undefined {
  const value = meta?.[X402_METADATA_KEYS.error]
  return typeof value === 'string' ? value : undefined
}

export function paymentRequiredMetadata(paymentRequired: PaymentRequired): Metadata {
  return {
    [X402_METADATA_KEYS.status]: 'payment-required',
    [X402_METADATA_KEYS.required]: clean(paymentRequired),
  }
}

export function paymentSubmittedMetadata(payload: PaymentPayload): Metadata {
  return {
    [X402_METADATA_KEYS.status]: 'payment-submitted',
    [X402_METADATA_KEYS.payload]: clean(payload),
  }
}

export function paymentRejectedMetadata(): Metadata {
  return { [X402_METADATA_KEYS.status]: 'payment-rejected' }
}

export function paymentCompletedMetadata(receipt: SettleResponse): Metadata {
  return {
    [X402_METADATA_KEYS.status]: 'payment-completed',
    [X402_METADATA_KEYS.receipts]: [clean(receipt)],
  }
}

export function paymentFailedMetadata(code: X402ErrorCode, receipt: SettleResponse): Metadata {
  return {
    [X402_METADATA_KEYS.status]: 'payment-failed',
    [X402_METADATA_KEYS.error]: code,
    [X402_METADATA_KEYS.receipts]: [clean(receipt)],
  }
}

/** A receipt for a payment that did not settle; the spec requires an empty transaction. */
export function failureReceipt(network: Network | string, errorReason: string): SettleResponse {
  return { success: false, errorReason, network: network as Network, transaction: '' }
}
