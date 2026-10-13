/**
 * In-memory A2A server for tests: the SDK's real request handler and task
 * store, a payment-gated executor, and a fake x402 resource server whose
 * verify/settle results each test controls. No network, no HTTP.
 */
import { vi } from 'vitest'
import { A2A_PROTOCOL_VERSION, Role, TaskState, type AgentCard, type Message, type SendMessageRequest } from '@a2a-js/sdk'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server'
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types'
import { createPaymentExecutor, type PaymentResourceServer } from '../../src/a2a/x402/server.js'
import { X402_EXTENSION_URI } from '../../src/a2a/x402/constants.js'

export const REQUIREMENT: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:11142220',
  asset: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
  amount: '10000',
  payTo: '0x000000000000000000000000000000000000dEaD',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
}

export function signedPayload(accepted: PaymentRequirements = REQUIREMENT): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: {
      signature: '0xsig',
      authorization: { from: '0xbuyer', to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: '9999999999', nonce: '0x01' },
    },
  }
}

export interface FakeServerOptions {
  verify?: () => Promise<VerifyResponse>
  settle?: () => Promise<SettleResponse>
}

export function fakeResourceServer(opts: FakeServerOptions = {}) {
  const server = {
    buildPaymentRequirements: vi.fn(async () => [REQUIREMENT]),
    createPaymentRequiredResponse: vi.fn(async (accepts: PaymentRequirements[], resource: { url: string }, error?: string) => ({
      x402Version: 2,
      resource,
      accepts,
      ...(error ? { error } : {}),
    })),
    findMatchingRequirements: vi.fn((available: PaymentRequirements[], payload: PaymentPayload) =>
      available.find(
        (r) =>
          r.scheme === payload.accepted.scheme &&
          r.network === payload.accepted.network &&
          r.asset === payload.accepted.asset &&
          r.amount === payload.accepted.amount &&
          r.payTo === payload.accepted.payTo,
      ),
    ),
    verifyPayment: vi.fn(opts.verify ?? (async () => ({ isValid: true, payer: '0xbuyer' }))),
    settlePayment: vi.fn(
      opts.settle ?? (async () => ({ success: true, transaction: '0xsettled', network: REQUIREMENT.network, payer: '0xbuyer' })),
    ),
  }
  return server as typeof server & PaymentResourceServer
}

/** The paid work: publishes the task, a text artifact and a completed status. */
export function reportExecutor(): AgentExecutor & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async (ctx, bus) => {
      bus.publish(
        AgentEvent.task(
          ctx.task ?? {
            id: ctx.taskId,
            contextId: ctx.contextId,
            status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
            artifacts: [],
            history: [ctx.userMessage],
            metadata: undefined,
          },
        ),
      )
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          artifact: {
            artifactId: 'report',
            name: 'report',
            description: '',
            parts: [{ content: { $case: 'text', value: 'block 123' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      )
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
          metadata: undefined,
        }),
      )
    }),
    cancelTask: vi.fn(async () => {}),
  } as never
}

const CARD: AgentCard = {
  name: 'Test merchant',
  description: 'test',
  supportedInterfaces: [{ url: 'http://localhost/', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
  provider: undefined,
  version: '1.0.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [{ uri: X402_EXTENSION_URI, description: 'x402', required: true, params: {} }],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
  documentationUrl: '',
  signatures: [],
} as never

export function userMessage(text: string, metadata?: Record<string, unknown>, ids: { taskId?: string; contextId?: string } = {}): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: ids.contextId ?? '',
    taskId: ids.taskId ?? '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata,
    extensions: [X402_EXTENSION_URI],
    referenceTaskIds: [],
  }
}

export function request(message: Message): SendMessageRequest {
  return { tenant: '', message, configuration: undefined, metadata: undefined }
}

/** A merchant wired exactly like production, minus HTTP. */
export function merchant(opts: FakeServerOptions = {}) {
  const resourceServer = fakeResourceServer(opts)
  const inner = reportExecutor()
  const executor = createPaymentExecutor(inner, {
    resourceServer,
    accepts: [{ scheme: 'exact', network: REQUIREMENT.network, payTo: REQUIREMENT.payTo, price: '$0.01' }],
    resource: () => ({ url: 'a2a://test-merchant/report', description: 'Celo network report', mimeType: 'text/plain' }),
  })
  const handler = new DefaultRequestHandler(CARD, new InMemoryTaskStore(), executor)
  // Real clients activate the required extension with the A2A-Extensions header.
  const send = (params: SendMessageRequest) =>
    handler.sendMessage(params, new ServerCallContext({ requestedExtensions: [X402_EXTENSION_URI] }))
  return { resourceServer, inner, handler, send }
}
