# x402-celo-example

A runnable example of [x402](https://www.x402.org) stablecoin payments on Celo: a seller that charges $0.01 in USDC for an API endpoint, and a buyer that pays for it automatically. Settlement goes through the hosted Celo facilitator, which submits the transaction and pays the gas, so the buyer needs no CELO.

For app and agent developers. The concepts and the full facilitator reference are in the [x402 docs](https://docs.celo.org/build-on-celo/build-with-ai/x402).

## How it works

```
buyer  GET /premium                 -> seller
seller 402 Payment Required         -> buyer
buyer  signs an EIP-3009 authorization (off-chain, no gas), retries with a payment header
seller /verify, /settle (API key)   -> Celo facilitator -> USDC moves buyer -> seller
seller 200 + content + settlement transaction
```

The facilitator never holds funds: `transferWithAuthorization` moves USDC from payer to payee inside the token contract.

## Run it on Celo Sepolia

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run check          # no keys needed: facilitator reachable, USDC address has code
```

Fill in `.env`:

| Variable | What |
|---|---|
| `X402_API_KEY` | Create one at [x402.celo.org](https://x402.celo.org): connect a wallet and sign, no gas. Server-side secret. |
| `SELLER_PAY_TO` | The address that receives the USDC. |
| `BUYER_PRIVATE_KEY` | A throwaway wallet funded with a little Celo Sepolia USDC from the [Circle faucet](https://faucet.circle.com). No CELO needed. |

Then, in two terminals:

```bash
npm run seller   # paid API on http://localhost:3000
npm run buyer    # pays for it and prints the settlement transaction
```

Inspect the 402 by hand: `curl -i http://localhost:3000/premium` returns `402 Payment Required` with a `payment-required` header.

## Mainnet

Set `X402_NETWORK=mainnet` and use a funded wallet. Test on Celo Sepolia first.

| Network | Chain ID | USDC (6 decimals) | Facilitator |
|---|---|---|---|
| Celo mainnet | 42220 | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | `https://api.x402.celo.org` |
| Celo Sepolia | 11142220 | `0x01C5C0122039549AD1493B8220cABEdD739BC44E` | `https://api.x402.sepolia.celo.org` |

## Agent-to-agent (A2A) payments

The same payment, between two AI agents over the [A2A protocol](https://a2a-protocol.org). A merchant agent sells a Celo network report (latest block, base fee, timestamp) for $0.01. A buyer agent asks for it, pays automatically within a spend cap, and gets the report and the settlement transaction. It follows the x402 v2 [A2A transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/a2a.md), using [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js).

```
buyer     message "network report please"                        -> merchant
merchant  task input-required, x402.payment.status=payment-required
          + x402.payment.required (price, token, payTo)           -> buyer
buyer     signs an EIP-3009 authorization (off-chain, no gas)
          message on the same task, payment-submitted + payload   -> merchant
merchant  /verify, /settle (API key) -> Celo facilitator -> tokens move buyer -> merchant
merchant  runs the work only after settlement
          task completed + report + x402.payment.receipts          -> buyer
```

Run it with the same `.env` as above:

```bash
npm run a2a:demo       # starts the merchant, runs the buyer, prints the report and the tx; exits 1 if nothing settled
# or in two terminals:
npm run a2a:merchant   # agent card at http://localhost:4000/.well-known/agent-card.json
npm run a2a:buyer
```

| Variable | Default | What |
|---|---|---|
| `X402_TOKEN` | `USDC` | Token to charge in. On mainnet also `USDT` (USD₮) or `USAT` (USA₮, the US Dollar-backed stablecoin issued by Anchorage Digital Bank, N.A., and supported by Tether). Addresses and EIP-712 domains come from `@x402/evm`'s built-in Celo assets. |
| `BUYER_MAX_PER_PAYMENT` | `$0.05` | The buyer refuses to sign anything above this. |
| `A2A_PORT` / `MERCHANT_URL` | `4000` / `http://localhost:4000` | Where the merchant agent listens. |

The payment layer in `src/a2a/x402/` works with any A2A agent:

- `createPaymentExecutor(executor, { resourceServer, accepts, resource })` wraps an A2A `AgentExecutor`. The wrapped executor runs only after the payment has settled.
- `x402A2AClient(a2aClient, x402Client)` pays `payment-required` tasks for a buyer.

Failures come back as `payment-failed` with an error code (`INSUFFICIENT_FUNDS`, `EXPIRED_PAYMENT`, `INVALID_SIGNATURE`, `SETTLEMENT_FAILED`, …) and a receipt. A buyer that declines gets `payment-rejected`. If the paid work fails after settlement, the task fails but still carries `payment-completed` and the receipt, as proof of payment. A second payment submitted for the same task is not settled again. The tests run offline: `npm test`.

Limits of this example:
- It speaks A2A v1.0 (`@a2a-js/sdk` 1.x), so A2A v0.3 clients are not accepted.
- Tasks and quotes live in memory.
- If the facilitator's settle response is lost after the transfer went through, the task is reported as failed. Reconcile on chain using the payer and nonce in the merchant log.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No default asset configured for network eip155:42220` at request time | `@x402/*` packages older than 2.25 don't include Celo's tokens. Upgrade, or name the token and its EIP-712 domain explicitly, as `src/seller.ts` does. |
| A2A buyer prints `INSUFFICIENT_FUNDS` | The buyer wallet has too little of the token. Fund it from the [Circle faucet](https://faucet.circle.com) (Celo Sepolia USDC). |
| A2A buyer prints `Payment declined: ... spendControls` | The price is above `BUYER_MAX_PER_PAYMENT`. |
| `/verify` works but `/settle` returns `401 Missing X-API-Key` | The key is only checked on settlement. Set `X402_API_KEY`. |
| `/settle` returns `402` | Out of facilitator credits. Top up on the dashboard. |
| `/settle` returns `429` | Free-tier rate limit reached. |
| Signature verification fails | The `extra` EIP-712 domain does not match the token. USDC is `name: "USDC", version: "2"`. |
| Dashboard URL returns HTML | `x402.celo.org` is the dashboard. Point servers at the `api.` host. |

## Files

| File | What |
|---|---|
| `src/seller.ts` | The paid API (Hono and `@x402/hono`) |
| `src/buyer.ts` | The paying client (`@x402/fetch`) |
| `src/facilitator.ts` | Facilitator client that attaches your API key |
| `src/config.ts` | Network, token and facilitator settings; loads `.env` |
| `src/check.ts` | Keyless preflight |
| `src/a2a/x402/` | x402 payments for A2A agents: metadata encoding, payment-gated executor, paying client |
| `src/a2a/merchant.ts` | Merchant agent selling a Celo network report |
| `src/a2a/buyer.ts` | Buyer agent that pays for it |
| `src/a2a/report.ts` | The paid work: reads the latest Celo block |
| `src/a2a/demo.ts` | Runs merchant and buyer end to end |
| `test/a2a/` | Offline tests of the payment layer |
