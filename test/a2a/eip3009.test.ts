import { describe, expect, it, vi } from 'vitest'
import { eip3009SettlementFinder } from '../../src/a2a/eip3009.js'
import { REQUIREMENT, signedPayload } from './harness.js'

const FROM = '0x1111111111111111111111111111111111111111'
const NONCE = `0x${'ab'.repeat(32)}`
const QUOTE_TIME = new Date('2026-10-13T12:00:00Z')
const since = { since: QUOTE_TIME }
const seconds = (d: Date) => BigInt(Math.floor(d.getTime() / 1000))

const payload = () => {
  const p = signedPayload()
  p.payload = { signature: '0xsig', authorization: { from: FROM, to: REQUIREMENT.payTo, value: '10000', validAfter: '0', validBefore: '9', nonce: NONCE } }
  return p
}

function fakeClient(opts: {
  used: boolean
  logs?: Array<{ transactionHash: string; blockNumber: bigint }>
  blockTime?: Date
  logsError?: Error
}) {
  return {
    readContract: vi.fn(async () => opts.used),
    getBlockNumber: vi.fn(async () => 1_000_000n),
    getLogs: vi.fn(async () => {
      if (opts.logsError) throw opts.logsError
      return opts.logs ?? []
    }),
    getBlock: vi.fn(async () => ({ timestamp: seconds(opts.blockTime ?? QUOTE_TIME) })),
  }
}

describe('eip3009SettlementFinder', () => {
  it('returns undefined when the authorization was not used', async () => {
    const client = fakeClient({ used: false })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT, since)).toBeUndefined()
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: REQUIREMENT.asset, functionName: 'authorizationState', args: [FROM, NONCE] }),
    )
    expect(client.getLogs).not.toHaveBeenCalled()
  })

  it('returns the transaction when the authorization was used after the quote', async () => {
    const client = fakeClient({
      used: true,
      logs: [{ transactionHash: '0xabc', blockNumber: 999_990n }],
      blockTime: new Date(QUOTE_TIME.getTime() + 30_000),
    })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT, since)).toEqual({ transaction: '0xabc' })
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: REQUIREMENT.asset, args: { authorizer: FROM, nonce: NONCE }, fromBlock: 1_000_000n - 5_000n }),
    )
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 999_990n })
  })

  it('ignores an authorization used before the quote (a replay)', async () => {
    const client = fakeClient({
      used: true,
      logs: [{ transactionHash: '0xold', blockNumber: 990_000n }],
      blockTime: new Date(QUOTE_TIME.getTime() - 10 * 60_000),
    })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT, since)).toBeUndefined()
  })

  it('tolerates a little clock skew between the merchant and the chain', async () => {
    const client = fakeClient({
      used: true,
      logs: [{ transactionHash: '0xskew', blockNumber: 999_999n }],
      blockTime: new Date(QUOTE_TIME.getTime() - 30_000),
    })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT, since)).toEqual({ transaction: '0xskew' })
  })

  it('fails closed when the event cannot be found or read', async () => {
    expect(await eip3009SettlementFinder(fakeClient({ used: true, logs: [] }))(payload(), REQUIREMENT, since)).toBeUndefined()
    expect(
      await eip3009SettlementFinder(fakeClient({ used: true, logsError: new Error('range too large') }))(payload(), REQUIREMENT, since),
    ).toBeUndefined()
  })

  it('does not guess for payloads without an EIP-3009 authorization (e.g. Permit2)', async () => {
    const client = fakeClient({ used: true })
    const permit2 = signedPayload()
    permit2.payload = { signature: '0xsig', permit2Authorization: {} }
    expect(await eip3009SettlementFinder(client)(permit2, REQUIREMENT, since)).toBeUndefined()
    expect(client.readContract).not.toHaveBeenCalled()
  })
})
