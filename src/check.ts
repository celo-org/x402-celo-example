/**
 * Preflight: confirm the facilitator is reachable and supports Celo, and that
 * the configured USDC address has contract code on the chosen network.
 * Needs no keys. Run: npm run check
 */
import { createPublicClient, http } from 'viem'
import { CFG } from './config.js'

const supportedRes = await fetch(`${CFG.facilitator}/supported`)
const supported = (await supportedRes.json()) as { kinds?: { scheme: string; network: string }[] }
const match = supported.kinds?.find((k) => k.scheme === 'exact' && k.network === CFG.caip2)
console.log(`facilitator ${CFG.facilitator}/supported:`, supportedRes.status, match ? `exact on ${CFG.caip2}` : 'NOT SUPPORTED')

const client = createPublicClient({ transport: http(CFG.rpc) })
const code = await client.getCode({ address: CFG.usdc })
console.log(`USDC ${CFG.usdc} on ${CFG.label}:`, code && code !== '0x' ? 'has code' : 'NO CODE')

if (!match || !code || code === '0x') process.exit(1)
