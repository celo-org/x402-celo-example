import { describe, expect, it } from 'vitest'
import { TaskState, type Message, type Task } from '@a2a-js/sdk'
import { merchant, request, REQUIREMENT, signedPayload, userMessage } from './harness.js'
import {
  getPaymentError,
  getPaymentRequired,
  getPaymentStatus,
  getReceipts,
  paymentRejectedMetadata,
  paymentSubmittedMetadata,
} from '../../src/a2a/x402/encoding.js'
import { X402_METADATA_KEYS } from '../../src/a2a/x402/constants.js'

const asTask = (r: Message | Task): Task => {
  if (!('status' in r)) throw new Error('expected a task, got a message')
  return r
}
const meta = (t: Task) => t.status?.message?.metadata

/** Asks for the report and returns the payment-required task. */
async function requirePayment(m: ReturnType<typeof merchant>) {
  return asTask(await m.send(request(userMessage('network report please'))))
}

async function submit(m: ReturnType<typeof merchant>, task: Task, metadata: Record<string, unknown>) {
  return asTask(await m.send(request(userMessage('paying', metadata, { taskId: task.id, contextId: task.contextId }))))
}

describe('createPaymentExecutor', () => {
  it('asks for payment before doing any work', async () => {
    const m = merchant()
    const task = await requirePayment(m)

    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(getPaymentStatus(meta(task))).toBe('payment-required')
    const pr = getPaymentRequired(meta(task))
    expect(pr?.x402Version).toBe(2)
    expect(pr?.accepts).toEqual([REQUIREMENT])
    expect(pr?.resource?.url).toBe('a2a://test-merchant/report')
    expect(m.inner.execute).not.toHaveBeenCalled()
  })

  it('verifies, settles, then runs the paid work and attaches the receipt', async () => {
    const m = merchant()
    const task = await requirePayment(m)

    const done = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

    expect(done.id).toBe(task.id)
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(getPaymentStatus(meta(done))).toBe('payment-completed')
    expect(getReceipts(meta(done))).toEqual([{ success: true, transaction: '0xsettled', network: REQUIREMENT.network, payer: '0xbuyer' }])
    expect(done.artifacts.map((a) => a.artifactId)).toEqual(['report'])
    expect(m.resourceServer.verifyPayment).toHaveBeenCalledTimes(1)
    expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(1)
    expect(m.resourceServer.settlePayment.mock.invocationCallOrder[0]).toBeLessThan(m.inner.execute.mock.invocationCallOrder[0])
  })

  const failureCases: Array<{
    name: string
    setup?: Parameters<typeof merchant>[0]
    metadata: () => Record<string, unknown>
    code: string
    verifies: boolean
    settles: boolean
  }> = [
    {
      name: 'payment on a different network',
      metadata: () => paymentSubmittedMetadata(signedPayload({ ...REQUIREMENT, network: 'eip155:42220' })),
      code: 'NETWORK_MISMATCH',
      verifies: false,
      settles: false,
    },
    {
      name: 'payment for a lower amount',
      metadata: () => paymentSubmittedMetadata(signedPayload({ ...REQUIREMENT, amount: '1' })),
      code: 'INVALID_AMOUNT',
      verifies: false,
      settles: false,
    },
    {
      name: 'malformed payload',
      metadata: () => ({ [X402_METADATA_KEYS.status]: 'payment-submitted', [X402_METADATA_KEYS.payload]: { garbage: true } }),
      code: 'INVALID_SIGNATURE',
      verifies: false,
      settles: false,
    },
    {
      name: 'verify reports insufficient funds',
      setup: { verify: async () => ({ isValid: false, invalidReason: 'insufficient_funds' }) },
      metadata: () => paymentSubmittedMetadata(signedPayload()),
      code: 'INSUFFICIENT_FUNDS',
      verifies: true,
      settles: false,
    },
    {
      name: 'verify reports an expired authorization',
      setup: { verify: async () => ({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' }) },
      metadata: () => paymentSubmittedMetadata(signedPayload()),
      code: 'EXPIRED_PAYMENT',
      verifies: true,
      settles: false,
    },
    {
      name: 'verify throws (facilitator unreachable)',
      setup: { verify: async () => { throw new Error('fetch failed') } },
      metadata: () => paymentSubmittedMetadata(signedPayload()),
      code: 'SETTLEMENT_FAILED',
      verifies: true,
      settles: false,
    },
    {
      // HTTPFacilitatorClient throws VerifyError on a non-200 verify, as the Celo facilitator does for insufficient funds.
      name: 'verify throws a VerifyError with a reason',
      setup: { verify: async () => { throw Object.assign(new Error('insufficient_funds'), { statusCode: 400, invalidReason: 'insufficient_funds' }) } },
      metadata: () => paymentSubmittedMetadata(signedPayload()),
      code: 'INSUFFICIENT_FUNDS',
      verifies: true,
      settles: false,
    },
    {
      name: 'settle returns success: false',
      setup: { settle: async () => ({ success: false, errorReason: 'transaction_failed', transaction: '', network: REQUIREMENT.network }) },
      metadata: () => paymentSubmittedMetadata(signedPayload()),
      code: 'SETTLEMENT_FAILED',
      verifies: true,
      settles: true,
    },
    {
      name: 'settle throws (missing API key)',
      setup: { settle: async () => { throw new Error('Facilitator settle failed (401): Missing X-API-Key') } },
      metadata: () => paymentSubmittedMetadata(signedPayload()),
      code: 'SETTLEMENT_FAILED',
      verifies: true,
      settles: true,
    },
  ]

  for (const c of failureCases) {
    it(`fails without running the work: ${c.name}`, async () => {
      const m = merchant(c.setup)
      const task = await requirePayment(m)

      const failed = await submit(m, task, c.metadata())

      expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
      expect(getPaymentStatus(meta(failed))).toBe('payment-failed')
      expect(getPaymentError(meta(failed))).toBe(c.code)
      const [receipt] = getReceipts(meta(failed))
      expect(receipt).toMatchObject({ success: false, transaction: '' })
      expect(typeof receipt.errorReason).toBe('string')
      expect(m.resourceServer.verifyPayment).toHaveBeenCalledTimes(c.verifies ? 1 : 0)
      expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(c.settles ? 1 : 0)
      expect(m.inner.execute).not.toHaveBeenCalled()
    })
  }

  it('keeps the facilitator reason code from a VerifyError in the receipt', async () => {
    const m = merchant({ verify: async () => { throw Object.assign(new Error('x'), { statusCode: 400, invalidReason: 'insufficient_funds' }) } })
    const task = await requirePayment(m)
    const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))
    expect(getReceipts(meta(failed))[0].errorReason).toBe('insufficient_funds')
  })

  it('keeps the facilitator reason code from a SettleError in the receipt', async () => {
    const m = merchant({ settle: async () => { throw Object.assign(new Error('x'), { statusCode: 400, errorReason: 'transaction_reverted' }) } })
    const task = await requirePayment(m)
    const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))
    expect(getPaymentError(meta(failed))).toBe('SETTLEMENT_FAILED')
    expect(getReceipts(meta(failed))[0].errorReason).toBe('transaction_reverted')
  })

  it('never leaks the facilitator error text into the receipt', async () => {
    const m = merchant({ settle: async () => { throw new Error('401 key=sk_live_secret') } })
    const task = await requirePayment(m)
    const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))
    expect(JSON.stringify(failed)).not.toContain('sk_live_secret')
  })

  it('fails the task without settling when the buyer rejects', async () => {
    const m = merchant()
    const task = await requirePayment(m)

    const failed = await submit(m, task, paymentRejectedMetadata())

    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(getPaymentStatus(meta(failed))).toBe('payment-failed')
    expect(m.resourceServer.verifyPayment).not.toHaveBeenCalled()
    expect(m.inner.execute).not.toHaveBeenCalled()
  })

  it('does not settle twice when payment is submitted for an already-paid task', async () => {
    const m = merchant()
    const task = await requirePayment(m)
    await submit(m, task, paymentSubmittedMetadata(signedPayload()))

    // A completed task is terminal: the SDK refuses further messages for it.
    await expect(submit(m, task, paymentSubmittedMetadata(signedPayload()))).rejects.toThrow()
    expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(1)
    expect(m.inner.execute).toHaveBeenCalledTimes(1)
  })

  it('asks for payment again when a new message arrives without payment on a pending task', async () => {
    const m = merchant()
    const task = await requirePayment(m)

    const again = await submit(m, task, {})

    expect(again.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(getPaymentStatus(meta(again))).toBe('payment-required')
    expect(m.inner.execute).not.toHaveBeenCalled()
  })
})
