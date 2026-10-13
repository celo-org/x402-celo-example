import { describe, expect, it, vi } from 'vitest'
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import type { PaymentRequired } from '@x402/core/types'
import { merchant, REQUIREMENT, signedPayload } from './harness.js'
import { PaymentDeclinedError, x402A2AClient } from '../../src/a2a/x402/client.js'
import { getPaymentStatus } from '../../src/a2a/x402/encoding.js'

const payer = () => ({ createPaymentPayload: vi.fn(async (_pr: PaymentRequired) => signedPayload()) })
const isTask = (r: Message | Task): r is Task => 'status' in r

describe('x402A2AClient', () => {
  it('pays a payment-required task and resubmits on the same task', async () => {
    const m = merchant()
    const p = payer()

    const { result, receipts, paymentRequired } = await x402A2AClient(m.client, p).sendMessage('network report please')

    expect(isTask(result) && result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(receipts).toEqual([{ success: true, transaction: '0xsettled', network: REQUIREMENT.network, payer: '0xbuyer' }])
    expect(paymentRequired?.accepts).toEqual([REQUIREMENT])
    expect(p.createPaymentPayload).toHaveBeenCalledTimes(1)

    const [first, second] = m.client.sendMessage.mock.calls.map(([params]) => params.message!)
    expect(second.taskId).toBe((result as Task).id)
    expect(second.contextId).toBe(first.contextId || (result as Task).contextId)
    expect(getPaymentStatus(second.metadata)).toBe('payment-submitted')
    expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(1)
  })

  it('activates the x402 extension on every request', async () => {
    const m = merchant()
    await x402A2AClient(m.client, payer()).sendMessage('network report please')
    for (const [, options] of m.client.sendMessage.mock.calls) {
      expect(Object.values(options?.serviceParameters ?? {}).join()).toContain('a2a-x402')
    }
  })

  it('recovers the paid task with getTask when the payment reply is lost', async () => {
    const m = merchant()
    const flaky = {
      sendMessage: vi.fn(async (params: Parameters<typeof m.client.sendMessage>[0], options?: Parameters<typeof m.client.sendMessage>[1]) => {
        const result = await m.client.sendMessage(params, options)
        // The merchant processed (and settled) the payment, but the response never arrives.
        if (getPaymentStatus(params.message?.metadata) === 'payment-submitted') throw new Error('socket hang up')
        return result
      }),
      getTask: vi.fn((params: { tenant: string; id: string; historyLength?: number }) =>
        m.handler.getTask({ historyLength: undefined, ...params }, new ServerCallContext()),
      ),
    }

    const { result, receipts } = await x402A2AClient(flaky, payer()).sendMessage('network report please')

    expect(flaky.getTask).toHaveBeenCalledTimes(1)
    expect(isTask(result) && result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(receipts[0]).toMatchObject({ success: true, transaction: '0xsettled' })
    expect(m.resourceServer.settlePayment).toHaveBeenCalledTimes(1)
  })

  it('names the task when the payment reply is lost and the task cannot be fetched', async () => {
    const m = merchant()
    const flaky = {
      sendMessage: vi.fn(async (params: Parameters<typeof m.client.sendMessage>[0], options?: Parameters<typeof m.client.sendMessage>[1]) => {
        if (getPaymentStatus(params.message?.metadata) === 'payment-submitted') throw new Error('socket hang up')
        return m.client.sendMessage(params, options)
      }),
    }

    await expect(x402A2AClient(flaky, payer()).sendMessage('network report please')).rejects.toThrow(/task [0-9a-f-]{36}.*check it before paying again/)
  })

  it('returns a plain message reply without paying', async () => {
    const reply: Message = {
      messageId: 'm1', contextId: 'c1', taskId: '', role: Role.ROLE_AGENT,
      parts: [{ content: { $case: 'text', value: 'free answer' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    }
    const a2a = { sendMessage: vi.fn(async () => reply) }
    const p = payer()

    const { result, receipts } = await x402A2AClient(a2a, p).sendMessage('hi')

    expect(result).toBe(reply)
    expect(receipts).toEqual([])
    expect(p.createPaymentPayload).not.toHaveBeenCalled()
  })

  it('rejects the payment and throws when signing is refused (e.g. above the spend cap)', async () => {
    const m = merchant()
    const p = { createPaymentPayload: vi.fn(async () => { throw new Error('rejected by spend_controls') }) }

    await expect(x402A2AClient(m.client, p).sendMessage('network report please')).rejects.toBeInstanceOf(PaymentDeclinedError)

    const last = m.client.sendMessage.mock.calls.at(-1)![0].message!
    expect(getPaymentStatus(last.metadata)).toBe('payment-rejected')
    expect(m.resourceServer.settlePayment).not.toHaveBeenCalled()
    expect(m.inner.execute).not.toHaveBeenCalled()
  })

  it('rejects without signing when onPaymentRequired declines', async () => {
    const m = merchant()
    const p = payer()
    const onPaymentRequired = vi.fn(() => false)

    const { result } = await x402A2AClient(m.client, p, { onPaymentRequired }).sendMessage('network report please')

    expect(onPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({ x402Version: 2 }))
    expect(isTask(result) && result.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(p.createPaymentPayload).not.toHaveBeenCalled()
    expect(m.resourceServer.settlePayment).not.toHaveBeenCalled()
  })
})
