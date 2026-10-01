/**
 * Facilitator client for the seller. Only /settle needs the API key, so the
 * key is attached to every call here and read from the environment.
 * Create a key at https://x402.celo.org (connect wallet, sign, no gas).
 */
import { HTTPFacilitatorClient } from '@x402/core/server'
import { CFG } from './config.js'

export const facilitator = new HTTPFacilitatorClient({
  url: CFG.facilitator,
  createAuthHeaders: async () => {
    const headers: Record<string, string> = { 'X-API-Key': process.env.X402_API_KEY ?? '' }
    return { verify: headers, settle: headers, supported: headers }
  },
})
