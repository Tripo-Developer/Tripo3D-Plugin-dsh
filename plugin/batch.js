import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { inspectTask } from './task.js'
import { isTaskId, isTaskProfile, taskRegions } from './workspace.js'

export const batchToolName = 'tripo_batch'
export const maxTasks = 8

export function batchLedger(query, batchId, directoryName = 'tripo-batches-v1') {
  const { DSH_HOME: home } = query.dshEnv
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('DSH did not provide its data directory.')
  const sessionKey = createHash('sha256').update(JSON.stringify([query.session.id, query.root])).digest('hex')
  const directory = join(home, directoryName, sessionKey, batchId)
  const path = join(directory, 'receipt.json')

  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    },
    async reserve() {
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
      try {
        await mkdir(directory, { mode: 0o700 })
        return true
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        return false
      }
    },
    async write(receipt) {
      const staging = join(directory, `receipt-${randomUUID()}.json`)
      try {
        await writeFile(staging, JSON.stringify(receipt), { flag: 'wx', mode: 0o600, flush: true })
        await rename(staging, path)
      } finally {
        await unlink(staging).catch(() => {})
      }
    },
  }
}

export function registerBatchTool(ctx) {
  ctx.tools.register({
    name: batchToolName,
    description: `Read up to ${maxTasks} existing Tripo tasks and optionally download completed GLBs. Pass explicit task UUIDs with the same original region and CLI profile. Never generates or processes a model.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['taskIds', 'region'],
      properties: {
        taskIds: { type: 'array', items: { type: 'string' } },
        region: { type: 'string', enum: taskRegions },
        profile: { type: 'string' },
        download: { type: 'boolean' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['tasks'],
        properties: { tasks: { type: 'array', items: { type: 'object' } } },
      },
      render: (_args, receipt) => [{ type: 'text', text: JSON.stringify(receipt) }],
    },
    async execute(args, exec) {
      const { taskIds, region, profile, download } = args
      if (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > maxTasks || ![...taskIds].every(isTaskId)
        || !taskRegions.includes(region) || (profile !== undefined && !isTaskProfile(profile))
        || (download !== undefined && typeof download !== 'boolean')) {
        throw new Error(`Use 1 to ${maxTasks} explicit Tripo task UUIDs, their original region, and the original CLI profile if applicable.`)
      }
      const tasks = []
      // Use the same local account and workspace checks as a single task. A failed lookup should not hide later results.
      for (const taskId of new Set(taskIds.map(id => id.toLowerCase()))) {
        exec.signal.throwIfAborted()
        tasks.push(await inspectTask(ctx, { taskId, region, profile, download }, exec))
      }
      return { tasks }
    },
  })
}
