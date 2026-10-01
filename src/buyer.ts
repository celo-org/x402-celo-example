/**
 * Buyer: pay for the seller's endpoint automatically.
 *
 * Start the seller first (npm run seller), then run: npm run buyer
 *
 * The buyer wallet needs a little USDC on the chosen network and no CELO: the
 * facilitator submits the transaction and pays the gas. The buyer does not need
 * a facilitator API key.
 */
import { x402Client, wrapFetchWithPayment } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'
import { SELLER_URL, CFG } from './config.js'

const rawKey = process.env.BUYER_PRIVATE_KEY
if (!rawKey) {
  console.error('Missing BUYER_PRIVATE_KEY. Use a throwaway wallet funded with a little USDC.')
  process.exit(1)
}

const account = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`)

const client = new x402Client()
client.register('eip155:*', new ExactEvmScheme(account))
const payFetch = wrapFetchWithPayment(fetch, client)

console.log(`Paying ${SELLER_URL} as ${account.address} on ${CFG.label}`)
const res = await payFetch(SELLER_URL)
console.log('status:', res.status)
console.log('body:', await res.json())

// The settlement transaction hash is in the payment-response header.
const header = res.headers.get('payment-response')
if (header) {
  const settled = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  const tx = settled?.transaction
  if (tx) console.log('settlement tx:', CFG.explorerTx + tx)
}
