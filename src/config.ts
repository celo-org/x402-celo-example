/**
 * Shared network config. Celo Sepolia by default; set X402_NETWORK=mainnet for Celo mainnet.
 * Addresses are the USDC tokens, 6 decimals. Check them against
 * https://docs.celo.org/build-on-celo/network-overview before changing.
 */
import { getAddress } from 'viem'

export const NETWORKS = {
  testnet: {
    caip2: 'eip155:11142220', // Celo Sepolia
    usdc: getAddress('0x01C5C0122039549AD1493B8220cABEdD739BC44E'), // USDC, 6 decimals
    label: 'Celo Sepolia',
    rpc: 'https://forno.celo-sepolia.celo-testnet.org',
    facilitator: 'https://api.x402.sepolia.celo.org',
    explorerTx: 'https://celo-sepolia.blockscout.com/tx/',
  },
  mainnet: {
    caip2: 'eip155:42220', // Celo mainnet
    usdc: getAddress('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'), // USDC, 6 decimals
    label: 'Celo mainnet',
    rpc: 'https://forno.celo.org',
    facilitator: 'https://api.x402.celo.org',
    explorerTx: 'https://celoscan.io/tx/',
  },
} as const

export const NET = (process.env.X402_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as keyof typeof NETWORKS
export const CFG = NETWORKS[NET]
export const PORT = Number(process.env.PORT ?? 3000)
export const SELLER_URL = process.env.SELLER_URL ?? `http://localhost:${PORT}/premium`
