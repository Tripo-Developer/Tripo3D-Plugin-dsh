import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectTask, tripoAccountFingerprint } from './task.js'
import {
  batchSubmitToolName, batchToolName, parseTaskReceipt, readBatchReceipts, readTaskReceipt,
  submitToolName, taskRecoveryEndpoint, taskRecoveryKey, taskToolName,
} from './workspace.js'

const maxTasks = 8
const historyLimit = 512
const trackedFileLimit = 64
const isPending = ({ status }) => status === 'queued' || status === 'running'
const isTerminal = ({ status }) => !['queued', 'running', 'unknown'].includes(status)
const isPermanentError = ({ errorCode }) => ['accountMismatch', 'taskNotFound', 'invalidOutput'].includes(errorCode)

function recoveryDirectory(dshEnv, sessionId) {
  const { DSH_HOME: home } = dshEnv
  if (typeof home !== 'string' || !isAbsolute(home)) return undefined
  const owner = createHash('sha256').update(sessionId).digest('hex')
  return join(home, 'tripo-task-recovery-v1', owner)
}

function recoveryReceipt({ taskId, region, profile, status, progress, errorCode, seq }) {
  return { taskId, region, ...(profile ? { profile } : {}), status,
    ...(progress !== undefined ? { progress } : {}), ...(errorCode ? { errorCode } : {}),
    ...(seq !== undefined ? { seq } : {}) }
}

async function saveReceipt(path, receipt, accountFingerprint) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ receipt: recoveryReceipt(receipt), accountFingerprint }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function recordSubmittedTask(query, receipt, account) {
  const accountFingerprint = tripoAccountFingerprint(account?.marker, account?.base)
  if (!accountFingerprint || !parseTaskReceipt(receipt) || !isPending(receipt)) return
  const directory = recoveryDirectory(query.dshEnv, query.session.id)
  if (!directory) return
  const filename = `${Date.now().toString(36)}-${receipt.taskId.toLowerCase()}-${receipt.region}-${receipt.profile ?? 'env'}.json`
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await saveReceipt(join(directory, filename), receipt, accountFingerprint)
  } catch {
    // Keep the confirmed remote task available in the normal DSH tool receipt.
  }
}

async function storedReceipts(directory, signal) {
  if (!directory) return new Map()
  const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const recent = files.filter(file => file.isFile() && /^[a-z0-9]+-[a-f0-9-]{36}-(cn|ov)-[a-z0-9_-]{1,32}\.json$/.test(file.name))
    .map(file => file.name).sort().slice(-trackedFileLimit)
  const entries = new Map()
  for (const file of recent) {
    signal.throwIfAborted()
    const path = join(directory, file)
    try {
      const { receipt, accountFingerprint } = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
      if (!parseTaskReceipt(receipt) || (!isPending(receipt) && !isTerminal(receipt))
        || typeof accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(accountFingerprint)) continue
      entries.set(taskRecoveryKey(receipt), {
        receipt: recoveryReceipt(receipt), accountFingerprint, path, time: Number.parseInt(file.split('-', 1)[0], 36),
      })
    } catch {
      signal.throwIfAborted()
    }
  }
  return entries
}

export async function readTaskRecoveryEntry(query, task) {
  const directory = recoveryDirectory(query.dshEnv, query.session.id)
  const { receipt, accountFingerprint } = (await storedReceipts(directory, query.signal)).get(taskRecoveryKey(task)) ?? {}
  return receipt ? { receipt, accountFingerprint } : undefined
}

function readRecoveryHistory(session, entries) {
  const calls = new Map()
  for (const event of session.snapshotEvents(Math.max(0, session.seq - historyLimit))) {
    // A fork replays its parent's tool cards, which the new session does not own.
    if (!session.isOwnSeq(event.seq)) continue
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, event.data.name)
      continue
    }
    if (event.type !== 'tool/result' || event.data.message.isError) continue
    const { message } = event.data
    const name = calls.get(message.toolCallId)
    const receipts = name === batchToolName || name === batchSubmitToolName ? readBatchReceipts(message.content)
      : name === submitToolName || name === taskToolName ? [readTaskReceipt(message.content)] : []
    for (const result of receipts) {
      if (!result || (!isPending(result) && !isTerminal(result))) continue
      const key = taskRecoveryKey(result)
      const existing = entries.get(key)
      // Even a named profile in an older card can be rebound to a different account.
      if (!existing) continue
      const latest = isTerminal(existing.receipt) && !isTerminal(result) ? existing.receipt : result
      entries.set(key, {
        ...existing, receipt: recoveryReceipt({ ...latest, seq: event.seq }),
      })
    }
  }
  return [...entries.values()].sort((a, b) => b.time - a.time).slice(0, maxTasks)
}

export function registerTaskRecovery(ctx, { intervalMs = 8_000, maxAttempts = 8, maxDurationMs = 120_000 } = {}) {
  const states = new WeakMap()
  const running = new Set()

  function start(agent) {
    const session = agent.session
    if (session.header.origin === 'subagent') return { tasks: [], polling: false }
    let state = states.get(agent)
    if (!state) {
      state = { tasks: new Map(), tried: new Set(), cursor: -1 }
      states.set(agent, state)
    }
    if (!state.controller && state.cursor !== session.seq) {
      state.cursor = session.seq
      const controller = new AbortController()
      state.controller = controller
      running.add(controller)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(maxDurationMs)])
      void recover(agent, state, signal).catch(() => {}).finally(() => {
        state.controller = undefined
        running.delete(controller)
      })
    }
    return { tasks: [...state.tasks.values()], polling: Boolean(state.controller) }
  }

  async function recover(agent, state, signal) {
    const session = agent.session
    const exec = { agent, signal }
    const directory = recoveryDirectory(ctx.shellEnv.collect(exec), session.id)
    const recent = readRecoveryHistory(session, await storedReceipts(directory, signal))
    const candidates = recent.map(entry => ({ ...entry, key: taskRecoveryKey(entry.receipt) }))
    const previous = state.tasks
    state.tasks = new Map(candidates.map(({ key, receipt }) => {
      const observed = previous.get(key)
      return [key, observed && (observed.seq ?? -1) >= (receipt.seq ?? -1) && !isTerminal(receipt) ? observed : receipt]
    }))
    let pending = candidates.filter(({ key, receipt }) => isPending(receipt) && !state.tried.has(key))
    for (let attempt = 0; attempt < maxAttempts && pending.length; attempt++) {
      if (attempt > 0) await delay(intervalMs, undefined, { signal, ref: false })
      const next = []
      for (const entry of pending) {
        signal.throwIfAborted()
        const { key, path, receipt, accountFingerprint } = entry
        const outcome = await inspectTask(ctx, receipt, exec, accountFingerprint)
        const latest = recoveryReceipt({ ...outcome, seq: receipt.seq })
        state.tasks.set(key, latest)
        if (isTerminal(latest)) {
          if (path) await saveReceipt(path, latest, accountFingerprint).catch(() => {})
        } else if (!isPermanentError(latest) && attempt + 1 < maxAttempts) {
          next.push(entry)
          continue
        }
        state.tried.add(key)
      }
      pending = next
    }
  }

  ctx.on('agent/created', ({ agent, source }) => {
    if (source === 'resume') start(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => states.get(agent)?.controller?.abort())
  ctx.effect(() => () => {
    for (const controller of running) controller.abort()
  })
  return { start }
}

export function registerTaskRecoveryRemote(ctx, recovery) {
  const { service, namespace } = taskRecoveryEndpoint
  const handler = {
    async resume(sessionId, signal) {
      signal.throwIfAborted()
      const directory = recoveryDirectory(ctx.shellEnv.collect({ signal }), sessionId)
      if (!directory || !(await stat(directory).catch(() => undefined))?.isDirectory()) return { tasks: [], polling: false }
      signal.throwIfAborted()
      const { agent } = await ctx.sessionController.resolveAgent(sessionId)
      signal.throwIfAborted()
      return agent ? recovery.start(agent) : { tasks: [], polling: false }
    },
  }
  handler.typertRemote = { service: handler, serviceKey: service, namespace }
  ctx.provide(service, handler)
  ctx.typert.register({ package: '@vastai/tripo-dsh', face: 'host', schemas: [], invocations: [taskRecoveryEndpoint] })
}
