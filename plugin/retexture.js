import { batchLedger } from './batch.js'
import { approvePaidQuote, dispatchPaidQuote, preparePaidQuote } from './paid.js'
import { recordSubmittedTask } from './resume.js'
import { createTripoQuery } from './task.js'
import { findTextureSource, readTextureVersions, recordTextureVersion, recoverTextureSubmission } from './versions.js'
import { isTaskId, textureEndpoints, textureRemotePackage, workspaceApprovalId } from './workspace.js'

const maxQuotes = 64
const preparationTimeout = 120_000
const failure = (status, error) => ({ status, error })

async function sessionExecution(ctx, sessionId, signal) {
  signal.throwIfAborted()
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  signal.throwIfAborted()
  if (!agent || agent.session.id !== sessionId || agent.session.header.origin === 'subagent') {
    throw new Error('Open the original main DSH conversation to work on this model.')
  }
  return { agent, signal }
}

export function registerRetextureRemote(ctx) {
  const active = new Map()
  const quotes = new Map()
  let sequence = 0

  const handler = {
    async quote(sessionId, input, signal) {
      const order = ++sequence
      const exec = await sessionExecution(ctx, sessionId, signal)
      const query = createTripoQuery(ctx, exec)
      const { operation = 'texture', prompt, bodyType, preset, ...selection } = input
      if (!['texture', 'rig', 'retarget'].includes(operation)) throw new Error('Choose a Tripo model operation.')
      if (operation === 'texture' && (typeof prompt !== 'string' || !prompt.trim())) throw new Error('Enter a description for the new texture.')
      const exact = operation !== 'texture'
      const source = await findTextureSource(query, selection, { exact })
      if (!source || source.status !== 'success'
        || (exact && source.taskId.toLowerCase() !== selection.sourceTaskId.toLowerCase())) {
        throw new Error('This conversation does not have the selected successful Tripo model.')
      }

      for (const [key, entry] of active) {
        if (entry.expiresAt > Date.now()) continue
        entry.controller.abort()
        active.delete(key)
        quotes.delete(entry.pending?.quote.quoteId)
      }
      const key = JSON.stringify([sessionId, query.root, source.taskId, source.region, source.profile, operation])
      const previous = active.get(key)
      if (previous?.order > order) throw new Error('A newer estimate superseded this Tripo request.')
      if (!previous && active.size >= maxQuotes) throw new Error('Too many active Tripo model quotes. Wait for a quote to expire.')
      previous?.controller.abort()
      quotes.delete(previous?.pending?.quote.quoteId)
      const entry = { order, key, controller: new AbortController(), expiresAt: Date.now() + preparationTimeout }
      active.set(key, entry)

      const preparing = { agent: exec.agent, signal: AbortSignal.any([signal, entry.controller.signal, AbortSignal.timeout(preparationTimeout)]) }
      const pending = await preparePaidQuote(ctx, {
        operation, taskId: source.taskId, region: source.region, profile: source.profile, prompt, bodyType, preset,
      }, preparing, source)
      preparing.signal.throwIfAborted()
      entry.pending = pending
      entry.expiresAt = pending.quote.expiresAt
      entry.sourceSeq = source.seq
      entry.root = query.root
      quotes.set(pending.quote.quoteId, entry)
      const { taskId: sourceTaskId, operation: quotedOperation, ...quote } = pending.quote
      return { ...quote, ...(quotedOperation !== 'texture' ? { operation: quotedOperation } : {}), sourceTaskId }
    },

    async submit(sessionId, quoteId, signal) {
      if (!isTaskId(quoteId)) throw new Error('Use the quote ID shown for this Tripo operation.')
      const exec = await sessionExecution(ctx, sessionId, signal)
      const query = createTripoQuery(ctx, exec)
      const ledger = batchLedger(query, quoteId, 'tripo-retexture-submissions-v1')
      let receipt
      let attempted = false
      try {
        const stored = await ledger.read()
        if (stored) {
          return stored.status === 'unknown' ? await recoverTextureSubmission(query, quoteId).catch(() => undefined) ?? stored : stored
        }
        const entry = quotes.get(quoteId)
        const pending = entry?.pending
        if (!pending || pending.sessionId !== sessionId || entry.root !== query.root || entry.expiresAt <= Date.now()
          || active.get(entry.key) !== entry) {
          return failure('expired', 'This Tripo quote is unavailable. Estimate the current request again.')
        }
        const used = failure('alreadyUsed', 'This quote has already been handled. Check its result before doing anything else.')
        if (pending.used) return used
        pending.used = true
        if (!await ledger.reserve()) return await ledger.read() ?? used
        await ledger.write(used)

        const approving = { agent: exec.agent, signal: AbortSignal.any([
          signal, entry.controller.signal, AbortSignal.timeout(Math.max(1, entry.expiresAt - Date.now())),
        ]) }
        const approved = await approvePaidQuote(ctx, pending, approving, workspaceApprovalId(quoteId))
        const { taskId: sourceTaskId, region, profile, operation, bodyType, preset, model } = pending.quote
        const source = { sourceTaskId, region, ...(profile ? { profile } : {}),
          ...(operation === 'rig' ? { operation, bodyType } : {}), ...(operation === 'retarget' ? { operation, preset } : {}) }
        if (entry.expiresAt <= Date.now()) {
          receipt = { ...source, ...failure('expired', 'This Tripo quote has expired.') }
        } else if (entry.controller.signal.aborted) {
          receipt = { ...source, ...failure('cancelled', 'This Tripo request was replaced before submission.') }
        } else if (approved.status !== 'approved') {
          receipt = { ...source, ...approved }
        } else {
          // Record uncertainty before the first paid invocation so reopening cannot send it again.
          const unknown = { ...source, ...failure('unknown', 'Check Tripo usage and task history before submitting again.') }
          await ledger.write(unknown)
          if (entry.expiresAt <= Date.now()) {
            receipt = { ...source, ...failure('expired', 'This Tripo quote has expired.') }
          } else if (approving.signal.aborted) {
            receipt = { ...source, ...failure('cancelled', 'This Tripo request was cancelled before submission.') }
          } else {
            attempted = true
            // Replacing an estimate cannot cancel a request already dispatched to Tripo.
            approved.query.signal = signal
            const result = await dispatchPaidQuote(ctx, pending, approved)
            receipt = { ...source, ...result }
            if (result.status === 'queued') {
              try {
                await recordTextureVersion(approved.query, { ...source, taskId: result.taskId, sourceSeq: entry.sourceSeq, quoteId,
                  ...(operation === 'rig' ? { rigModel: model } : {}) }, approved.account)
              } catch {
                receipt.error = 'The task was submitted, but the model version could not be saved in this conversation.'
              }
              await recordSubmittedTask(approved.query, result, approved.account)
            }
          }
        }
        await ledger.write(receipt)
        return receipt
      } catch {
        if (receipt) return receipt
        return attempted ? failure('unknown', 'Check Tripo usage and task history before submitting again.')
          : failure('unavailable', 'Could not access this Tripo quote. No new task was submitted.')
      }
    },

    async versions(sessionId, input, signal) {
      return await readTextureVersions(ctx, await sessionExecution(ctx, sessionId, signal), input)
    },

    async refresh(sessionId, input, signal) {
      return await readTextureVersions(ctx, await sessionExecution(ctx, sessionId, signal), input, { refresh: true })
    },
  }
  const [{ service, namespace }] = textureEndpoints
  handler.typertRemote = { service: handler, serviceKey: service, namespace }
  ctx.provide(service, handler)
  ctx.typert.register({ package: textureRemotePackage, face: 'host', schemas: [], invocations: textureEndpoints })
  ctx.effect(() => () => {
    for (const entry of active.values()) entry.controller.abort()
  })
}
