/**
 * findSettlement for EIP-3009 payments (USDC, USD₮, USA₮ on Celo). Used by the
 * merchant when the facilitator's settle response was lost or reported a failure.
 *
 * It only reports a transfer as landed when it can prove it happened for this
 * quote: the token says the authorization is used, and its AuthorizationUsed
 * event is in a block no older than the quote. An authorization used earlier is
 * a replay, not this payment. Anything it cannot prove fails closed.
 */
import { parseAbi, parseAbiItem, type Address, type Hex } from 'viem'
import type { PaymentExecutorOptions } from './x402/index.js'

const AUTHORIZATION_STATE = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'])
const AUTHORIZATION_USED = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)')

/**
 * How far back to look for the event. Celo makes a block about every second
 * and quotes live at most an hour. Keep this well under ~10,000: public Forno
 * nodes refuse block headers older than that, and the timestamp check needs one.
 */
const LOOKBACK_BLOCKS = 5_000n
/** Allowed difference between the merchant's clock and block timestamps. */
const CLOCK_SKEW_MS = 60_000

/** The viem PublicClient methods used. */
export interface ChainReader {
  readContract(args: { address: Address; abi: typeof AUTHORIZATION_STATE; functionName: 'authorizationState'; args: readonly [Address, Hex] }): Promise<boolean>
  getBlockNumber(): Promise<bigint>
  getLogs(args: {
    address: Address
    event: typeof AUTHORIZATION_USED
    args: { authorizer: Address; nonce: Hex }
    fromBlock: bigint
  }): Promise<Array<{ transactionHash: string | null; blockNumber: bigint | null }>>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export function eip3009SettlementFinder(client: ChainReader): NonNullable<PaymentExecutorOptions['findSettlement']> {
  return async (payload, requirement, { since }) => {
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
      const log = logs.at(-1)
      if (!log?.transactionHash || log.blockNumber === null) return undefined // used, but not provably for this quote
      const block = await client.getBlock({ blockNumber: log.blockNumber })
      if (Number(block.timestamp) * 1000 < since.getTime() - CLOCK_SKEW_MS) return undefined // used before the quote: a replay
      return { transaction: log.transactionHash }
    } catch {
      return undefined
    }
  }
}
