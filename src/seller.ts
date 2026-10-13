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

// The token and its EIP-712 domain are named explicitly here. With @x402/* >= 2.25
// a bare "$0.01" also works on Celo (the A2A example uses that); older packages
// throw "No default asset configured" for it.
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
