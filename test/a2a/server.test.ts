import { describe, expect, it, vi } from 'vitest'
import { TaskState, type Message, type Task } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
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

  it('drops a facilitator reason that is free text instead of a code', async () => {
    const m = merchant({
      settle: async () => {
        throw Object.assign(new Error('x'), { statusCode: 500, errorReason: 'upstream said: key=sk_live_secret rejected' })
      },
    })
    const task = await requirePayment(m)
    const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))
    expect(getReceipts(meta(failed))[0].errorReason).toBe('facilitator_settle_error')
    expect(JSON.stringify(failed)).not.toContain('sk_live_secret')
  })

  it('never leaks the facilitator error text into the receipt', async () => {
    const m = merchant({ settle: async () => { throw new Error('401 key=sk_live_secret') } })
    const task = await requirePayment(m)
    const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))
    expect(JSON.stringify(failed)).not.toContain('sk_live_secret')
  })

  it('settles once and delivers the work when the same payment is submitted twice at once', async () => {
    const m = merchant({
      // Like the real facilitator: a second settlement of the same authorization fails.
      settle: (() => {
        let used = false
        return async () => {
          await new Promise((r) => setTimeout(r, 10))
          if (used) return { success: false, errorReason: 'nonce_already_used', transaction: '', network: REQUIREMENT.network }
          used = true
          return { success: true, transaction: '0xsettled', network: REQUIREMENT.network, payer: '0xbuyer' }
        }
      })(),
    })
    const task = await requirePayment(m)
    const payment = paymentSubmittedMetadata(signedPayload())

    const [a, b] = await Promise.all([submit(m, task, payment), submit(m, task, payment)])

    expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(1)
    expect(m.inner.execute).toHaveBeenCalledTimes(1)
    for (const r of [a, b]) {
      expect(r.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
      expect(getReceipts(meta(r))[0]).toMatchObject({ success: true, transaction: '0xsettled' })
    }
    const stored = await m.handler.getTask({ tenant: '', id: task.id, historyLength: undefined }, new ServerCallContext())
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('never settles two different payments for one task', async () => {
    const m = merchant()
    const task = await requirePayment(m)
    const first = paymentSubmittedMetadata(signedPayload())
    const second = paymentSubmittedMetadata({ ...signedPayload(), payload: { ...signedPayload().payload, signature: '0xother' } })

    await Promise.all([submit(m, task, first), submit(m, task, second)])

    expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(1)
    expect(m.inner.execute).toHaveBeenCalledTimes(1)
  })

  it('returns the receipt when the paid work fails after settlement', async () => {
    const m = merchant()
    m.inner.execute.mockImplementationOnce(async () => {
      throw new Error('rpc timeout at https://internal.example')
    })
    const task = await requirePayment(m)

    const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(getPaymentStatus(meta(failed))).toBe('payment-completed')
    expect(getReceipts(meta(failed))).toEqual([{ success: true, transaction: '0xsettled', network: REQUIREMENT.network, payer: '0xbuyer' }])
    expect(JSON.stringify(failed)).not.toContain('internal.example')
  })

  it('lets the paid executor use the whole event bus API (finished, on/off)', async () => {
    const m = merchant()
    const original = m.inner.execute.getMockImplementation()!
    m.inner.execute.mockImplementationOnce(async (ctx, bus) => {
      const listener = () => {}
      bus.on('event', listener)
      bus.off('event', listener)
      await original(ctx, bus)
      bus.finished()
    })
    const task = await requirePayment(m)

    const done = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(getPaymentStatus(meta(done))).toBe('payment-completed')
  })

  it('refuses to settle a quote after it expired (maxTimeoutSeconds)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const m = merchant()
      const task = await requirePayment(m)
      vi.setSystemTime(Date.now() + (REQUIREMENT.maxTimeoutSeconds + 1) * 1000)

      const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

      expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
      expect(getPaymentError(meta(failed))).toBe('EXPIRED_PAYMENT')
      expect(getReceipts(meta(failed))[0]).toMatchObject({ success: false, errorReason: 'quote_expired', transaction: '' })
      expect(m.resourceServer.verifyPayment).not.toHaveBeenCalled()
      expect(m.inner.execute).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still settles a quote paid just before it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const m = merchant()
      const task = await requirePayment(m)
      vi.setSystemTime(Date.now() + (REQUIREMENT.maxTimeoutSeconds - 1) * 1000)

      const done = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

      expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('reconciling a lost settle response (findSettlement)', () => {
    const lost = async (): Promise<never> => {
      throw new Error('socket hang up')
    }

    it('completes the task when the transfer is found on chain after settle threw', async () => {
      const findSettlement = vi.fn(async () => ({ transaction: '0xfoundonchain' }))
      const m = merchant({ settle: lost, findSettlement })
      const task = await requirePayment(m)

      const done = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

      expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
      expect(getReceipts(meta(done))).toEqual([
        { success: true, transaction: '0xfoundonchain', network: REQUIREMENT.network, payer: '0xbuyer' },
      ])
      expect(findSettlement).toHaveBeenCalledWith(expect.objectContaining({ accepted: REQUIREMENT }), REQUIREMENT, { since: expect.any(Date) })
      expect(m.inner.execute).toHaveBeenCalledTimes(1)
    })

    it('completes the task when settle reported failure but the transfer landed', async () => {
      const m = merchant({
        settle: async () => ({ success: false, errorReason: 'timeout', transaction: '', network: REQUIREMENT.network }),
        findSettlement: async () => ({ transaction: '0xlanded' }),
      })
      const task = await requirePayment(m)

      const done = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

      expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
      expect(getReceipts(meta(done))[0]).toMatchObject({ success: true, transaction: '0xlanded' })
    })

    it('fails as before when the transfer is not on chain', async () => {
      const m = merchant({ settle: lost, findSettlement: async () => undefined })
      const task = await requirePayment(m)

      const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

      expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
      expect(getPaymentError(meta(failed))).toBe('SETTLEMENT_FAILED')
      expect(m.inner.execute).not.toHaveBeenCalled()
    })

    it('fails closed when the on-chain check itself errors', async () => {
      const m = merchant({ settle: lost, findSettlement: async () => { throw new Error('rpc down') } })
      const task = await requirePayment(m)

      const failed = await submit(m, task, paymentSubmittedMetadata(signedPayload()))

      expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
      expect(getReceipts(meta(failed))[0]).toMatchObject({ success: false, errorReason: 'facilitator_settle_error' })
      expect(m.inner.execute).not.toHaveBeenCalled()
    })

    it('does not unlock work by replaying an authorization that was already used', async () => {
      // The facilitator's verify lets the replay through, settle then fails
      // (nonce used), and the chain truthfully says the authorization is used.
      const findSettlement = vi.fn(async () => ({ transaction: '0xoriginalpayment' }))
      const m = merchant({
        settle: async () => ({ success: false, errorReason: 'nonce_already_used', transaction: '', network: REQUIREMENT.network }),
        findSettlement,
      })
      const replayed = paymentSubmittedMetadata(signedPayload())

      const first = await submit(m, await requirePayment(m), replayed)
      const second = await submit(m, await requirePayment(m), replayed)

      expect([first, second].filter((t) => t.status?.state === TaskState.TASK_STATE_COMPLETED)).toHaveLength(1)
      expect(m.inner.execute).toHaveBeenCalledTimes(1)
    })

    it('does not unlock two tasks with one authorization submitted to both at once', async () => {
      // Realistic facilitator: both verifies pass (nonce still unused), the first
      // settle lands, the second fails because the nonce is now used.
      let settled = false
      const m = merchant({
        settle: async () => {
          await new Promise((r) => setTimeout(r, 5))
          if (settled) return { success: false, errorReason: 'nonce_already_used', transaction: '', network: REQUIREMENT.network }
          settled = true
          return { success: true, transaction: '0xonce', network: REQUIREMENT.network, payer: '0xbuyer' }
        },
        findSettlement: async () => ({ transaction: '0xonce' }),
      })
      const shared = paymentSubmittedMetadata(signedPayload())
      const [taskA, taskB] = [await requirePayment(m), await requirePayment(m)]

      const results = await Promise.all([submit(m, taskA, shared), submit(m, taskB, shared)])

      expect(results.filter((t) => t.status?.state === TaskState.TASK_STATE_COMPLETED)).toHaveLength(1)
      const loser = results.find((t) => t.status?.state === TaskState.TASK_STATE_FAILED)!
      expect(getPaymentError(meta(loser))).toBe('DUPLICATE_NONCE')
      expect(m.inner.execute).toHaveBeenCalledTimes(1)
    })

    it('passes the quote time so the check can ignore transfers from before the quote', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const findSettlement = vi.fn(async () => undefined)
        const m = merchant({ settle: lost, findSettlement })
        const quotedAt = Date.now()
        const task = await requirePayment(m)
        vi.setSystemTime(quotedAt + 3 * 60_000) // the buyer pays three minutes later

        await submit(m, task, paymentSubmittedMetadata(signedPayload()))

        const [, , { since }] = findSettlement.mock.calls[0] as unknown as [unknown, unknown, { since: Date }]
        expect(since.getTime()).toBe(quotedAt)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not consulted when settlement succeeded or verification failed', async () => {
      const findSettlement = vi.fn(async () => ({ transaction: '0xnever' }))
      const ok = merchant({ findSettlement })
      await submit(ok, await requirePayment(ok), paymentSubmittedMetadata(signedPayload()))
      const invalid = merchant({ findSettlement, verify: async () => ({ isValid: false, invalidReason: 'insufficient_funds' }) })
      await submit(invalid, await requirePayment(invalid), paymentSubmittedMetadata(signedPayload()))

      expect(findSettlement).not.toHaveBeenCalled()
      expect(invalid.inner.execute).not.toHaveBeenCalled()
    })
  })

  it('fails the task without settling when the buyer rejects', async () => {
    const m = merchant()
    const task = await requirePayment(m)

    const failed = await submit(m, task, paymentRejectedMetadata())

    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(getPaymentStatus(meta(failed))).toBe('payment-rejected')
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
