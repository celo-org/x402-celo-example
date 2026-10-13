/**
 * Client side of the x402 A2A transport: send a message to a merchant agent
 * and pay automatically when it answers with payment-required.
 *
 *   send message -> task input-required + PaymentRequired
 *   sign with x402Client (its spend controls apply), resend on the same task
 *   -> task completed with receipts, or failed with an error code
 */
import { Role, TaskState, type Message, type SendMessageRequest, type Task } from '@a2a-js/sdk'
import { ServiceParameters, withA2AExtensions, type RequestOptions } from '@a2a-js/sdk/client'
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types'
import { X402_EXTENSION_URI } from './constants.js'
import {
  getPaymentRequired,
  getPaymentStatus,
  getReceipts,
  paymentRejectedMetadata,
  paymentSubmittedMetadata,
  type Metadata,
} from './encoding.js'

/** The A2A client method used; a @a2a-js/sdk Client satisfies it. */
export interface A2AMessageSender {
  sendMessage(params: SendMessageRequest, options?: RequestOptions): Promise<Message | Task>
}

/** Signs payments; an @x402/core x402Client satisfies it. */
export interface PaymentSigner {
  createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>
}

export interface X402A2AClientOptions {
  /** Return false to decline a quote; the merchant is told payment-rejected. Default: pay. */
  onPaymentRequired?: (paymentRequired: PaymentRequired) => boolean | Promise<boolean>
}

export interface PaidResult {
  /** The merchant's final reply: usually the completed or failed task. */
  result: Message | Task
  /** Settlement receipts from the merchant; empty when nothing was paid. */
  receipts: SettleResponse[]
  /** The quote that was answered, if the merchant asked for payment. */
  paymentRequired?: PaymentRequired
}

/** Thrown when the signer refuses a payment, e.g. above the spend cap. The merchant is told payment-rejected. */
export class PaymentDeclinedError extends Error {
  constructor(public readonly paymentRequired: PaymentRequired, cause: unknown) {
    super(`Payment declined: ${(cause as Error)?.message ?? cause}`, { cause })
    this.name = 'PaymentDeclinedError'
  }
}

const isTask = (r: Message | Task): r is Task => 'status' in r
const statusMetadata = (r: Message | Task) => (isTask(r) ? r.status?.message?.metadata : r.metadata)

export function x402A2AClient(a2a: A2AMessageSender, signer: PaymentSigner, opts: X402A2AClientOptions = {}) {
  // The merchant marks the extension required, so every request must activate it.
  const requestOptions: RequestOptions = {
    serviceParameters: ServiceParameters.create(withA2AExtensions(X402_EXTENSION_URI)),
  }

  const send = (text: string, ids: { taskId?: string; contextId?: string }, metadata?: Metadata) =>
    a2a.sendMessage(
      {
        tenant: '',
        message: {
          messageId: crypto.randomUUID(),
          contextId: ids.contextId ?? '',
          taskId: ids.taskId ?? '',
          role: Role.ROLE_USER,
          parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
          metadata,
          extensions: [X402_EXTENSION_URI],
          referenceTaskIds: [],
        },
        configuration: undefined,
        metadata: undefined,
      },
      requestOptions,
    )

  return {
    async sendMessage(text: string, ids: { taskId?: string; contextId?: string } = {}): Promise<PaidResult> {
      const first = await send(text, ids)
      const paymentRequired = getPaymentRequired(statusMetadata(first))
      const awaitingPayment =
        isTask(first) &&
        first.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED &&
        getPaymentStatus(statusMetadata(first)) === 'payment-required'
      if (!awaitingPayment || !paymentRequired) return { result: first, receipts: [] }

      const sameTask = { taskId: first.id, contextId: first.contextId }
      if (opts.onPaymentRequired && !(await opts.onPaymentRequired(paymentRequired))) {
        const result = await send('Declining payment.', sameTask, paymentRejectedMetadata())
        return { result, receipts: getReceipts(statusMetadata(result)), paymentRequired }
      }

      let payload: PaymentPayload
      try {
        payload = await signer.createPaymentPayload(paymentRequired)
      } catch (error) {
        await send('Declining payment.', sameTask, paymentRejectedMetadata())
        throw new PaymentDeclinedError(paymentRequired, error)
      }

      const result = await send('Payment submitted.', sameTask, paymentSubmittedMetadata(payload))
      return { result, receipts: getReceipts(statusMetadata(result)), paymentRequired }
    },
  }
}
