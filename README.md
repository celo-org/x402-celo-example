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

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No default asset configured for network eip155:42220` at request time | A bare `"$0.01"` price. Celo is not in the packages' default-asset table, so name the token and its EIP-712 domain explicitly, as `src/seller.ts` does. |
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
| `src/config.ts` | Network, token and facilitator settings |
| `src/check.ts` | Keyless preflight |
