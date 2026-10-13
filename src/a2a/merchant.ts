/**
 * Merchant agent: sells a Celo network report over A2A for $0.01, paid with x402.
 *
 * Run:  npm run a2a:merchant
 * Card: http://localhost:4000/.well-known/agent-card.json
 */
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk'
import { x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { createPublicClient, getAddress, http } from 'viem'
import { A2A_PORT, a2aPricing, CFG, MERCHANT_URL } from '../config.js'
import { facilitator } from '../facilitator.js'
import { createA2AApp } from './app.js'
import { eip3009SettlementFinder } from './eip3009.js'
import { CeloReportExecutor } from './report.js'
import { createPaymentExecutor, X402_EXTENSION_URI } from './x402/index.js'

if (!process.env.X402_API_KEY) {
  console.error('Missing X402_API_KEY. Create one at https://x402.celo.org and put it in .env')
  process.exit(1)
}
if (!process.env.SELLER_PAY_TO) {
  console.error('Missing SELLER_PAY_TO: the address that receives the payment.')
  process.exit(1)
}
const payTo = getAddress(process.env.SELLER_PAY_TO)
const { token: TOKEN, price: A2A_PRICE } = a2aPricing()

const resourceServer = new x402ResourceServer(facilitator)
resourceServer.register('eip155:*', new ExactEvmScheme())
await resourceServer.initialize() // reads the facilitator's /supported

const card: AgentCard = {
  name: 'Celo network reporter',
  description: `Sells a snapshot of the ${CFG.label} network for ${A2A_PRICE} (${TOKEN}), paid with x402.`,
  supportedInterfaces: [{ url: `${MERCHANT_URL}/`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
  provider: { organization: 'Celo', url: 'https://celo.org' },
  version: '1.0.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [{ uri: X402_EXTENSION_URI, description: 'Payments with x402 (stablecoins on Celo).', required: true, params: {} }],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'celo-network-report',
      name: 'Celo network report',
      description: `Latest block number, base fee and timestamp on ${CFG.label}.`,
      tags: ['celo', 'x402', 'paid'],
      examples: ['network report please'],
      inputModes: ['text'],
      outputModes: ['application/json'],
      securityRequirements: [],
    },
  ],
  documentationUrl: 'https://github.com/celo-org/x402-celo-example',
  signatures: [],
}

const executor = createPaymentExecutor(new CeloReportExecutor(), {
  resourceServer,
  accepts: [{ scheme: 'exact', network: CFG.caip2, payTo, price: A2A_PRICE }],
  resource: () => ({ url: `${MERCHANT_URL}/#celo-network-report`, description: 'Celo network report', mimeType: 'application/json' }),
  // If the facilitator's settle response is lost, check the token on chain before failing the task.
  findSettlement: eip3009SettlementFinder(createPublicClient({ transport: http(CFG.rpc) })),
})
// Serves A2A v1.0 and v0.3 clients on the same endpoint.
const { app } = createA2AApp(card, executor)
app.listen(A2A_PORT, (error) => {
  if (error) {
    console.error(`Cannot listen on port ${A2A_PORT}: ${error.message}`)
    process.exit(1)
  }
  console.log(`Merchant agent on ${MERCHANT_URL} (${CFG.label}, ${A2A_PRICE} in ${TOKEN})`)
  console.log(`Agent card: ${MERCHANT_URL}/${AGENT_CARD_PATH}`)
})
