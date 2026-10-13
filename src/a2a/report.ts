/**
 * The merchant's paid service: a snapshot of the Celo network (latest block,
 * base fee, timestamp), read from the network RPC. A plain A2A AgentExecutor
 * with no payment logic; merchant.ts wraps it with createPaymentExecutor.
 */
import { TaskState, type Task } from '@a2a-js/sdk'
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server'
import { createPublicClient, formatGwei, http } from 'viem'
import { CFG } from '../config.js'

const rpc = createPublicClient({ transport: http(CFG.rpc) })

export class CeloReportExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const task: Task = ctx.task ?? {
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [ctx.userMessage],
      metadata: undefined,
    }
    bus.publish(AgentEvent.task(task))

    const block = await rpc.getBlock()
    const report = {
      network: CFG.label,
      chainId: CFG.caip2,
      blockNumber: block.number.toString(),
      baseFeeGwei: block.baseFeePerGas === null ? null : formatGwei(block.baseFeePerGas),
      timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    }

    bus.publish(
      AgentEvent.artifactUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: {
          artifactId: crypto.randomUUID(),
          name: 'celo-network-report',
          description: `Latest ${CFG.label} block`,
          parts: [
            { content: { $case: 'text', value: JSON.stringify(report, null, 2) }, metadata: undefined, filename: '', mediaType: 'application/json' },
          ],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    )
    bus.publish(
      AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined,
      }),
    )
  }

  async cancelTask(): Promise<void> {
    // The report is a single RPC read; nothing to cancel.
  }
}
