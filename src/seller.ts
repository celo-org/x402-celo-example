/**
 * Seller: charge $0.01 in USDC for an API endpoint on Celo.
 *
 * Run:  npm run seller
 * Then: curl -i http://localhost:3000/premium   (returns 402 until paid)
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { getAddress } from 'viem'
import { facilitator } from './facilitator.js'
import { CFG, PORT } from './config.js'

if (!process.env.X402_API_KEY) {
  console.error('Missing X402_API_KEY. Create one at https://x402.celo.org and put it in .env')
  process.exit(1)
}
if (!process.env.SELLER_PAY_TO) {
  console.error('Missing SELLER_PAY_TO: the address that receives the USDC.')
  process.exit(1)
}

const server = new x402ResourceServer(facilitator)
server.register('eip155:*', new ExactEvmScheme())

// Celo is not in the packages' default-asset table, so a bare "$0.01" price
// throws "No default asset configured" at request time. Name the token and its
// EIP-712 domain explicitly instead.
const routes = {
  'GET /premium': {
    accepts: [
      {
        scheme: 'exact',
        network: CFG.caip2,
        payTo: getAddress(process.env.SELLER_PAY_TO),
        price: {
          amount: '10000', // $0.01: USDC has 6 decimals, and the amount is always a string
          asset: CFG.usdc,
          extra: { name: 'USDC', version: '2' }, // EIP-712 domain, must match the token
        },
      },
    ],
    description: 'Premium content',
  },
}

const app = new Hono()
app.use(paymentMiddleware(routes as any, server)) // routes first, then server
app.get('/premium', (c) => c.json({ data: 'this response cost $0.01' }))

serve({ fetch: app.fetch, port: PORT })
console.log(`Seller listening on http://localhost:${PORT} (${CFG.label})`)
