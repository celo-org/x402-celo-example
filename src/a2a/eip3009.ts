/**
 * findSettlement for EIP-3009 payments (USDC, USD₮, USA₮ on Celo): asks the
 * token whether the payment's authorization was used, and if so, finds the
 * transaction through the AuthorizationUsed event. Used by the merchant when
 * the facilitator's settle response was lost or reported a failure.
 */
import { parseAbi, parseAbiItem, type Address, type Hex } from 'viem'
import type { PaymentExecutorOptions } from './x402/index.js'

const AUTHORIZATION_STATE = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'])
const AUTHORIZATION_USED = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)')

/** How far back to look for the event. Celo makes a block about every second; quotes live at most an hour. */
const LOOKBACK_BLOCKS = 5_000n

/** The viem PublicClient methods used. */
export interface ChainReader {
  readContract(args: { address: Address; abi: typeof AUTHORIZATION_STATE; functionName: 'authorizationState'; args: readonly [Address, Hex] }): Promise<boolean>
  getBlockNumber(): Promise<bigint>
  getLogs(args: { address: Address; event: typeof AUTHORIZATION_USED; args: { authorizer: Address; nonce: Hex }; fromBlock: bigint }): Promise<Array<{ transactionHash: string | null }>>
}

export function eip3009SettlementFinder(client: ChainReader): NonNullable<PaymentExecutorOptions['findSettlement']> {
  return async (payload, requirement) => {
    const authorization = (payload.payload as { authorization?: { from?: string; nonce?: string } }).authorization
    if (!authorization?.from || !authorization.nonce) return undefined // not EIP-3009: can't tell, so don't claim it landed

    const authorizer = authorization.from as Address
    const nonce = authorization.nonce as Hex
    const asset = requirement.asset as Address
    const used = await client.readContract({ address: asset, abi: AUTHORIZATION_STATE, functionName: 'authorizationState', args: [authorizer, nonce] })
    if (!used) return undefined

    try {
      const latest = await client.getBlockNumber()
      const logs = await client.getLogs({
        address: asset,
        event: AUTHORIZATION_USED,
        args: { authorizer, nonce },
        fromBlock: latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n,
      })
      return { transaction: logs.at(-1)?.transactionHash ?? '' }
    } catch {
      return { transaction: '' } // it landed; only the hash is unknown
    }
  }
}
