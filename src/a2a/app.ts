/**
 * HTTP wiring for an A2A agent: agent card plus JSON-RPC endpoint, serving
 * A2A v1.0 clients and, through the SDK's compat layer, A2A v0.3 clients
 * (message/send, the X-A2A-Extensions header). The x402 transport spec's
 * examples and many deployed agents still speak v0.3; the x402.payment.*
 * metadata is the same in both versions.
 */
import express from 'express'
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk'
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'

/**
 * Returns the Express app, the request handler, and the card actually served:
 * `card` plus a v0.3 mirror of its JSON-RPC interface.
 */
export function createA2AApp(card: AgentCard, executor: AgentExecutor) {
  const served: AgentCard = { ...card, supportedInterfaces: duplicateInterfacesForLegacy(card.supportedInterfaces, ['JSONRPC']) }
  const handler = new DefaultRequestHandler(served, new InMemoryTaskStore(), executor)
  const legacyCompat = { enabled: true }

  const app = express()
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler, legacyCompat }))
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication, legacyCompat }))
  return { app, handler, card: served }
}
