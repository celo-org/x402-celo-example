/**
 * x402 payments over A2A (x402-foundation/x402: specs/transports-v2/a2a.md).
 * Laid out like @x402/mcp so it can move into the x402 SDK as @x402/a2a.
 */
export * from './constants.js'
export * from './encoding.js'
export { createPaymentExecutor, errorCodeForInvalidReason } from './server.js'
export type { PaymentExecutorOptions, PaymentOption, PaymentResourceServer } from './server.js'
export { PaymentDeclinedError, x402A2AClient } from './client.js'
export type { A2AMessageSender, PaidResult, PaymentSigner, X402A2AClientOptions } from './client.js'
