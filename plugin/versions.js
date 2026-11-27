import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { readTaskRecoveryEntry } from './resume.js'
import { createTripoQuery, inspectTask, resolveTripoProfile, runTripo, tripoAccountFingerprint } from './task.js'
import {
  batchSubmitToolName, batchToolName, isRetargetPreset, isRetargetRigModel, isTaskId, latestTaskReceipt, parseTaskReceipt,
  readBatchReceipts, readTaskReceipt, retargetPresets, rigBodyTypes, submitToolName, taskRecoveryKey, taskToolName, validateTextureSelection,
} from './workspace.js'

const empty = { versions: [] }
const historyWindow = 512
const writes = new Map()
const refreshes = new Map()

function ledgerPath(query) {
  const home = query.dshEnv.DSH_HOME
  if (typeof home !== 'string' || !isAbsolute(home)) return undefined
  const key = createHash('sha256').update(JSON.stringify([query.session.id, query.root])).digest('hex')
  return join(home, 'tripo-texture-versions-v1', `${key}.json`)
}

function publicReceipt({ taskId, region, profile, status, progress, modelPath, errorCode, seq }) {
  return { taskId, region, ...(profile ? { profile } : {}), status,
    ...(progress !== undefined ? { progress } : {}), ...(modelPath ? { modelPath } : {}),
    ...(errorCode ? { errorCode } : {}), ...(Number.isSafeInteger(seq) && seq >= 0 ? { seq } : {}) }
}

function validVersionOperation({ operation, bodyType, rigModel, preset }) {
  if (operation === 'rig') return rigBodyTypes.includes(bodyType) && preset === undefined && (rigModel === undefined || isRetargetRigModel(rigModel, bodyType))
  if (operation === 'retarget') return bodyType === undefined && rigModel === undefined && isRetargetPreset(preset)
  return (operation === undefined || operation === 'texture') && bodyType === undefined && rigModel === undefined && preset === undefined
}

function publicOperation({ operation, bodyType, preset }) {
  if (operation === 'rig') return { operation, bodyType }
  if (operation === 'retarget') return { operation, preset }
  return {}
}

function rigPermitsPreset(rig, preset) {
  return rig?.operation === 'rig' && retargetPresets[rig.bodyType]?.includes(preset)
}

function validLedgerGroup(group) {
  if (!parseTaskReceipt(group?.source) || !/^[a-f0-9]{64}$/.test(group.accountFingerprint ?? '') || !Array.isArray(group.children)) return false
  const earlier = new Map([[group.source.taskId.toLowerCase(), undefined]])
  for (const child of group.children) {
    const { receipt, quoteId, operation, preset, inputTaskId } = child ?? {}
    if (!parseTaskReceipt(receipt) || receipt.region !== group.source.region || receipt.profile !== group.source.profile
      || !validVersionOperation(child) || earlier.has(receipt.taskId.toLowerCase()) || (quoteId !== undefined && !isTaskId(quoteId))) return false
    if (operation === 'rig' || operation === 'retarget') {
      if (!isTaskId(inputTaskId) || !earlier.has(inputTaskId.toLowerCase())) return false
      if (operation === 'retarget' && !rigPermitsPreset(earlier.get(inputTaskId.toLowerCase()), preset)) return false
    } else if (inputTaskId !== undefined) {
      return false
    }
    earlier.set(receipt.taskId.toLowerCase(), child)
  }
  return true
}

async function readLedger(path) {
  if (!path) return []
  try {
    const groups = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(groups) || !groups.every(validLedgerGroup)) throw new Error('The Tripo texture version history is invalid.')
    return groups
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function serialize(queue, key, work) {
  const previous = queue.get(key)
  const current = (previous ? previous.catch(() => {}) : Promise.resolve()).then(work)
  queue.set(key, current)
  try {
    return await current
  } finally {
    if (queue.get(key) === current) queue.delete(key)
  }
}

async function editLedger(path, update) {
  if (!path) throw new Error('The DSH session has no local texture version history.')
  return await serialize(writes, path, async () => {
    const groups = await readLedger(path)
    update(groups)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(groups), { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  })
}

const selectedKey = input => taskRecoveryKey({ ...input, taskId: input.sourceTaskId })

function selectGroup(groups, input) {
  if (!input.sourceTaskId) return groups.at(-1)
  const key = selectedKey(input)
  return groups.find(group => taskRecoveryKey(group.source) === key
    || group.children.some(({ receipt }) => taskRecoveryKey(receipt) === key))
}

function setGroup(groups, replacement) {
  const index = groups.findIndex(group => taskRecoveryKey(group.source) === taskRecoveryKey(replacement.source))
  if (index === -1) groups.push(replacement)
  else groups[index] = replacement
}

function historyReceipt(session, input) {
  const key = selectedKey(input)
  const recentStart = Math.max(0, session.seq - historyWindow)
  const spans = [[recentStart, session.seq]]
  // The card sequence can locate older receipts without scanning the full conversation.
  if (input.sourceSeq !== undefined && input.sourceSeq < session.seq && input.sourceSeq - historyWindow < recentStart) {
    spans.unshift([Math.max(0, input.sourceSeq - historyWindow), Math.min(session.seq, input.sourceSeq + 1)])
  }
  let best
  for (const [start, end] of spans) {
    const calls = new Map()
    for (const event of session.snapshotEvents(start, end)) {
      if (!session.isOwnSeq(event.seq)) continue
      if (event.type === 'tool/call') calls.set(String(event.data.callId), event.data.name)
      if (event.type !== 'tool/result' || event.data.message.isError) continue
      const { message } = event.data
      const name = calls.get(String(message.source?.callId ?? message.toolCallId))
      const matches = name === batchToolName || name === batchSubmitToolName ? readBatchReceipts(message.content)
        : name === taskToolName || name === submitToolName ? [readTaskReceipt(message.content)] : []
      for (const receipt of matches) {
        if (receipt && taskRecoveryKey(receipt) === key) best = latestTaskReceipt(best, publicReceipt({ ...receipt, seq: event.seq }))
      }
    }
  }
  return best
}

async function checkLocalPath(query, receipt) {
  if (!receipt?.modelPath) return receipt
  const { modelPath, ...withoutPath } = receipt
  try {
    const root = await realpath(query.root)
    const path = join(root, modelPath)
    if ((await lstat(path)).isFile() && await realpath(path) === path) return receipt
  } catch {
    // A removed, replaced or inaccessible file can be fetched again by its known task ID.
  }
  return withoutPath
}

async function findSource(query, input, groups, exact = false) {
  const group = selectGroup(groups, input)
  if (group) {
    const selected = exact && group.children.find(({ receipt }) => taskRecoveryKey(receipt) === selectedKey(input))
    if (selected) {
      const request = { ...input, sourceTaskId: selected.receipt.taskId }
      const recovery = await readTaskRecoveryEntry(query, selected.receipt)
      const known = recovery?.accountFingerprint === group.accountFingerprint
        ? latestTaskReceipt(selected.receipt, recovery.receipt, true) : selected.receipt
      const history = historyReceipt(query.session, request)
      const receipt = history ? latestTaskReceipt(known, history) : known
      return { ...await checkLocalPath(query, receipt), accountFingerprint: group.accountFingerprint,
        ...(selected.operation === 'rig' ? { rigBodyType: selected.bodyType, rigModel: selected.rigModel } : {}) }
    }
    const source = await checkLocalPath(query, group.source)
    if (!source.modelPath) {
      const legacy = await checkLocalPath(query, historyReceipt(query.session, {
        ...input, sourceTaskId: source.taskId, region: source.region, profile: source.profile,
      }))
      if (legacy?.modelPath) return { ...legacy, accountFingerprint: group.accountFingerprint }
    }
    return { ...source, accountFingerprint: group.accountFingerprint }
  }
  if (!input.sourceTaskId) return undefined
  const historical = await checkLocalPath(query, historyReceipt(query.session, input))
  const stored = await readTaskRecoveryEntry(query, { ...input, taskId: input.sourceTaskId })
  const receipt = historical ? latestTaskReceipt(stored?.receipt, historical) : stored?.receipt
  return receipt ? { ...receipt, ...(stored ? { accountFingerprint: stored.accountFingerprint } : {}) } : undefined
}

export async function findTextureSource(query, input, { exact = false } = {}) {
  validateTextureSelection(input)
  const groups = await readLedger(ledgerPath(query))
  return await findSource(query, input, groups, exact)
}

export async function recordTextureVersion(query, details, account) {
  const { sourceTaskId, taskId, region, profile, sourceSeq, quoteId, operation, rigModel, preset, inputTaskId } = details
  const selection = { sourceTaskId, region, profile, sourceSeq }
  validateTextureSelection(selection)
  const exact = operation === 'rig' || operation === 'retarget'
  const accountFingerprint = tripoAccountFingerprint(account?.marker, account?.base)
  if (!accountFingerprint || account.profile !== profile || !isTaskId(taskId) || taskId.toLowerCase() === sourceTaskId.toLowerCase()
    || (quoteId !== undefined && !isTaskId(quoteId)) || !validVersionOperation(details)
    || (inputTaskId !== undefined && (!exact || !isTaskId(inputTaskId) || inputTaskId.toLowerCase() !== sourceTaskId.toLowerCase()))) {
    throw new Error('Invalid confirmed Tripo model version.')
  }
  const path = ledgerPath(query)
  // Once a paid task has an ID, finish recording it even if the caller left its tab.
  const sourceQuery = { ...query, signal: AbortSignal.timeout(10_000) }
  const source = await findTextureSource(sourceQuery, selection, { exact }).catch(() => undefined)
  if (source?.accountFingerprint && source.accountFingerprint !== accountFingerprint) throw new Error('The original Tripo account changed.')
  const candidate = publicReceipt({ ...source, taskId: source?.taskId ?? sourceTaskId, region, profile, status: 'success' })
  const child = publicReceipt({ taskId, region, profile, status: 'queued' })
  await editLedger(path, groups => {
    const existing = selectGroup(groups, selection)
    const rootSource = !existing || taskRecoveryKey(existing.source) === selectedKey(selection)
    if (existing && (existing.accountFingerprint !== accountFingerprint || (!rootSource && !exact))) {
      throw new Error('This Tripo version group does not belong to the original model and account.')
    }
    let children = existing?.children ?? []
    if (operation === 'retarget' && !rigPermitsPreset(children.find(({ receipt }) => taskRecoveryKey(receipt) === selectedKey(selection)), preset)) {
      throw new Error('The animation preset does not belong to this model’s rig.')
    }
    if (children.some(item => taskRecoveryKey(item.receipt) === taskRecoveryKey(child))) return
    if (selectGroup(groups, { ...selection, sourceTaskId: taskId })) throw new Error('This task is already linked to another Tripo model.')
    if (quoteId && groups.some(group => group.children.some(item => item.quoteId === quoteId))) {
      throw new Error('This Tripo quote already has a different version.')
    }
    const original = rootSource && !existing?.source.modelPath && candidate.modelPath ? candidate : existing?.source ?? candidate
    if (!rootSource) children = children.map(item => taskRecoveryKey(item.receipt) === selectedKey(selection)
      ? { ...item, receipt: { ...item.receipt, ...candidate, taskId: item.receipt.taskId } } : item)
    const processing = exact ? { ...publicOperation(details), inputTaskId: candidate.taskId, ...(rigModel ? { rigModel } : {}) } : {}
    if (existing) groups.splice(groups.indexOf(existing), 1)
    groups.push({ source: original, accountFingerprint, children: [...children, { receipt: child, ...(quoteId ? { quoteId } : {}), ...processing }] })
  })
}

export async function recoverTextureSubmission(query, quoteId) {
  if (!isTaskId(quoteId)) return undefined
  for (const group of await readLedger(ledgerPath(query))) {
    const item = group.children.find(child => child.quoteId === quoteId)
    if (item) {
      const { taskId, region, profile } = item.receipt
      return { status: 'queued', sourceTaskId: item.inputTaskId ?? group.source.taskId, taskId, region, ...(profile ? { profile } : {}), ...publicOperation(item) }
    }
  }
  return undefined
}

async function publicVersions(query, source, children = []) {
  if (!source) return empty
  const safeSource = await checkLocalPath(query, publicReceipt(source))
  const versions = await Promise.all(children.map(async item => ({
    ...await checkLocalPath(query, publicReceipt(item.receipt)), sourceTaskId: source.taskId,
    ...publicOperation(item), ...(item.inputTaskId ? { inputTaskId: item.inputTaskId } : {}),
  })))
  return { source: safeSource, versions }
}

async function identifyAccount(ctx, query, source) {
  const { result, data } = await runTripo(ctx, query, ['whoami'], source.profile)
  const resolved = resolveTripoProfile(data, source.region, source.profile)
  return result.exitCode === 0 && resolved && resolved.profile === source.profile
    ? tripoAccountFingerprint(data.key, data.api_base_url) : undefined
}

async function refreshReceipt(ctx, query, exec, receipt, accountFingerprint) {
  const local = await checkLocalPath(query, receipt)
  if (local.modelPath || ['failed', 'cancelled', 'banned', 'expired'].includes(local.status)) return local
  const outcome = await inspectTask(ctx, { ...local, download: true }, exec, accountFingerprint)
  if (local.status === 'success' && outcome.status === 'unknown') return { ...local, errorCode: outcome.errorCode }
  return publicReceipt({ ...outcome, ...(local.seq !== undefined ? { seq: local.seq } : {}) })
}

export async function readTextureVersions(ctx, exec, input, { refresh = false } = {}) {
  validateTextureSelection(input, { optional: true, target: refresh })
  const query = createTripoQuery(ctx, exec)
  const path = ledgerPath(query)
  if (refresh && !path) throw new Error('The DSH session has no local texture version history.')
  if (refresh) return await serialize(refreshes, path ?? query.session.id, async () => {
    exec.signal.throwIfAborted()
    const groups = await readLedger(path)
    const group = selectGroup(groups, input)
    const found = await findSource(query, input, groups)
    if (!found) return empty
    const { accountFingerprint: knownAccount, ...source } = found
    const target = input.targetTaskId?.toLowerCase()
    const isSource = !target || source.taskId.toLowerCase() === target
    const child = target && !isSource ? group?.children.find(item => item.receipt.taskId.toLowerCase() === target)
      : !target ? group?.children.at(-1) : undefined
    if (!isSource && !child) throw new Error('This Tripo version does not belong to the selected model.')
    const accountFingerprint = knownAccount ?? await identifyAccount(ctx, query, source)
    if (!accountFingerprint) return publicVersions(query, { ...source, errorCode: 'accountMismatch' }, group?.children)
    const original = isSource ? await refreshReceipt(ctx, query, exec, source, accountFingerprint) : source
    const version = child ? await refreshReceipt(ctx, query, exec, child.receipt, accountFingerprint) : undefined
    if (!group && original.status !== 'success') return publicVersions(query, original)
    let updated
    await editLedger(path, current => {
      const existing = selectGroup(current, { ...source, sourceTaskId: source.taskId })
      if (existing && existing.accountFingerprint !== accountFingerprint) throw new Error('The original Tripo account changed.')
      const children = existing?.children ?? []
      updated = { source: original, accountFingerprint, children: children.map(item => (
        version && taskRecoveryKey(item.receipt) === taskRecoveryKey(version) ? { ...item, receipt: version } : item
      )) }
      setGroup(current, updated)
    })
    return publicVersions(query, updated.source, updated.children)
  })
  const groups = await readLedger(path)
  const group = selectGroup(groups, input)
  return publicVersions(query, await findSource(query, input, groups), group?.children)
}
