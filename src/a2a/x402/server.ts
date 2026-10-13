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
import type { PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse } from '@x402/core/types'
import { X402_EXTENSION_URI, X402_METADATA_KEYS, type X402ErrorCode } from './constants.js'
import {
  failureReceipt,
  getPaymentPayload,
  getPaymentStatus,
  paymentCompletedMetadata,
  paymentFailedMetadata,
  paymentRejectedMetadata,
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
  /**
   * Optional on-chain check, called only when settlement threw or reported
   * failure. Return the transaction if this payment's transfer landed at or
   * after `since` (when the quote was issued), or undefined if it did not or
   * that cannot be proven. Throwing counts as "did not land". A transfer from
   * before the quote must not count: that is a replayed authorization, not this
   * payment. See eip3009.ts for an EIP-3009 version.
   */
  findSettlement?: (
    payload: PaymentPayload,
    requirement: PaymentRequirements,
    context: { since: Date },
  ) => Promise<{ transaction: string } | undefined>
}

/** How long a submitted authorization stays claimed: longer than any quote can live. */
const CLAIM_SECONDS = 2 * 60 * 60

/**
 * Identifies the authorization a payment spends: its signer and nonce for
 * EIP-3009 and Permit2 payloads, else the signature. One authorization can pay
 * for one task only.
 */
function authorizationKey(payload: PaymentPayload): string {
  const inner = payload.payload as Record<string, { from?: unknown; nonce?: unknown } | unknown>
  const auth = (inner.authorization ?? inner.permit2Authorization) as { from?: unknown; nonce?: unknown } | undefined
  const id = auth?.from && auth?.nonce ? `${auth.from}:${auth.nonce}` : JSON.stringify(inner.signature ?? inner)
  return `${payload.accepted.network}:${payload.accepted.asset}:${id}`.toLowerCase()
}

/** Quote lifetime when a requirement has no maxTimeoutSeconds; quotes never live longer than 12x this. */
const DEFAULT_QUOTE_SECONDS = 300

interface Quote {
  requirements: PaymentRequirements[]
  issuedAt: number
  expiresAt: number
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
  // Requirements quoted per task, kept until the task is paid, rejected or fails,
  // or until the quote expires after its shortest maxTimeoutSeconds. Expired
  // quotes cannot be paid and are swept on every new quote. In memory: a restart
  // drops unpaid quotes and the buyer asks again.
  const pending = new Map<string, Quote>()
  // Authorizations already submitted for some task, with when the claim lapses.
  // Checked before verify, so one signed authorization never unlocks two tasks,
  // even when both are submitted at once.
  const claimed = new Map<string, number>()
  const { resourceServer } = opts

  async function requestPayment(ctx: RequestContext, bus: ExecutionEventBus) {
    const options = typeof opts.accepts === 'function' ? opts.accepts(ctx) : opts.accepts
    const requirements = (await Promise.all(options.map((o) => resourceServer.buildPaymentRequirements(o)))).flat()
    const paymentRequired = await resourceServer.createPaymentRequiredResponse(requirements, opts.resource(ctx))
    const now = Date.now()
    for (const [taskId, quote] of pending) if (quote.expiresAt <= now) pending.delete(taskId)
    for (const [key, until] of claimed) if (until <= now) claimed.delete(key)
    const ttlSeconds = Math.min(...requirements.map((r) => r.maxTimeoutSeconds ?? DEFAULT_QUOTE_SECONDS), DEFAULT_QUOTE_SECONDS * 12)
    pending.set(ctx.taskId, { requirements, issuedAt: now, expiresAt: now + ttlSeconds * 1000 })
    publishTask(ctx, bus, TaskState.TASK_STATE_INPUT_REQUIRED, 'Payment required.', paymentRequiredMetadata(paymentRequired))
  }

  function fail(ctx: RequestContext, bus: ExecutionEventBus, code: X402ErrorCode, receipt: SettleResponse) {
    pending.delete(ctx.taskId)
    publishTask(ctx, bus, TaskState.TASK_STATE_FAILED, `Payment failed: ${code}.`, paymentFailedMetadata(code, receipt))
  }

  async function reconcile(payload: PaymentPayload, requirement: PaymentRequirements, since: Date) {
    if (!opts.findSettlement) return undefined
    try {
      return await opts.findSettlement(payload, requirement, { since })
    } catch (error) {
      console.error('[x402] on-chain settlement check failed:', (error as Error).message)
      return undefined
    }
  }

  async function settleAndRun(ctx: RequestContext, bus: ExecutionEventBus, quote: Quote) {
    const { requirements } = quote
    const network = requirements[0]?.network ?? ''
    const payload = getPaymentPayload(ctx.userMessage.metadata)
    if (!payload) {
      // Name the cause when a client sends another x402 version (e.g. a2a-x402's v1 payloads).
      const raw = ctx.userMessage.metadata?.[X402_METADATA_KEYS.payload] as { x402Version?: unknown } | undefined
      const reason = typeof raw?.x402Version === 'number' && raw.x402Version !== 2 ? 'unsupported_x402_version' : 'invalid_payment_payload'
      return fail(ctx, bus, 'INVALID_SIGNATURE', failureReceipt(network, reason))
    }

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

    const key = authorizationKey(payload)
    if (claimed.has(key)) {
      return fail(ctx, bus, 'DUPLICATE_NONCE', failureReceipt(matched.network, 'authorization_already_submitted'))
    }
    claimed.set(key, Date.now() + CLAIM_SECONDS * 1000)

    let payer: string | undefined
    try {
      const verified = await resourceServer.verifyPayment(payload, matched)
      payer = verified.payer
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
      receipt = failureReceipt(matched.network, reason)
    }
    if (!receipt.success) {
      // The facilitator may have broadcast the transfer before its response was
      // lost or reported a failure. Check the chain before telling the buyer
      // nothing happened; any doubt fails closed.
      const landed = await reconcile(payload, matched, new Date(quote.issuedAt))
      if (!landed) {
        return fail(ctx, bus, 'SETTLEMENT_FAILED', failureReceipt(receipt.network ?? matched.network, receipt.errorReason ?? 'settlement_failed'))
      }
      console.warn(`[x402] settle reported failure but the transfer is on chain: ${landed.transaction || '(tx not found)'}`)
      receipt = { success: true, transaction: landed.transaction, network: matched.network, ...(payer ? { payer } : {}) }
    }

    // Paid. If the work then fails, the buyer still gets the receipt as proof of payment.
    const completed = paymentCompletedMetadata(receipt)
    const gated = withReceipt(bus, ctx, completed)
    try {
      await inner.execute(ctx, gated.bus)
    } catch (error) {
      console.error('[x402] paid work failed after settlement:', (error as Error).message)
      if (!gated.started()) bus.publish(AgentEvent.task(taskSnapshot(ctx)))
      publishStatus(ctx, bus, TaskState.TASK_STATE_FAILED, 'Payment completed, but the work failed.', completed)
    }
  }

  // Payments being processed, per task. A second submission for the same task
  // waits for the first instead of settling again; the outcome reaches both
  // callers through the task's shared event bus.
  const inflight = new Map<string, Promise<void>>()

  return {
    async execute(ctx, bus) {
      if (ctx.context?.requestedExtensions?.includes(X402_EXTENSION_URI)) {
        ctx.context.addActivatedExtension(X402_EXTENSION_URI)
      }
      const running = inflight.get(ctx.taskId)
      if (running) return running

      const status = getPaymentStatus(ctx.userMessage.metadata)
      const quote = pending.get(ctx.taskId)
      const requirements = quote?.requirements

      if (quote && status === 'payment-submitted') {
        pending.delete(ctx.taskId) // claim the quote before the first await
        if (Date.now() >= quote.expiresAt) {
          return fail(ctx, bus, 'EXPIRED_PAYMENT', failureReceipt(quote.requirements[0]?.network ?? '', 'quote_expired'))
        }
        const run = settleAndRun(ctx, bus, quote).finally(() => inflight.delete(ctx.taskId))
        inflight.set(ctx.taskId, run)
        return run
      }
      if (requirements && status === 'payment-rejected') {
        pending.delete(ctx.taskId)
        return publishTask(ctx, bus, TaskState.TASK_STATE_FAILED, 'Payment rejected by the client.', paymentRejectedMetadata())
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

function taskSnapshot(ctx: RequestContext): Task {
  return (
    ctx.task ?? {
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [ctx.userMessage],
      metadata: undefined,
    }
  )
}

function publishStatus(ctx: RequestContext, bus: ExecutionEventBus, state: TaskState, text: string, metadata: Metadata) {
  bus.publish(
    AgentEvent.statusUpdate({
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state, message: agentMessage(ctx, text, metadata), timestamp: new Date().toISOString() },
      metadata: undefined,
    }),
  )
}

/**
 * Publishes the task snapshot (every turn must start with a task or message
 * event), then the new state as a status update: the SDK ends a blocking call
 * on a terminal or input-required status update, not on a task event.
 */
function publishTask(ctx: RequestContext, bus: ExecutionEventBus, state: TaskState, text: string, metadata: Metadata) {
  bus.publish(AgentEvent.task(taskSnapshot(ctx)))
  publishStatus(ctx, bus, state, text, metadata)
}

/**
 * Wraps the bus handed to the paid executor: adds the payment receipt to its
 * terminal status, and records whether it published anything.
 */
function withReceipt(bus: ExecutionEventBus, ctx: RequestContext, metadata: Metadata) {
  let started = false
  const stamp = (status: TaskStatus | undefined) => {
    if (!status || !TERMINAL_STATES.has(status.state)) return
    status.message = status.message
      ? { ...status.message, metadata: { ...status.message.metadata, ...metadata } }
      : agentMessage(ctx, 'Payment completed.', metadata)
  }
  const wrapped = Object.create(bus) as ExecutionEventBus
  wrapped.publish = (event: AgentExecutionEvent) => {
    started = true
    if (event.kind === 'statusUpdate') stamp(event.data.status)
    if (event.kind === 'task') stamp(event.data.status)
    bus.publish(event)
  }
  return { bus: wrapped, started: () => started }
}
