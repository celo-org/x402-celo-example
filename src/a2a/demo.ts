/**
 * End-to-end check: start the merchant agent, wait for its agent card, run the
 * buyer, stop the merchant. Exits with the buyer's code, which is non-zero
 * unless the payment settled on chain.
 *
 * Run: npm run a2a:demo
 */
import { spawn } from 'node:child_process'
import { AGENT_CARD_PATH } from '@a2a-js/sdk'
import { MERCHANT_URL } from '../config.js'

const tsx = (file: string) => spawn(process.execPath, ['--import', 'tsx', file], { stdio: 'inherit', env: process.env })

const merchant = tsx('src/a2a/merchant.ts')
const stop = () => merchant.kill('SIGTERM')
merchant.on('exit', (code) => {
  if (code) {
    console.error(`merchant exited with code ${code}`)
    process.exit(code)
  }
})

const deadline = Date.now() + 30_000
while (true) {
  const ready = await fetch(`${MERCHANT_URL}/${AGENT_CARD_PATH}`).then((r) => r.ok, () => false)
  if (ready) break
  if (Date.now() > deadline) {
    stop()
    console.error('merchant did not start within 30s')
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 500))
}

const buyer = tsx('src/a2a/buyer.ts')
buyer.on('exit', (code) => {
  stop()
  process.exit(code ?? 1)
})
