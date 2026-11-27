import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { batchLedger, maxTasks } from './batch.js'
import { recordSubmittedTask } from './resume.js'
import { createTripoQuery, resolveTripoProfile, runTripo, tripoAccountFingerprint } from './task.js'
import {
  batchSubmitToolName, estimateToolName, isRetargetPreset, isRetargetRigModel, isTaskId, isTaskProfile,
  retargetPresets, rigBodyTypes, rigModelForBody, submitToolName, taskRegions,
} from './workspace.js'

const quoteLifetime = 10 * 60_000
const operations = ['generate', 'rig', 'texture']
const generationModels = ['tripo-v3.1', 'tripo-p2']
const endpoints = {
  generate: '/v3/generation/text-to-model',
  rig: '/v3/animations/rig',
  texture: '/v3/models/texture',
  retarget: '/v3/animations/retarget',
}
// The public Tripo API list prices in both regions, for these exact processing options.
const processingCredits = { rig: 25, texture: 10, retarget: 10 }
const cliFlags = ['--yes', '--quiet', '--no-open']
const approve = 'Submit Tripo task'
const approveBatch = 'Submit Tripo batch'
const cancel = 'Cancel'
const { approval } = JSON.parse(readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'))

function plannedOperation(input) {
  const { operation, region, profile, taskId, bodyType, preset } = input
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : undefined
  if ((!operations.includes(operation) && operation !== 'retarget') || !taskRegions.includes(region)
    || (profile !== undefined && !isTaskProfile(profile))
    || (operation !== 'retarget' && preset !== undefined)
    || (input.prompt !== undefined && (!prompt || prompt.length > 1000 || prompt.includes('\0')))) {
    throw new Error('Choose a Tripo operation and region, and use a prompt of at most 1000 characters.')
  }
  if (operation === 'generate') {
    const model = input.model ?? 'tripo-p2'
    if (!prompt || taskId !== undefined || bodyType !== undefined || !generationModels.includes(model)
      || (input.texture !== undefined && typeof input.texture !== 'boolean')) {
      throw new Error('Text generation needs a prompt, tripo-v3.1 or tripo-p2, and an optional texture choice.')
    }
    const texture = input.texture ?? true
    const args = ['make', '--model', model, '-p', `texture=${texture}`, '-p', 'pbr=false', '--no-wait', ...cliFlags]
    return { operation, region, profile, prompt, texture, prepare: [...args, '--dry-run', '--', prompt], submit: [...args, '--', prompt] }
  }
  if (!isTaskId(taskId) || input.model !== undefined || input.texture !== undefined) {
    throw new Error('Processing needs the exact source task UUID and its original region and profile.')
  }
  if (operation === 'retarget') {
    if (!isRetargetPreset(preset) || prompt !== undefined || bodyType !== undefined) throw new Error('Choose one supported animation preset.')
    const retarget = `retarget:animation=${preset},out_format=glb,export_with_geometry=true`
    return { operation, region, profile, taskId, preset,
      prepare: ['make', '--then', retarget, '--dry-run', ...cliFlags, '--', taskId],
      submit: ['anim', 'retarget', '--animation', preset, '--out-format', 'glb', '-p', 'export_with_geometry=true', '--no-wait', ...cliFlags, '--', taskId],
    }
  }
  if (operation === 'rig') {
    if (!rigBodyTypes.includes(bodyType) || prompt !== undefined) throw new Error('Choose a supported rig body type.')
    const model = rigModelForBody(bodyType)
    const rig = `rig:model=${model},rig_type=${bodyType},out_format=glb`
    return { operation, region, profile, taskId, bodyType,
      prepare: ['make', '--then', rig, '--dry-run', ...cliFlags, '--', taskId],
      submit: ['anim', 'rig', '--model', model, '--rig-type', bodyType, '--out-format', 'glb', '--no-wait', ...cliFlags, '--', taskId],
    }
  }
  if (bodyType !== undefined) throw new Error('Texture does not take a rig body type.')
  const args = ['model', 'texture', '--model', 'v3.5', '--texture-quality', 'standard', '-p', 'pbr=false', '--no-wait', ...cliFlags]
  if (prompt !== undefined) args.push('-p', `texture_prompt=${JSON.stringify({ text: prompt })}`)
  return { operation, region, profile, taskId, ...(prompt ? { prompt } : {}), prepare: [...args, '--dry-run', '--', taskId], submit: [...args, '--', taskId] }
}

async function tripoAccount(ctx, query, region, profile) {
  const { result, data } = await runTripo(ctx, query, ['whoami'], profile)
  const resolved = resolveTripoProfile(data, region, profile)
  if (result.exitCode !== 0 || !resolved || typeof data.key !== 'string' || !Number.isFinite(data.balance)) {
    throw new Error('Could not verify the requested Tripo region and account. Check the original CLI profile.')
  }
  // Compare the CLI's masked account marker only in memory. It never enters a quote or receipt.
  return { ...resolved, marker: data.key, base: data.api_base_url, balance: data.balance }
}

function oneStep(plan, result) {
  const steps = result?.steps
  const step = Array.isArray(steps) && steps.length === 1 ? steps[0] : null
  const payload = step?.payload
  const expectedWarnings = (result?.warnings ?? []).every(warning => (
    (['rig', 'retarget'].includes(plan.operation) && warning.startsWith('chain legality unverified: upstream task type unknown '))
    || (plan.operation === 'texture' && warning === 'remote input availability, upstream task state and server-side acceptance are not checked by this offline plan')
  ))
  const exact = jobPayloadMatches(plan, payload)
  if (!result?.valid || step?.endpoint !== endpoints[plan.operation] || result.errors?.length || !expectedWarnings || !exact) {
    throw new Error('Tripo CLI did not validate the exact single operation. Review the request before estimating again.')
  }
  return step
}

function jobPayloadMatches(plan, payload) {
  if (plan.operation === 'retarget') return payload?.animation === plan.preset && payload.animations === undefined
    && payload.out_format === 'glb' && payload.export_with_geometry === true && (payload.input === '<upstream>' || payload.input === plan.taskId)
  if (!payload || typeof payload.model !== 'string' || !payload.model) return false
  if (plan.operation === 'generate') return payload.prompt === plan.prompt && payload.texture === plan.texture && payload.pbr === false
  if (plan.operation === 'rig') return payload.rig_type === plan.bodyType && payload.out_format === 'glb'
  return payload.input === plan.taskId && payload.texture_quality === 'standard' && payload.pbr === false
    && payload.texture_prompt?.text === plan.prompt
}

// Keep text from the model prompt out of Markdown headings, links, and fences.
const plain = (text) => text.replace(/[\r\n\s]+/g, ' ').replace(/[\\`*_{}\[\]()<>#+.!|~]/g, '\\$&')

function approvalDetail(quote) {
  const label = { generate: 'Text to GLB', rig: 'Rig existing model (GLB)', texture: 'Retexture existing model', retarget: 'Apply animation preset (GLB)' }[quote.operation]
  const modelLabel = quote.operation === 'retarget' ? approval.sourceRigModel ?? 'Source rig model' : approval.model
  const details = [
    `**${approval.operation}:** ${label}`,
    `**${approval.estimate}:** ${quote.estimatedCredits} ${approval.credits}`,
    `**${approval.account}:** ${quote.region} · ${plain(quote.profile ?? 'configured credentials')}`,
    `**${modelLabel}:** ${plain(quote.model)}`,
  ]
  if (quote.taskId) details.push(`**${approval.source}:** ${quote.taskId}`)
  if (quote.bodyType) details.push(`**${approval.bodyType}:** ${quote.bodyType}`)
  if (quote.preset) details.push(`**${approval.preset ?? 'Animation preset'}:** ${plain(quote.preset)}`)
  if (quote.operation === 'generate') details.push(`**${approval.texture}:** ${quote.texture ? 'on' : 'off'}`)
  if (quote.prompt) details.push(`**${approval.prompt}:** ${plain(quote.prompt)}`)
  return details.join('\n\n')
}

const status = (state, error) => ({ status: state, error })
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
const string = { type: 'string' }
const operationSchema = { type: 'string', enum: operations }
const regionSchema = { type: 'string', enum: taskRegions }
const generationSchema = { type: 'string', enum: generationModels }
const creditsSchema = { type: 'number' }
const textureSchema = { type: 'boolean' }

function reserveQuoteSlot(quotes, exec) {
  exec.signal.throwIfAborted()
  for (const [id, stored] of quotes) if (stored.quote.expiresAt <= Date.now()) quotes.delete(id)
  if (quotes.size >= 64) throw new Error('Too many active Tripo quotes. Wait for an existing quote to expire.')
}

async function estimateOperation(ctx, query, plan, account) {
  const checked = await runTripo(ctx, query, plan.prepare, account.profile, true)
  if (checked.result.exitCode !== 0) throw new Error('The Tripo CLI could not validate this request.')
  const { payload: { model } } = oneStep(plan, checked.data)
  const estimatedCredits = plan.operation === 'generate' ? checked.data.generation_credits_estimate : processingCredits[plan.operation]
  if (!Number.isSafeInteger(estimatedCredits) || estimatedCredits <= 0) {
    throw new Error('A Tripo list-price estimate is unavailable for these options. No task was created.')
  }
  return { model, estimatedCredits }
}

async function requestApproval(ctx, exec, id, question, detail, label) {
  let answer
  try {
    answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
      id, question, detail, options: [{ label }, { label: cancel }],
      intent: { kind: 'approval', approve: label, reject: cancel },
    }] })
  } catch (error) {
    if (error instanceof Error && error.name === 'UserQuestionError' && error.code === 'ASK_CANCELLED') return false
    throw error
  }
  const choice = answer.answers?.[0]
  return answer.answers?.length === 1 && choice?.id === id && choice.custom === undefined
    && choice.selected?.length === 1 && choice.selected[0] === label
}

function canSubmit(account, expected, cost) {
  return account.profile === expected.profile && account.marker === expected.marker && account.base === expected.base
    && account.balance >= cost
}

async function submitOperation(ctx, query, args, profile) {
  try {
    const { result, data } = await runTripo(ctx, query, args, profile, true)
    if (result.exitCode === 0 && isTaskId(data?.task_id)) return { taskId: data.task_id, status: 'queued' }
  } catch {
    // The CLI may have submitted the request before the connection closed.
  }
  return status('unknown', 'Tripo did not return a task ID. Check account usage and task history before any new submission.')
}

export async function preparePaidQuote(ctx, args, exec, source) {
  const plan = plannedOperation(args)
  if (plan.operation === 'retarget' && (!rigBodyTypes.includes(source?.rigBodyType)
    || !retargetPresets[source.rigBodyType].includes(plan.preset))) {
    throw new Error('Choose a compatible preset for a rigged model in this workspace.')
  }
  const query = createTripoQuery(ctx, exec)
  const account = await tripoAccount(ctx, query, plan.region, plan.profile)
  if (source) {
    const fingerprint = tripoAccountFingerprint(account.marker, account.base)
    if (!fingerprint || source.profile !== account.profile || (source.accountFingerprint && source.accountFingerprint !== fingerprint)) {
      throw new Error('Restore the Tripo account that created the source model.')
    }
  }
  let sourceRigModel
  if (plan.taskId) {
    const lookup = await runTripo(ctx, query, ['task', 'get', plan.taskId], account.profile)
    if (lookup.result.exitCode !== 0 || lookup.data?.task_id !== plan.taskId || lookup.data.status !== 'success') {
      throw new Error('The source task must be successful and accessible on the original Tripo account.')
    }
    if (plan.operation === 'retarget') {
      const { model, rig_type: bodyType, topology } = lookup.data.input ?? {}
      if (lookup.data.type !== 'animate_rig' || (bodyType !== undefined && bodyType !== source.rigBodyType)
        || (topology !== undefined && topology !== source.rigBodyType)
        || (model !== undefined && !isRetargetRigModel(model, source.rigBodyType))) {
        throw new Error('The source task does not match the original compatible Tripo rig.')
      }
      sourceRigModel = source.rigModel ?? model ?? rigModelForBody(source.rigBodyType)
    }
  }
  const { model, estimatedCredits } = await estimateOperation(ctx, query, plan, account)
  exec.signal.throwIfAborted()
  const { prepare, submit, profile, ...publicPlan } = plan
  if (source && (plan.operation === 'texture' || plan.operation === 'rig')) submit[submit.indexOf('--model') + 1] = model
  const quote = { ...publicPlan, ...(account.profile ? { profile: account.profile } : {}), quoteId: randomUUID(),
    model: sourceRigModel ?? model, estimatedCredits, pricing: plan.operation === 'generate' ? 'CLI list price' : 'Tripo API list price', expiresAt: Date.now() + quoteLifetime }
  return { quote, submit, account, sessionId: query.session.id, used: false }
}

export async function approvePaidQuote(ctx, pending, exec, questionId = 'tripo-submit') {
  const { quote } = pending
  try {
    exec.signal.throwIfAborted()
    if (!await requestApproval(ctx, exec, questionId, approval.question, approvalDetail(quote), approve)) {
      return status('cancelled', 'The user did not approve this Tripo task.')
    }
    exec.signal.throwIfAborted()
    if (quote.expiresAt <= Date.now()) return status('expired', 'This quote expired before submission. Estimate again.')

    const query = createTripoQuery(ctx, exec)
    const account = await tripoAccount(ctx, query, quote.region, quote.profile)
    if (!canSubmit(account, pending.account, quote.estimatedCredits)) {
      return status('unavailable', 'The Tripo account changed or has insufficient credits. Confirm the account and estimate again.')
    }
    exec.signal.throwIfAborted()
    return { status: 'approved', query, account }
  } catch {
    return exec.signal.aborted
      ? status('cancelled', 'The approval was cancelled.')
      : status('unavailable', 'Approval or account verification could not finish. No submission was initiated.')
  }
}

export async function dispatchPaidQuote(ctx, pending, { query }) {
  const { quote } = pending
  const result = await submitOperation(ctx, query, pending.submit, quote.profile)
  if (result.status !== 'queued') return result
  return { ...result, region: quote.region, ...(quote.profile ? { profile: quote.profile } : {}) }
}

export function registerPaidTools(ctx) {
  const quotes = new Map()

  ctx.tools.register({
    name: estimateToolName,
    description: 'Estimate one Tripo text-to-GLB generation, rig, or standard retexture. Returns a session-bound quoteId without creating a paid task. Use an exact source task UUID and original region/profile for follow-up operations. Rig requires the intended bodyType.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['operation', 'region'],
      properties: { operation: operationSchema, region: regionSchema, profile: string, taskId: string, prompt: string,
        model: generationSchema, texture: textureSchema, bodyType: { type: 'string', enum: rigBodyTypes } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false,
        required: ['quoteId', 'operation', 'region', 'model', 'estimatedCredits', 'pricing', 'expiresAt'],
        properties: { quoteId: string, operation: operationSchema, region: regionSchema, profile: string, taskId: string,
          prompt: string, texture: { type: 'boolean' }, bodyType: string, model: string,
          estimatedCredits: { type: 'number' }, pricing: string, expiresAt: { type: 'number' } },
      }, render,
    },
    async execute(args, exec) {
      const pending = await preparePaidQuote(ctx, args, exec)
      reserveQuoteSlot(quotes, exec)
      quotes.set(pending.quote.quoteId, pending)
      return pending.quote
    },
  })

  ctx.tools.register({
    name: submitToolName,
    description: 'Ask the user for one-time confirmation of an exact Tripo quote, then submit one paid task only if the host receives an explicit approval. Takes only quoteId from tripo_estimate. Never replay an unknown submission or submit via the shell as a fallback.',
    parameters: { type: 'object', additionalProperties: false, required: ['quoteId'], properties: { quoteId: string } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['status'],
        properties: { status: string, taskId: string, region: regionSchema, profile: string, error: string },
      }, render,
    },
    async execute({ quoteId }, exec) {
      if (!exec.agent || exec.agent.session.header.origin === 'subagent') {
        return status('unavailable', 'Confirm paid Tripo work in the main DSH conversation.')
      }
      const pending = quotes.get(quoteId)
      if (!pending || exec.agent.session.id !== pending.sessionId || pending.quote.expiresAt <= Date.now()) {
        return status('expired', 'This quote is unavailable in this conversation. Estimate the request again.')
      }
      if (pending.used) return status('alreadyUsed', 'This quote has already been handled. Check its result before doing anything else.')
      pending.used = true

      const approval = await approvePaidQuote(ctx, pending, exec)
      if (approval.status !== 'approved') return approval
      const receipt = await dispatchPaidQuote(ctx, pending, approval)
      if (receipt.status === 'queued') await recordSubmittedTask(approval.query, receipt, approval.account)
      return receipt
    },
  })

  registerBatchGenerationTools(ctx)
}

function batchApprovalDetail(quote) {
  const summary = [
    `**${approval.batchTotal}:** ${quote.estimatedCredits} ${approval.credits}`,
    `**${approval.account}:** ${quote.region} · ${plain(quote.profile ?? 'configured credentials')}`,
  ]
  const items = quote.items.map(({ prompt, model, estimatedCredits, texture }, index) => [
    `**${index + 1}. ${plain(prompt)}**`,
    `${approval.model}: ${plain(model)} · ${approval.texture}: ${texture ? 'on' : 'off'} · ${estimatedCredits} ${approval.credits}`,
  ].join('  \n'))
  return [...summary, ...items].join('\n\n')
}

async function dispatchBatch(ctx, query, pending, receipt, ledger) {
  const { quote, account, plans } = pending
  let failure
  for (const [index, plan] of plans.entries()) {
    let now
    try {
      query.signal.throwIfAborted()
      now = await tripoAccount(ctx, query, quote.region, quote.profile)
      const cost = index === 0 ? quote.estimatedCredits : quote.items[index].estimatedCredits
      if (!canSubmit(now, account, cost)) {
        failure = 'The account changed or has insufficient credits for the remaining tasks.'
        break
      }
    } catch {
      failure = query.signal.aborted ? 'The batch was interrupted.' : 'The Tripo account could not be verified for the remaining tasks.'
      break
    }

    const item = receipt.tasks[index]
    // Persist a possibly charged attempt before dispatch. Recovery only reads this marker.
    receipt.tasks[index] = { ...item, ...status('unknown', 'Submission was interrupted. Check account usage and task history.') }
    await ledger.write(receipt)
    if (query.signal.aborted) {
      receipt.tasks[index] = item
      failure = 'The batch was interrupted.'
      break
    }
    const result = { ...item, ...await submitOperation(ctx, query, plan.submit, quote.profile) }
    receipt.tasks[index] = result
    try {
      await ledger.write(receipt)
    } finally {
      if (result.status === 'queued') await recordSubmittedTask(query, result, now)
    }
  }

  const queued = receipt.tasks.filter(task => task.status === 'queued').length
  const outcome = queued === plans.length ? 'submitted' : queued > 0 ? 'partial'
    : receipt.tasks.some(task => task.status === 'unknown') ? 'unknown'
      : query.signal.aborted ? 'cancelled' : 'unavailable'
  return failure ? status(outcome, failure) : { status: outcome }
}

function registerBatchGenerationTools(ctx) {
  const batches = new Map()
  const batchIdSchema = { batchId: string }
  const accountSchema = { region: regionSchema, profile: string }
  const costSchema = { estimatedCredits: creditsSchema }

  ctx.tools.register({
    name: 'tripo_batch_estimate',
    description: `Estimate a batch of 2 to ${maxTasks} text-to-GLB generations with the same Tripo region, CLI profile, model and texture setting. Returns a session-bound batchId and list-price total without creating tasks.`,
    parameters: { type: 'object', additionalProperties: false, required: ['prompts', 'region'], properties: {
      prompts: { type: 'array', items: string }, ...accountSchema, model: generationSchema, texture: textureSchema,
    } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['batchId', 'region', 'items', 'estimatedCredits', 'expiresAt'], properties: {
        ...batchIdSchema, ...accountSchema, ...costSchema, expiresAt: { type: 'number' },
        items: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['prompt', 'model', 'texture', 'estimatedCredits'],
          properties: { prompt: string, model: string, texture: textureSchema, ...costSchema } } },
      } }, render,
    },
    async execute({ prompts, region, profile, model, texture }, exec) {
      if (!Array.isArray(prompts) || prompts.length < 2 || prompts.length > maxTasks) {
        throw new Error(`Use 2 to ${maxTasks} explicit text prompts from one Tripo account.`)
      }
      const plans = Array.from(prompts, prompt => plannedOperation({ operation: 'generate', region, profile, model, texture, prompt }))
      const query = createTripoQuery(ctx, exec)
      const account = await tripoAccount(ctx, query, region, profile)
      const items = []
      for (const plan of plans) {
        const estimate = await estimateOperation(ctx, query, plan, account)
        // Lock the dated model shown in the approval even if a CLI alias changes afterwards.
        plan.submit[plan.submit.indexOf('--model') + 1] = estimate.model
        items.push({ prompt: plan.prompt, texture: plan.texture, ...estimate })
      }
      const estimatedCredits = items.reduce((sum, item) => sum + item.estimatedCredits, 0)
      if (!Number.isSafeInteger(estimatedCredits)) throw new Error('A Tripo list-price total is unavailable. No task was created.')
      reserveQuoteSlot(batches, exec)
      const quote = { batchId: randomUUID(), region, ...(account.profile ? { profile: account.profile } : {}),
        items, estimatedCredits, expiresAt: Date.now() + quoteLifetime }
      batches.set(quote.batchId, { quote, plans, account, sessionId: query.session.id, used: false })
      return structuredClone(quote)
    },
  })

  ctx.tools.register({
    name: batchSubmitToolName,
    description: 'Confirm one exact tripo_batch_estimate batch in DSH and submit the listed paid tasks. Pass only that batchId. Reuse the same batchId to recover its saved results after interruption or restart. An unknown item must not be replayed.',
    parameters: { type: 'object', additionalProperties: false, required: ['batchId'], properties: batchIdSchema },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['batchId', 'status'], properties: {
        ...batchIdSchema, ...accountSchema, status: string, error: string,
        tasks: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['index', 'status', 'region'], properties: {
            ...accountSchema, index: { type: 'number' }, status: string, error: string, taskId: string,
          } } },
      } }, render,
    },
    async execute({ batchId }, exec) {
      if (!isTaskId(batchId)) throw new Error('Use a batchId returned by tripo_batch_estimate.')
      const session = exec.agent?.session
      if (!session || session.header.origin === 'subagent' || typeof session.id !== 'string') {
        return { batchId, ...status('unavailable', 'Confirm paid Tripo work in the main DSH conversation.') }
      }

      let receipt = { batchId }
      try {
        const ledger = batchLedger(createTripoQuery(ctx, exec), batchId)
        const stored = await ledger.read()
        if (stored) return stored
        const pending = batches.get(batchId)
        if (!pending || session.id !== pending.sessionId || pending.quote.expiresAt <= Date.now()) {
          return { batchId, ...status('expired', 'This batch quote is unavailable in this conversation.') }
        }
        if (pending.used) return { batchId, status: 'incomplete' }
        pending.used = true
        if (!await ledger.reserve()) return await ledger.read() ?? { batchId, status: 'incomplete' }

        const { quote } = pending
        const account = { region: quote.region, ...(quote.profile ? { profile: quote.profile } : {}) }
        receipt = { batchId, ...account, status: 'incomplete', tasks: quote.items.map((_, index) => ({
          index: index + 1, ...account, status: 'notSubmitted',
        })) }
        await ledger.write(receipt)
        let terminal
        try {
          exec.signal.throwIfAborted()
          if (!await requestApproval(ctx, exec, 'tripo-batch-submit', approval.batchQuestion, batchApprovalDetail(quote), approveBatch)) {
            terminal = status('cancelled', 'The user did not approve this Tripo batch.')
          } else if (quote.expiresAt <= Date.now()) {
            terminal = status('expired', 'This batch quote expired before submission.')
          }
        } catch {
          terminal = exec.signal.aborted ? status('cancelled', 'The approval was cancelled.')
            : status('unavailable', 'The native approval could not finish.')
        }
        if (!terminal) {
          terminal = await dispatchBatch(ctx, createTripoQuery(ctx, exec), pending, receipt, ledger)
        }
        Object.assign(receipt, terminal)
        await ledger.write(receipt)
        return receipt
      } catch {
        return receipt.tasks ? { ...receipt, ...status('incomplete', 'The batch was interrupted. Check its saved task IDs and account history before starting new work.') }
          : { batchId, ...status('unavailable', 'Could not access the Tripo batch receipt. No new task was submitted.') }
      }
    },
  })
}
