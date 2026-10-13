import { describe, expect, it } from 'vitest'
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types'
import {
  failureReceipt,
  getPaymentError,
  getPaymentPayload,
  getPaymentRequired,
  getPaymentStatus,
  getReceipts,
  paymentCompletedMetadata,
  paymentFailedMetadata,
  paymentRejectedMetadata,
  paymentRequiredMetadata,
  paymentSubmittedMetadata,
} from '../../src/a2a/x402/encoding.js'
import { X402_METADATA_KEYS } from '../../src/a2a/x402/constants.js'

const requirement = {
  scheme: 'exact',
  network: 'eip155:11142220',
  asset: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
  amount: '10000',
  payTo: '0x000000000000000000000000000000000000dEaD',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
} as const

const paymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: { url: 'a2a://merchant/celo-report', description: 'Celo network report', mimeType: 'text/plain' },
  accepts: [requirement],
}

const payload: PaymentPayload = {
  x402Version: 2,
  accepted: requirement,
  payload: { signature: '0xabc', authorization: { from: '0x1', to: '0x2', value: '10000', validAfter: '0', validBefore: '9', nonce: '0x00' } },
}

const receipt: SettleResponse = { success: true, transaction: '0xtx', network: 'eip155:11142220', payer: '0x1' }

describe('x402 A2A metadata encoding', () => {
  it('round-trips payment-required', () => {
    const meta = paymentRequiredMetadata(paymentRequired)
    expect(meta[X402_METADATA_KEYS.status]).toBe('payment-required')
    expect(getPaymentStatus(meta)).toBe('payment-required')
    expect(getPaymentRequired(meta)).toEqual(paymentRequired)
  })

  it('round-trips payment-submitted', () => {
    const meta = paymentSubmittedMetadata(payload)
    expect(getPaymentStatus(meta)).toBe('payment-submitted')
    expect(getPaymentPayload(meta)).toEqual(payload)
  })

  it('round-trips payment-completed with receipts', () => {
    const meta = paymentCompletedMetadata(receipt)
    expect(getPaymentStatus(meta)).toBe('payment-completed')
    expect(getReceipts(meta)).toEqual([receipt])
  })

  it('round-trips payment-failed with an error code and failure receipt', () => {
    const meta = paymentFailedMetadata('INSUFFICIENT_FUNDS', failureReceipt('eip155:11142220', 'insufficient_funds'))
    expect(getPaymentStatus(meta)).toBe('payment-failed')
    expect(getPaymentError(meta)).toBe('INSUFFICIENT_FUNDS')
    expect(getReceipts(meta)).toEqual([
      { success: false, errorReason: 'insufficient_funds', network: 'eip155:11142220', transaction: '' },
    ])
  })

  it('marks a rejection', () => {
    expect(getPaymentStatus(paymentRejectedMetadata())).toBe('payment-rejected')
  })

  it('strips undefined and null values', () => {
    const meta = paymentRequiredMetadata({ ...paymentRequired, error: undefined, extensions: null as never })
    const stored = meta[X402_METADATA_KEYS.required] as Record<string, unknown>
    expect('error' in stored).toBe(false)
    expect('extensions' in stored).toBe(false)
  })

  it('rejects x402 v1 objects', () => {
    const meta = { [X402_METADATA_KEYS.required]: { x402Version: 1, accepts: [] } }
    expect(getPaymentRequired(meta)).toBeUndefined()
    const v1Payload = { [X402_METADATA_KEYS.payload]: { x402Version: 1, scheme: 'exact', network: 'base', payload: {} } }
    expect(getPaymentPayload(v1Payload)).toBeUndefined()
  })

  it('returns undefined for missing or malformed metadata', () => {
    expect(getPaymentStatus(undefined)).toBeUndefined()
    expect(getPaymentStatus({ [X402_METADATA_KEYS.status]: 'not-a-status' })).toBeUndefined()
    expect(getPaymentRequired({ [X402_METADATA_KEYS.required]: 'garbage' })).toBeUndefined()
    expect(getPaymentPayload({ [X402_METADATA_KEYS.payload]: { x402Version: 2 } })).toBeUndefined()
    expect(getReceipts({ [X402_METADATA_KEYS.receipts]: 'nope' })).toEqual([])
  })
})
