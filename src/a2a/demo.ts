/**
 * End-to-end check: start the merchant agent, wait for its agent card, run the
 * buyer, stop the merchant. Exits with the buyer's code, which is non-zero
 * unless the payment settled on chain.
 *
 * Run: npm run a2a:demo
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { AGENT_CARD_PATH } from '@a2a-js/sdk'
import { MERCHANT_URL } from '../config.js'

const cardUrl = `${MERCHANT_URL}/${AGENT_CARD_PATH}`
const isUp = () => fetch(cardUrl).then((r) => r.ok, () => false)

// Never pay a merchant this script did not start (e.g. a stale one on the same port).
if (await isUp()) {
  console.error(`Something is already serving ${cardUrl}. Stop it or set A2A_PORT.`)
  process.exit(1)
}

const children = new Set<ChildProcess>()
const tsx = (file: string) => {
  const child = spawn(process.execPath, ['--import', 'tsx', file], { stdio: 'inherit', env: process.env })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}
const shutdown = (code: number) => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => shutdown(1))

let buyerStarted = false
const merchant = tsx('src/a2a/merchant.ts')
merchant.on('exit', (code, signal) => {
  if (!buyerStarted || code || signal) {
    console.error(`merchant stopped (${signal ?? `code ${code}`})`)
    shutdown(1)
  }
})

const deadline = Date.now() + 30_000
while (!(await isUp())) {
  if (Date.now() > deadline) {
    console.error('merchant did not start within 30s')
    shutdown(1)
  }
  await new Promise((r) => setTimeout(r, 500))
}

buyerStarted = true
const buyer = tsx('src/a2a/buyer.ts')
buyer.on('exit', (code) => shutdown(code ?? 1))
