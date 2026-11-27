export const demoToolName = 'tripo_workspace_demo'
export const demoTaskIds = ['demo-mesh-a', 'demo-mesh-b']
export const taskToolName = 'tripo_task'
export const estimateToolName = 'tripo_estimate'
export const submitToolName = 'tripo_submit'
export const batchToolName = 'tripo_batch'
export const batchSubmitToolName = 'tripo_batch_submit'
export const taskIdPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
export const profilePattern = '^[a-z0-9][a-z0-9_-]{0,31}$'
export const taskRegions = ['cn', 'ov']
export const taskStatuses = ['queued', 'running', 'success', 'failed', 'cancelled', 'banned', 'expired', 'unknown']
export const taskErrorCodes = ['accountMismatch', 'taskNotFound', 'statusUnavailable', 'downloadFailed', 'invalidOutput']
const terminalTaskStatuses = ['success', 'failed', 'cancelled', 'banned', 'expired']
const maxModelPreviewBytes = 128 * 1024 * 1024
const taskIdRegex = new RegExp(taskIdPattern)
const profileRegex = new RegExp(profilePattern)

export function isTaskId(value) {
  return typeof value === 'string' && value.length === 36 && taskIdRegex.test(value)
}

export function isTaskProfile(value) {
  return typeof value === 'string' && value.trim() === value && profileRegex.test(value)
}

export function isTaskModelPath(path, taskId) {
  return typeof path === 'string' && path.trim() === path && path.startsWith(`tripo-task-${taskId.slice(0, 8).toLowerCase()}-`)
    && /^tripo-task-[a-f0-9]{8}-[A-Za-z0-9]{6}\/[A-Za-z0-9_.-]+\.glb$/i.test(path)
}

export function readTaskReceipt(content) {
  const text = content?.find((entry) => entry.type === 'text')?.text
  if (typeof text !== 'string') return null
  try {
    return parseTaskReceipt(JSON.parse(text))
  } catch {
    return null
  }
}

export function parseTaskReceipt(result) {
  if (!isTaskId(result?.taskId)
    || !taskRegions.includes(result.region) || !taskStatuses.includes(result.status)
    || (result.profile !== undefined && !isTaskProfile(result.profile))
    || (result.progress !== undefined && (!Number.isFinite(result.progress) || result.progress < 0 || result.progress > 100))
    || (result.modelPath !== undefined && (result.status !== 'success' || !isTaskModelPath(result.modelPath, result.taskId)))
    || (result.error !== undefined && typeof result.error !== 'string')
    || (result.errorCode !== undefined && !taskErrorCodes.includes(result.errorCode))) return null
  return result
}

export function taskRecoveryKey({ taskId, region, profile }) {
  return `${taskId.toLowerCase()}/${region}/${profile ?? ''}`
}

function recoveryCodec(name, parse) {
  return { mode: 'strict', typeSymbol: `@vastai/tripo-dsh#${name}`, create: () => ({ parse }) }
}

const sessionIdCodec = recoveryCodec('SessionId', value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError('A DSH session ID is required.')
  }
  return value
})

export const taskRecoveryEndpoint = {
  id: '@vastai/tripo-dsh#tripoTasks/resume',
  service: 'tripoTasks', namespace: 'tripoTasks', method: 'resume', invocation: { kind: 'direct' },
  parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
  cancellation: { parameter: 'signal' },
  result: recoveryCodec('TaskRecovery', value => {
    if (typeof value?.polling !== 'boolean' || !Array.isArray(value?.tasks) || value.tasks.length > 8
      || value.tasks.some(task => !parseTaskReceipt(task)
        || (task.seq !== undefined && (!Number.isSafeInteger(task.seq) || task.seq < 0)))) {
      throw new TypeError('Invalid Tripo recovery snapshot.')
    }
    return value
  }),
}

export const textureRemotePackage = '@vastai/tripo-dsh-retexture'
export const rigBodyTypes = Object.freeze(['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others'])
export const retargetPresets = Object.freeze({
  biped: Object.freeze(['idle', 'walk', 'run', 'dive', 'climb', 'jump', 'slash', 'shoot', 'hurt', 'fall', 'turn'].map(name => `preset:${name}`)),
  quadruped: Object.freeze(['preset:quadruped:walk']),
  hexapod: Object.freeze(['preset:hexapod:walk']),
  octopod: Object.freeze(['preset:octopod:walk']),
  avian: Object.freeze([]),
  serpentine: Object.freeze(['preset:serpentine:march']),
  aquatic: Object.freeze(['preset:aquatic:march']),
  others: Object.freeze([]),
})

export function isRetargetPreset(preset) {
  return Object.values(retargetPresets).some(presets => presets.includes(preset))
}

export function rigModelForBody(bodyType) {
  return bodyType === 'biped' || bodyType === 'others' ? 'v3.0' : 'v2.5'
}

export function isRetargetRigModel(model, bodyType) {
  return typeof model === 'string' && /^v(?:2\.5|3\.0)(?:-\d{8})?$/.test(model)
    && model.split('-')[0] === rigModelForBody(bodyType)
}

export function workspaceApprovalId(quoteId) {
  return `tripo-workspace-${quoteId}`
}

function validProcessingFields({ operation, bodyType, prompt, preset }, quote = false) {
  if (operation === 'rig') return rigBodyTypes.includes(bodyType) && prompt === undefined && preset === undefined
  if (operation === 'retarget') return isRetargetPreset(preset) && bodyType === undefined && prompt === undefined
  return (operation === undefined || operation === 'texture') && bodyType === undefined && preset === undefined
    && (!quote || (typeof prompt === 'string' && prompt.trim() && prompt.length <= 1000 && !prompt.includes('\0')))
}

export function validateTextureSelection(value, { optional = false, quote = false, target = false } = {}) {
  const allowed = ['sourceTaskId', 'region', 'profile', 'sourceSeq', ...(quote ? ['operation', 'prompt', 'bodyType', 'preset'] : []), ...(target ? ['targetTaskId'] : [])]
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TypeError('Invalid Tripo texture selection.')
  }
  if (optional && Object.keys(value).length === 0) return value
  if (!isTaskId(value.sourceTaskId) || !taskRegions.includes(value.region)
    || (value.profile !== undefined && !isTaskProfile(value.profile))
    || (value.sourceSeq !== undefined && (!Number.isSafeInteger(value.sourceSeq) || value.sourceSeq < 0))
    || (value.targetTaskId !== undefined && !isTaskId(value.targetTaskId))
    || (quote && !validProcessingFields(value, true))) {
    throw new TypeError('Use an existing Tripo task, its original region and profile, and valid processing parameters.')
  }
  return value
}

const textureVersionsCodec = recoveryCodec('TextureVersions', value => {
  if (!Array.isArray(value?.versions) || (value.source !== undefined && !parseTaskReceipt(value.source))
    || value.versions.some(receipt => !value.source || !parseTaskReceipt(receipt)
      || receipt.sourceTaskId !== value.source.taskId || receipt.region !== value.source.region || receipt.profile !== value.source.profile
      || !validProcessingFields(receipt) || (['rig', 'retarget'].includes(receipt.operation) && !isTaskId(receipt.inputTaskId)))) {
    throw new TypeError('Invalid Tripo model versions.')
  }
  return value
})

function textureEndpoint(method, inputName, inputCodec, result) {
  const namespace = 'tripoTexture'
  return {
    id: `${textureRemotePackage}#${namespace}/${method}`, service: namespace, namespace, method, invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec },
      { name: inputName, wire: inputName, source: 'json', codec: inputCodec },
    ],
    cancellation: { parameter: 'signal' }, result,
  }
}

export const textureEndpoints = [
  textureEndpoint('quote', 'input', recoveryCodec('TextureQuoteInput', value => validateTextureSelection(value, { quote: true })),
    recoveryCodec('TextureQuote', value => {
      if (!isTaskId(value?.quoteId) || !isTaskId(value.sourceTaskId) || !taskRegions.includes(value.region)
        || (value.profile !== undefined && !isTaskProfile(value.profile))
        || !validProcessingFields(value, true) || typeof value.model !== 'string' || typeof value.pricing !== 'string'
        || !Number.isSafeInteger(value.estimatedCredits) || value.estimatedCredits <= 0 || !Number.isSafeInteger(value.expiresAt)) {
        throw new TypeError('Invalid Tripo processing quote.')
      }
      return value
    })),
  textureEndpoint('submit', 'quoteId', recoveryCodec('TextureQuoteId', value => {
    if (!isTaskId(value)) throw new TypeError('An exact Tripo processing quote is required.')
    return value
  }), recoveryCodec('TextureSubmission', value => {
    if (!['queued', 'cancelled', 'expired', 'unavailable', 'alreadyUsed', 'unknown'].includes(value?.status)
      || (value.status === 'queued' && (!parseTaskReceipt(value) || !isTaskId(value.sourceTaskId) || !validProcessingFields(value)))) {
      throw new TypeError('Invalid Tripo processing submission.')
    }
    return value
  })),
  textureEndpoint('versions', 'input', recoveryCodec('TextureVersionsInput', value => validateTextureSelection(value, { optional: true })), textureVersionsCodec),
  textureEndpoint('refresh', 'input', recoveryCodec('TextureRefreshInput', value => validateTextureSelection(value, { optional: true, target: true })), textureVersionsCodec),
]

export function latestTaskReceipt(previous, receipt, recovered = false) {
  if (!previous) return receipt
  const sameIdentity = receipt.taskId === previous.taskId && receipt.region === previous.region && receipt.profile === previous.profile
  const seq = receipt.seq ?? -1
  const previousSeq = previous.seq ?? -1
  if (!sameIdentity) return !recovered && seq > previousSeq ? receipt : previous
  const wasTerminal = terminalTaskStatuses.includes(previous.status)
  const isTerminal = terminalTaskStatuses.includes(receipt.status)
  const hasNewFile = receipt.status === 'success' && !previous.modelPath && isTaskModelPath(receipt.modelPath, receipt.taskId)
  // Tool cards can mount out of order. Keep the completed state and its file across a pending replay.
  if (seq < previousSeq) {
    if (isTerminal && !wasTerminal && (hasNewFile || (!recovered && !receipt.modelPath))) {
      return { ...receipt, ...(previous.errorCode ? { errorCode: previous.errorCode } : {}), seq: previous.seq }
    }
    return previous.status === 'success' && hasNewFile ? { ...previous, modelPath: receipt.modelPath } : previous
  }
  if (seq === previousSeq && !recovered && !hasNewFile) return previous
  if (wasTerminal && (['queued', 'running'].includes(receipt.status) || (recovered && receipt.status === 'unknown'))) {
    return seq > previousSeq ? { ...previous, seq } : previous
  }
  const next = previous.modelPath && !receipt.modelPath && (receipt.status === 'success'
    || (receipt.status === 'unknown' && receipt.errorCode))
    ? { ...receipt, status: 'success', modelPath: previous.modelPath } : receipt
  const keys = Object.keys(next)
  return keys.length === Object.keys(previous).length && keys.every(key => Object.is(next[key], previous[key])) ? previous : next
}

export function readBatchReceipts(content) {
  try {
    const result = JSON.parse(content?.find((entry) => entry.type === 'text')?.text)
    return Array.isArray(result?.tasks) ? result.tasks.map(parseTaskReceipt).filter(Boolean) : []
  } catch {
    return []
  }
}

export function readAssetHistory(records) {
  const calls = new Map()
  const assets = new Map()
  for (const { event } of records) {
    if (event?.type === 'tool/call') {
      calls.set(event.data.callId, event.data.name)
    } else if (event?.type === 'tool/result') {
      const { message } = event.data
      if (message.isError) continue
      const name = calls.get(message.toolCallId)
      const receipts = name === batchToolName ? readBatchReceipts(message.content)
        : name === taskToolName ? [readTaskReceipt(message.content)] : []
      for (const receipt of receipts) {
        if (receipt?.modelPath) assets.set(taskRecoveryKey(receipt), { ...receipt, seq: event.seq, time: event.time })
      }
    }
  }
  return [...assets.values()]
}

export function workspaceGlbPath(address, sessionId) {
  if (typeof address !== 'string') return null
  const match = /^dsh-resource:\/\/file\/session\/([^/?#]+)\/([^?#]+)(?:[?#].*)?$/.exec(address)
  if (!match) return null
  try {
    if (decodeURIComponent(match[1]) !== sessionId) return null
    const path = match[2].split('/').map(decodeURIComponent).join('/')
    return /\.glb$/i.test(path) ? path : null
  } catch {
    return null
  }
}

export async function readWorkspaceModel(readBytes, path, signal) {
  const full = await readBytes(path, {}, signal)
  signal.throwIfAborted()
  if (full.ok || full.error?.code !== 'workspace-file/too-large') return full

  // DSH applies separate caps to a complete read and to each native byte window.
  let bytes
  let version
  for (let offset = 0; ; ) {
    const reply = await readBytes(path, { range: { offset } }, signal)
    signal.throwIfAborted()
    if (!reply.ok) return reply
    const chunk = reply.value
    if (!bytes) {
      if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0) throw new Error('Model size is unavailable')
      if (chunk.bytes > maxModelPreviewBytes) return full
      bytes = new Uint8Array(chunk.bytes)
      version = chunk.version
    }
    const data = chunk.data
    if (!(data instanceof Uint8Array) || data.byteLength === 0 || chunk.offset !== offset
      || chunk.version !== version || chunk.bytes !== bytes.byteLength || offset + data.byteLength > bytes.byteLength) {
      throw new Error('Model changed while being read')
    }
    bytes.set(data, offset)
    offset += data.byteLength
    if (chunk.eof && offset === bytes.byteLength) return { ok: true, value: { data: bytes, version } }
    if (chunk.eof || offset === bytes.byteLength) throw new Error('Incomplete model read')
  }
}

export function isDemoTaskId(id) {
  return demoTaskIds.includes(id)
}

export function readDemoTaskIds(content) {
  const text = content?.find((entry) => entry.type === 'text')?.text
  if (typeof text !== 'string') return []
  try {
    const ids = JSON.parse(text)
    return Array.isArray(ids) ? [...new Set(ids.filter(isDemoTaskId))] : []
  } catch {
    return []
  }
}

export function registerWorkspaceDemo(ctx) {
  ctx.tools.register({
    name: demoToolName,
    description: 'Show two simulated Tripo 3D tasks in this conversation. Only call when the user asks for the Tripo workspace demo. This uses a bundled sample and makes no generation or billing requests.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'array', items: { type: 'string' } },
      render: (_args, ids) => [{ type: 'text', text: JSON.stringify(ids) }],
    },
    async execute() {
      return [...demoTaskIds]
    },
  })
}
