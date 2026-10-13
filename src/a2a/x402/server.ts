/**
 * Server side of the x402 A2A transport: wrap any A2A AgentExecutor so it is
 * paid for before it runs.
 *
 *   message without payment  -> task input-required, payment-required + PaymentRequired
 *   payment-submitted        -> match, verify, settle, then run the wrapped executor;
 *                               its terminal status carries payment-completed + receipt
 *   payment-rejected / error -> task failed, payment-failed + error code + receipt
 *
 * Invariant: the wrapped executor never runs unless settlement succeeded.
 */
import { Role, TaskState, type Message, type Task, type TaskStatus } from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutionEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { x402ResourceServer } from '@x402/core/server'
import type { PaymentRequirements, ResourceInfo, SettleResponse } from '@x402/core/types'
import { X402_EXTENSION_URI, type X402ErrorCode } from './constants.js'
import {
  failureReceipt,
  getPaymentPayload,
  getPaymentStatus,
  paymentCompletedMetadata,
  paymentFailedMetadata,
  paymentRequiredMetadata,
  type Metadata,
} from './encoding.js'

/** The parts of x402ResourceServer this executor uses; call initialize() on it first. */
export type PaymentResourceServer = Pick<
  x402ResourceServer,
  'buildPaymentRequirements' | 'createPaymentRequiredResponse' | 'findMatchingRequirements' | 'verifyPayment' | 'settlePayment'
>

/** What a merchant charges, as accepted by x402ResourceServer.buildPaymentRequirements. */
export type PaymentOption = Parameters<x402ResourceServer['buildPaymentRequirements']>[0]

export interface PaymentExecutorOptions {
  /** An initialized x402ResourceServer (or a compatible object in tests). */
  resourceServer: PaymentResourceServer
  /** Payment options offered for a request; a function can price per request. */
  accepts: PaymentOption[] | ((ctx: RequestContext) => PaymentOption[])
  /** Describes what is being sold; becomes PaymentRequired.resource. */
  resource: (ctx: RequestContext) => ResourceInfo
}

const TERMINAL_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
])

/** Maps a facilitator invalidReason onto the transport's error codes. */
export function errorCodeForInvalidReason(reason: string | undefined): X402ErrorCode {
  if (!reason) return 'INVALID_SIGNATURE'
  if (/insufficient/i.test(reason)) return 'INSUFFICIENT_FUNDS'
  if (/expire|valid_?before/i.test(reason)) return 'EXPIRED_PAYMENT'
  if (/nonce|replay|already/i.test(reason)) return 'DUPLICATE_NONCE'
  return 'INVALID_SIGNATURE'
}

export function createPaymentExecutor(inner: AgentExecutor, opts: PaymentExecutorOptions): AgentExecutor {
  // Requirements quoted per task, kept until the task is paid or fails. In memory:
  // a merchant restart drops unpaid quotes, and the buyer simply asks again.
  const pending = new Map<string, PaymentRequirements[]>()
  const { resourceServer } = opts

  async function requestPayment(ctx: RequestContext, bus: ExecutionEventBus) {
    const options = typeof opts.accepts === 'function' ? opts.accepts(ctx) : opts.accepts
    const requirements = (await Promise.all(options.map((o) => resourceServer.buildPaymentRequirements(o)))).flat()
    const paymentRequired = await resourceServer.createPaymentRequiredResponse(requirements, opts.resource(ctx))
    pending.set(ctx.taskId, requirements)
    publishTask(ctx, bus, TaskState.TASK_STATE_INPUT_REQUIRED, 'Payment required.', paymentRequiredMetadata(paymentRequired))
  }

  function fail(ctx: RequestContext, bus: ExecutionEventBus, code: X402ErrorCode, receipt: SettleResponse) {
    pending.delete(ctx.taskId)
    publishTask(ctx, bus, TaskState.TASK_STATE_FAILED, `Payment failed: ${code}.`, paymentFailedMetadata(code, receipt))
  }

  async function settleAndRun(ctx: RequestContext, bus: ExecutionEventBus, requirements: PaymentRequirements[]) {
    const network = requirements[0]?.network ?? ''
    const payload = getPaymentPayload(ctx.userMessage.metadata)
    if (!payload) return fail(ctx, bus, 'INVALID_SIGNATURE', failureReceipt(network, 'invalid_payment_payload'))

    const matched = resourceServer.findMatchingRequirements(requirements, payload)
    if (!matched) {
      const sameNetwork = requirements.some((r) => r.network === payload.accepted.network)
      return fail(
        ctx,
        bus,
        sameNetwork ? 'INVALID_AMOUNT' : 'NETWORK_MISMATCH',
        failureReceipt(payload.accepted.network, 'payment_does_not_match_requirements'),
      )
    }

    try {
      const verified = await resourceServer.verifyPayment(payload, matched)
      if (!verified.isValid) {
        const reason = verified.invalidReason ?? 'invalid_payment'
        return fail(ctx, bus, errorCodeForInvalidReason(reason), failureReceipt(matched.network, reason))
      }
    } catch (error) {
      // HTTPFacilitatorClient throws VerifyError on a non-200 verify; its
      // invalidReason is a facilitator code (e.g. insufficient_funds) and safe to pass on.
      const reason = reasonCode(error, 'invalidReason')
      if (reason) return fail(ctx, bus, errorCodeForInvalidReason(reason), failureReceipt(matched.network, reason))
      console.error('[x402] verify failed:', (error as Error).message)
      return fail(ctx, bus, 'SETTLEMENT_FAILED', failureReceipt(matched.network, 'facilitator_verify_error'))
    }

    let receipt: SettleResponse
    try {
      receipt = await resourceServer.settlePayment(payload, matched)
    } catch (error) {
      console.error('[x402] settle failed:', (error as Error).message)
      const reason = reasonCode(error, 'errorReason') ?? 'facilitator_settle_error'
      return fail(ctx, bus, 'SETTLEMENT_FAILED', failureReceipt(matched.network, reason))
    }
    if (!receipt.success) {
      return fail(ctx, bus, 'SETTLEMENT_FAILED', failureReceipt(receipt.network ?? matched.network, receipt.errorReason ?? 'settlement_failed'))
    }

    pending.delete(ctx.taskId)
    await inner.execute(ctx, withReceipt(bus, ctx, paymentCompletedMetadata(receipt)))
  }

  return {
    async execute(ctx, bus) {
      if (ctx.context?.requestedExtensions?.includes(X402_EXTENSION_URI)) {
        ctx.context.addActivatedExtension(X402_EXTENSION_URI)
      }
      const status = getPaymentStatus(ctx.userMessage.metadata)
      const requirements = pending.get(ctx.taskId)

      if (requirements && status === 'payment-submitted') return settleAndRun(ctx, bus, requirements)
      if (requirements && status === 'payment-rejected') {
        return fail(ctx, bus, 'SETTLEMENT_FAILED', failureReceipt(requirements[0]?.network ?? '', 'payment_rejected_by_client'))
      }
      // Anything else (a new request, or a message on an unpaid task without a
      // payment) gets a fresh quote. Work only ever runs from settleAndRun.
      return requestPayment(ctx, bus)
    },
    cancelTask: (taskId, bus) => {
      pending.delete(taskId)
      return inner.cancelTask(taskId, bus)
    },
  }
}

/**
 * Reads the facilitator reason code from a VerifyError (invalidReason) or
 * SettleError (errorReason). Only snake_case codes are passed on, never free
 * text, so an error message cannot leak into the receipt.
 */
function reasonCode(error: unknown, field: 'invalidReason' | 'errorReason'): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[field]
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : undefined
}

function agentMessage(ctx: RequestContext, text: string, metadata: Metadata): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: ctx.contextId,
    taskId: ctx.taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata,
    extensions: [X402_EXTENSION_URI],
    referenceTaskIds: [],
  }
}

/**
 * Publishes the task snapshot (every turn must start with a task or message
 * event), then the new state as a status update: the SDK ends a blocking call
 * on a terminal or input-required status update, not on a task event.
 */
function publishTask(ctx: RequestContext, bus: ExecutionEventBus, state: TaskState, text: string, metadata: Metadata) {
  const now = new Date().toISOString()
  const task: Task = ctx.task ?? {
    id: ctx.taskId,
    contextId: ctx.contextId,
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now },
    artifacts: [],
    history: [ctx.userMessage],
    metadata: undefined,
  }
  bus.publish(AgentEvent.task(task))
  bus.publish(
    AgentEvent.statusUpdate({
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state, message: agentMessage(ctx, text, metadata), timestamp: now },
      metadata: undefined,
    }),
  )
}

/** Adds the payment receipt to the status message of the wrapped executor's terminal status. */
function withReceipt(bus: ExecutionEventBus, ctx: RequestContext, metadata: Metadata): ExecutionEventBus {
  const stamp = (status: TaskStatus | undefined) => {
    if (!status || !TERMINAL_STATES.has(status.state)) return
    status.message = status.message
      ? { ...status.message, metadata: { ...status.message.metadata, ...metadata } }
      : agentMessage(ctx, 'Payment completed.', metadata)
  }
  const wrapped = Object.create(bus) as ExecutionEventBus
  wrapped.publish = (event: AgentExecutionEvent) => {
    if (event.kind === 'statusUpdate') stamp(event.data.status)
    if (event.kind === 'task') stamp(event.data.status)
    bus.publish(event)
  }
  return wrapped
}
