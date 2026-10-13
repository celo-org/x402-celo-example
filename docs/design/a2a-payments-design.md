# Design: agent-to-agent (A2A) payments on Celo with x402

Status: phase 1 implemented in this repo (src/a2a); phase 2 (upstream) not started
Scope: `celo-org/x402-celo-example` (phase 1), then `x402-foundation/x402` (phase 2)

## Goal

Show two AI agents paying each other in stablecoins on Celo over the A2A protocol with x402 v2. Then contribute the reusable A2A layer to the official x402 TypeScript SDK as `@x402/a2a`, so A2A payments, Celo included, work out of the box.

**Done means:**
1. In this repo, `npm run a2a:merchant` and `npm run a2a:buyer` complete a paid A2A task on Celo Sepolia. The buyer prints the result and a block-explorer link to the settlement transaction.
2. Upstream, a PR to `x402-foundation/x402` adds `typescript/packages/a2a` with unit tests, plus a server and client example.

## Background

- The x402 v2 A2A transport is specified in `x402-foundation/x402: specs/transports-v2/a2a.md`, but no SDK implements it. The MCP transport has packages in TypeScript (`@x402/mcp`) and Python, and this design copies their shape.
- Google's `a2a-x402` repo implements an older v1 version in Python. It has had no maintainer activity since May 2026 and can't express Celo networks, so this design builds on the maintained x402 SDK instead.
- `@x402/evm` ≥ 2.25 lists Celo assets as defaults:
  - `eip155:42220`: USDC, USD₮, USA₮
  - `eip155:11142220`: USDC
- The `@x402/*` packages pinned in this repo (2.27.0) already include these.

## Protocol

This design follows `specs/transports-v2/a2a.md` and adds nothing to it.

1. **Agent card.** The merchant's agent card declares the x402 extension under `capabilities.extensions`, with `required: true` and the URI from the transport spec.
2. **Payment required.** The buyer sends a message. The merchant replies with a task in state input-required. The status message metadata contains:
   - `x402.payment.status: "payment-required"`
   - `x402.payment.required`: a v2 `PaymentRequired` (`x402Version: 2`, `resource`, `accepts[]`)
3. **Payment submitted.** The buyer signs with `x402Client` and sends a message with the same `taskId`. Its metadata contains:
   - `x402.payment.status: "payment-submitted"`
   - `x402.payment.payload`: a v2 `PaymentPayload`
4. **Verify and settle.** The merchant verifies the payload, then settles it through the facilitator. Only after settlement succeeds does it run the paid work.
   - **Success:** state completed, `payment-completed`, `x402.payment.receipts: [SettleResponse]`, and the result as an artifact.
   - **Failure:** state failed, `payment-failed`, an `x402.payment.error` code, and `x402.payment.receipts: [{ success: false, errorReason, network, transaction: "" }]`.
   - **Rejection:** if the buyer declines, it sends `payment-rejected` and the merchant fails the task.

**A2A version.** `@a2a-js/sdk` 1.3 implements A2A v1.0: the `A2A-Extensions` header and `TASK_STATE_*` states. The transport spec's examples use A2A v0.3 terms (`X-A2A-Extensions`, `input-required`). The `x402.payment.*` metadata is the same in both versions, so the implementation targets the SDK's v1.0 API. The upstream PR adds a note to the transport spec covering both versions.

## Components

Phase 1 puts the reusable layer under `src/a2a/x402/`. Its layout matches `typescript/packages/mcp/src` in x402 so phase 2 can move it with minimal changes. Each unit can be tested on its own.

| File | Purpose | Interface | Depends on |
|---|---|---|---|
| `src/a2a/x402/constants.ts` | Extension URI, metadata keys, status values, error codes | constants and types | none |
| `src/a2a/x402/encoding.ts` | Read and write `x402.payment.*` on A2A message metadata. Getters shape-check untrusted input and reject x402 v1 objects. Serialization drops `undefined`/`null`. | `getPaymentStatus(metadata)`, `getPaymentRequired(metadata)`, `getPaymentPayload(metadata)`, `getReceipts(metadata)`, `getPaymentError(metadata)`, `paymentRequiredMetadata(pr)`, `paymentSubmittedMetadata(payload)`, `paymentRejectedMetadata()`, `paymentCompletedMetadata(receipt)`, `paymentFailedMetadata(code, receipt)` | `@x402/core` |
| `src/a2a/x402/server.ts` | Wraps any A2A `AgentExecutor` so it is paid before it runs | `createPaymentExecutor(inner: AgentExecutor, opts: { resourceServer: x402ResourceServer; accepts: PaymentOption[] or (ctx) => PaymentOption[]; resource: (ctx) => ResourceInfo }): AgentExecutor` | `@a2a-js/sdk/server`, `@x402/core/server`, `encoding` |
| `src/a2a/x402/client.ts` | Wraps an A2A client so payment-required replies are paid automatically | `x402A2AClient(a2aClient, x402Client, opts?: { onPaymentRequired?: (pr) => boolean or Promise<boolean> })`, which provides `.sendMessage(text, { taskId?, contextId? }) → Promise<{ result, receipts, paymentRequired? }>` | `@a2a-js/sdk/client`, `@x402/core/client`, `encoding` |
| `src/a2a/x402/index.ts` | Public exports | | |
| `src/a2a/merchant.ts` | Example merchant. Sells a "Celo network report" (latest block number, base fee, timestamp, read through the network RPC) for $0.01. Serves the agent card and A2A endpoint with the SDK's Express integration. | `npm run a2a:merchant` | `x402/*`, `config.ts`, `facilitator.ts` |
| `src/a2a/buyer.ts` | Example buyer. Fetches the agent card, asks for the report, pays within its spend cap, and prints the result and explorer link. | `npm run a2a:buyer` | `x402/*`, `config.ts` |

**Server executor behaviour (`createPaymentExecutor`):**
- **No payment in the message:** build requirements (with `x402ResourceServer.buildPaymentRequirements`) and publish the task as input-required with `payment-required`. Store the requirements per `taskId` in memory until the quote expires (its shortest `maxTimeoutSeconds`); an expired quote fails with `EXPIRED_PAYMENT`.
- **`payment-submitted` on a known task:**
  1. Match `payload.accepted` against the stored requirements on scheme, network, asset, amount and payTo, using the core server's matching.
  2. Verify, then settle.
  3. On success, call the inner executor and attach `payment-completed` with the receipt to the final status.
- **`payment-rejected`:** fail the task. No settlement happens.
- **Invariant:** the inner executor never runs unless settlement succeeded.

**Client behaviour (`x402A2AClient.sendMessage`):**
1. Send the message.
2. If the reply is a task with `payment-required`, parse the `PaymentRequired` and ask `onPaymentRequired` (default: pay).
3. Create the payload with `x402Client.createPaymentPayload` (spend policy applies), then resend on the same `taskId` with `payment-submitted`.
4. Return the final task and its receipts. If the buyer declines, send `payment-rejected`. If the reply to the payment is lost, read the task with `getTask` instead of failing, so the buyer does not pay twice.

## Configuration

Reuse `src/config.ts` and `src/facilitator.ts`.

| Variable | Default | Purpose |
|---|---|---|
| `X402_NETWORK` | `testnet` | `testnet` = Celo Sepolia, `mainnet` = Celo mainnet |
| `X402_TOKEN` | `USDC` | `USDC`; on mainnet also `USDT` (USD₮) or `USAT` (USA₮) |
| `X402_API_KEY` | none | Facilitator key (merchant only). Required for settlement. |
| `SELLER_PAY_TO` | none | Merchant's receiving address |
| `BUYER_PRIVATE_KEY` | none | Throwaway buyer wallet with a little of the chosen token. No CELO needed. |
| `BUYER_MAX_PER_PAYMENT` | `$0.05` | Buyer spend cap |
| `A2A_PORT` / `MERCHANT_URL` | `4000` / `http://localhost:4000` | Merchant agent address |

- Prices are given as money (`"$0.01"`) and resolved through the SDK's default assets for the selected network and token. No hardcoded addresses or EIP-712 domains.
- The README's troubleshooting row "Celo is not in the default-asset table" is outdated for 2.25+ and gets updated.

## Error handling

The transport spec only gives example error codes. These come from the established a2a-x402 set (spec §8.1): `INSUFFICIENT_FUNDS`, `INVALID_SIGNATURE`, `EXPIRED_PAYMENT`, `DUPLICATE_NONCE`, `NETWORK_MISMATCH`, `INVALID_AMOUNT`, `SETTLEMENT_FAILED`. Clients built for a2a-x402 will therefore understand them.

| Situation | Merchant response | Buyer output |
|---|---|---|
| `payload.accepted` matches no stored requirement | `payment-failed`, failure receipt, and `NETWORK_MISMATCH` if the network differs, else `INVALID_AMOUNT` | "payment didn't match the merchant's terms" |
| Verify returns invalid | `payment-failed`, with the facilitator's `invalidReason` mapped to `INVALID_SIGNATURE`, `EXPIRED_PAYMENT`, `INSUFFICIENT_FUNDS` or `DUPLICATE_NONCE` (anything else becomes `INVALID_SIGNATURE`) and the raw reason kept in the receipt's `errorReason` | the reason, plus the matching README tip |
| Facilitator 401 / 402 / 429 / network error | `payment-failed`, `SETTLEMENT_FAILED`; the cause is logged server-side and the API key is never echoed | "settlement failed", with a pointer to the troubleshooting table |
| Unknown or expired `taskId` on submit | A2A task-not-found error | the error |
| Amount above the buyer cap or unsupported asset | none (the buyer declines and sends `payment-rejected`) | "declined: above spend cap" |

## Testing

- **Unit tests** (vitest, no network). The facilitator is faked behind `x402ResourceServer` and the A2A wire is an in-memory event bus.
  - encoding round-trip, including `x402Version: 2`, camelCase keys and no nulls
  - executor happy path: required → submitted → verified → settled → inner ran → completed with a receipt
  - mismatched `accepted` → failed, and the inner executor did not run
  - verify failure → failed, and settle was not called
  - settle failure → failed with a receipt where `transaction: ""`, and the inner executor did not run
  - rejection → failed, with no verify or settle
  - client pays once, resends on the same `taskId`, and returns the receipts
  - client declines above the cap
- **Live check** (`npm run a2a:demo`): starts the merchant, runs the buyer against Celo Sepolia, and exits non-zero unless a transaction hash comes back. This is the definition of done for phase 1.
- `npm run typecheck` passes.

## Phase 2: upstream to x402

1. Open an issue on `x402-foundation/x402` proposing `@x402/a2a`. Link the transport spec and the working Celo example. Ask about the package name and the A2A v0.3/v1.0 note.
2. PR contents:
   - Move `src/a2a/x402/*` to `typescript/packages/a2a/src/{server,client,utils,types}`, matching `@x402/mcp`, with `@a2a-js/sdk` as a peer dependency.
   - Unit tests ported to the package.
   - `examples/typescript/servers/a2a` and `examples/typescript/clients/a2a`, using Base Sepolia by default with a documented Celo option.
   - A docs page next to the MCP transport docs, and a transport-spec note on A2A v0.3 vs v1.0.
   - A changeset for the new package.
3. Once `@x402/a2a` is published, this repo switches to it and deletes `src/a2a/x402/`.

## Out of scope

- LLM-driven agents (both example agents are scripted)
- Streaming (`message/stream`), push notifications and persistent task stores (in-memory only)
- Python implementation (possible follow-up, mirroring `python/x402/mcp`)
- Permit2 assets (wARS/wBRL/wCOP): the SDK supports them, but the example sticks to EIP-3009 tokens to stay simple
- Changes to Google's `a2a-x402` repo
