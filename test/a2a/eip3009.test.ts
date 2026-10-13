import { describe, expect, it, vi } from 'vitest'
import { eip3009SettlementFinder } from '../../src/a2a/eip3009.js'
import { REQUIREMENT, signedPayload } from './harness.js'

const FROM = '0x1111111111111111111111111111111111111111'
const NONCE = `0x${'ab'.repeat(32)}`
const payload = () => {
  const p = signedPayload()
  p.payload = { signature: '0xsig', authorization: { from: FROM, to: REQUIREMENT.payTo, value: '10000', validAfter: '0', validBefore: '9', nonce: NONCE } }
  return p
}

function fakeClient({ used, logs = [], logsError }: { used: boolean; logs?: Array<{ transactionHash: string }>; logsError?: Error }) {
  return {
    readContract: vi.fn(async () => used),
    getBlockNumber: vi.fn(async () => 1_000_000n),
    getLogs: vi.fn(async () => {
      if (logsError) throw logsError
      return logs
    }),
  }
}

describe('eip3009SettlementFinder', () => {
  it('returns undefined when the authorization was not used', async () => {
    const client = fakeClient({ used: false })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT)).toBeUndefined()
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: REQUIREMENT.asset, functionName: 'authorizationState', args: [FROM, NONCE] }),
    )
    expect(client.getLogs).not.toHaveBeenCalled()
  })

  it('returns the transaction of the AuthorizationUsed event when it was used', async () => {
    const client = fakeClient({ used: true, logs: [{ transactionHash: '0xabc' }] })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT)).toEqual({ transaction: '0xabc' })
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: REQUIREMENT.asset, args: { authorizer: FROM, nonce: NONCE }, fromBlock: 1_000_000n - 5_000n }),
    )
  })

  it('reports a landed transfer with an empty hash when the event cannot be read', async () => {
    const client = fakeClient({ used: true, logsError: new Error('range too large') })
    expect(await eip3009SettlementFinder(client)(payload(), REQUIREMENT)).toEqual({ transaction: '' })
  })

  it('does not guess for payloads without an EIP-3009 authorization (e.g. Permit2)', async () => {
    const client = fakeClient({ used: true })
    const permit2 = signedPayload()
    permit2.payload = { signature: '0xsig', permit2Authorization: {} }
    expect(await eip3009SettlementFinder(client)(permit2, REQUIREMENT)).toBeUndefined()
    expect(client.readContract).not.toHaveBeenCalled()
  })
})
