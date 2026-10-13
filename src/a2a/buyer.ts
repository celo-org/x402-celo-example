/**
 * Buyer agent: asks the merchant agent for a Celo network report and pays for it.
 *
 * Start the merchant first (npm run a2a:merchant), then run: npm run a2a:buyer
 *
 * The buyer wallet needs a little of the chosen token and no CELO: the
 * facilitator submits the transaction and pays the gas. Exits non-zero unless
 * the payment settled.
 */
import { ClientFactory } from '@a2a-js/sdk/client'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'
import { CFG, MERCHANT_URL } from '../config.js'
import { getPaymentError, getPaymentStatus, PaymentDeclinedError, x402A2AClient } from './x402/index.js'

const rawKey = process.env.BUYER_PRIVATE_KEY
if (!rawKey) {
  console.error('Missing BUYER_PRIVATE_KEY. Use a throwaway wallet funded with a little USDC.')
  process.exit(1)
}
const account = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`)

// Spend controls: the client refuses to sign anything above this per payment.
const maxPerPayment = process.env.BUYER_MAX_PER_PAYMENT ?? '$0.05'
const signer = new x402Client()
signer.register('eip155:*', new ExactEvmScheme(account))
signer.setSpendControls({ maxAmountPerPayment: maxPerPayment })

const a2a = await new ClientFactory().createFromUrl(MERCHANT_URL)
const buyer = x402A2AClient(a2a, signer, {
  onPaymentRequired: (pr) => {
    const offer = pr.accepts[0]
    console.log(`Merchant asks ${offer.amount} atomic units of ${offer.asset} on ${offer.network} (cap ${maxPerPayment})`)
    return true
  },
})

console.log(`Buying a network report from ${MERCHANT_URL} as ${account.address} on ${CFG.label}`)
try {
  const { result, receipts } = await buyer.sendMessage('network report please')
  const task = 'status' in result ? result : undefined
  const statusMeta = task?.status?.message?.metadata
  console.log('payment status:', getPaymentStatus(statusMeta) ?? 'none')

  for (const artifact of task?.artifacts ?? []) {
    for (const part of artifact.parts) if (part.content?.$case === 'text') console.log(part.content.value)
  }

  const tx = receipts.find((r) => r.success)?.transaction
  if (!tx) {
    console.error('Payment did not settle:', getPaymentError(statusMeta) ?? 'no receipt', receipts[0]?.errorReason ?? '')
    process.exit(1)
  }
  console.log('settlement tx:', CFG.explorerTx + tx)
} catch (error) {
  if (error instanceof PaymentDeclinedError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
