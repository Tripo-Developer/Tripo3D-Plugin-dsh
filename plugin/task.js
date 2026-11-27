import { createHash } from 'node:crypto'
import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { isTaskId, isTaskModelPath, isTaskProfile, taskErrorCodes, taskRegions, taskStatuses, taskToolName } from './workspace.js'

const commandTimeoutMs = 120_000

function parseCommandOutput(output) {
  if (output.truncated) return undefined
  try {
    return JSON.parse(output.text)
  } catch {
    return undefined
  }
}

// Keep user-supplied text out of shell syntax. The relay passes an argv array to Tripo.
const relay = 'const a=JSON.parse(Buffer.from(process.argv[1],"base64url").toString("utf8"));const child=require("node:child_process").spawnSync("tripo",a,{stdio:"inherit"});process.exit(child.status??127)'

export async function runTripo(ctx, query, args, profile, literal = false) {
  query.signal.throwIfAborted()
  const flags = ['--json', ...(profile ? ['--profile', profile] : [])]
  const command = literal
    ? `node -e '${relay}' ${Buffer.from(JSON.stringify([...flags, ...args])).toString('base64url')}`
    : ['tripo', ...args, ...flags].join(' ')
  const spec = ctx.shell.resolve({
    command,
    signal: query.signal,
    workdir: query.root,
    sandboxPolicy: query.policy,
    dshEnv: query.dshEnv,
    env: { TRIPO_CLIENT_APP: 'deepseek', TRIPO_DISTRIBUTION_CHANNEL: 'deepseek_plugin' },
    timeoutMs: commandTimeoutMs,
    stdoutMaxBytes: 256 * 1024,
  })
  const result = await (await ctx.shell.execute(spec)).result()
  if (!literal) query.signal.throwIfAborted()
  return { result, data: parseCommandOutput(result.stdout) }
}

export function createTripoQuery(ctx, exec) {
  const session = exec.agent?.session
  if (!session) throw new Error('Open a DSH conversation to use Tripo.')
  const policy = ctx.sandboxPolicy.resolve({ session })
  // Native workspace file reads use the immutable session header, even after the agent changes cwd.
  const root = session.header.cwd ?? policy.workspaceRoot
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Open a local DSH workspace to use Tripo.')
  return { root, policy, session, signal: exec.signal, dshEnv: ctx.shellEnv.collect(exec) }
}

export function resolveTripoProfile(identity, region, profile) {
  if (identity?.region !== region) return null
  const actual = isTaskProfile(identity.profile) && identity.source === `profile:${identity.profile}` ? identity.profile : undefined
  if ((profile && profile !== actual) || (!actual && identity.source !== 'env:TRIPO_API_KEY')) return null
  return { ...(actual ? { profile: actual } : {}) }
}

export function tripoAccountFingerprint(marker, base) {
  if (typeof marker !== 'string' || !marker || typeof base !== 'string' || !base) return undefined
  return createHash('sha256').update(JSON.stringify([marker, base])).digest('hex')
}

function accountError({ result, data }, errorCode, error) {
  if (result.exitCode === 3 || data?.exit_code === 3 || data?.http_status === 401 || data?.http_status === 403) {
    return { errorCode: 'accountMismatch', error: 'Tripo could not use this account. Restore the original CLI credentials and retry the same task.' }
  }
  if (result.exitCode === 8 || data?.exit_code === 8 || data?.http_status === 404) {
    return { errorCode: 'taskNotFound', error: 'Tripo could not find this task. Check the original account, region, and task ID.' }
  }
  if (result.exitCode === 127) return { errorCode, error: 'Tripo CLI was not found. Check that tripo is installed and available in the DSH shell.' }
  return { errorCode, error }
}

async function downloadModel(ctx, query, receipt) {
  const failure = (errorCode, error) => ({ ...receipt, errorCode, error })
  let directory
  try {
    const policy = ctx.sandboxPolicy.resolve({ session: query.session })
    if (policy.mode !== 'workspace-write' && policy.mode !== 'danger-full-access') {
      return failure('downloadFailed', 'The session is read-only. Use a writable workspace to download this task.')
    }
    const [canonicalRoot, policyRoot, currentRoot] = await Promise.all([
      realpath(query.root),
      realpath(policy.workspaceRoot),
      realpath(ctx.workingDirectory.get(query.session)),
    ])
    if (policyRoot !== canonicalRoot || currentRoot !== canonicalRoot) {
      return failure('downloadFailed', 'The download needs the conversation’s original writable workspace. Switch back and retry this task ID.')
    }
    query.signal.throwIfAborted()
    // Each attempt gets an empty directory, so a retry cannot overwrite an older model or follow an existing file link.
    directory = await mkdtemp(join(canonicalRoot, `tripo-task-${receipt.taskId.slice(0, 8).toLowerCase()}-`))
    const directoryName = basename(directory)
    const run = await runTripo(ctx, { ...query, policy }, ['task', 'get', receipt.taskId, '--download', '--out', directoryName], receipt.profile)
    if (run.result.exitCode !== 0) {
      return { ...receipt, ...accountError(run, 'downloadFailed', 'The task succeeded, but the download failed. Retry downloading this task ID.') }
    }
    if (run.data?.task_id !== receipt.taskId || run.data?.status !== 'success') {
      return failure('invalidOutput', 'Tripo returned a different task or status during download. Query the original task again.')
    }
    const path = Array.isArray(run.data.files)
      ? run.data.files.find(file => typeof file === 'string' && /\.glb$/i.test(file))
      : undefined
    if (!path) return failure('invalidOutput', 'The task did not produce a GLB file. Check the task output format in Tripo.')
    const model = resolve(canonicalRoot, path)
    const modelPath = `${directoryName}/${basename(model)}`
    if (model !== join(directory, basename(model)) || !isTaskModelPath(modelPath, receipt.taskId)
      || !(await lstat(model)).isFile() || await realpath(model) !== model) {
      return failure('invalidOutput', 'The downloaded model is not an allowed workspace file. Retry downloading this task ID.')
    }
    query.signal.throwIfAborted()
    return { ...receipt, modelPath }
  } catch {
    query.signal.throwIfAborted()
    return failure('downloadFailed', 'The task succeeded, but its GLB could not be saved in this workspace. Retry downloading this task ID.')
  } finally {
    // Remove only the empty directory this call created, never a partial or completed download.
    if (directory !== undefined) await rmdir(directory).catch(() => {})
  }
}

export async function inspectTask(ctx, args, exec, accountFingerprint) {
  const { taskId, region, profile, download } = args
  if (!isTaskId(taskId) || !taskRegions.includes(region)
    || (profile !== undefined && !isTaskProfile(profile)) || (download !== undefined && typeof download !== 'boolean')) {
    throw new Error('Use an explicit Tripo task UUID, its cn or ov region, and the original CLI profile if applicable.')
  }
  const pending = { taskId, region, ...(profile ? { profile } : {}), status: 'unknown' }
  exec.signal.throwIfAborted()
  const session = exec.agent?.session
  if (!session) return { ...pending, errorCode: 'statusUnavailable', error: 'Open a DSH conversation to query this task.' }

  try {
    const query = createTripoQuery(ctx, exec)
    const account = await runTripo(ctx, query, ['whoami'], profile)
    if (account.result.exitCode !== 0) {
      return { ...pending, ...accountError(account, 'statusUnavailable', 'Could not verify the Tripo CLI account. Check tripo whoami in the DSH shell.') }
    }
    const identity = account.data
    if (!taskRegions.includes(identity?.region)) {
      return { ...pending, errorCode: 'statusUnavailable', error: 'Tripo CLI did not report a region. Check tripo whoami in the DSH shell.' }
    }
    if (identity.region !== region) {
      return { ...pending, errorCode: 'accountMismatch', error: 'The active Tripo region is different from this task. Restore its original region and retry.' }
    }
    const accountProfile = resolveTripoProfile(identity, region, profile)
    if (!accountProfile) {
      return { ...pending, errorCode: 'accountMismatch', error: 'The Tripo CLI is not using the original profile. Restore that profile and check for environment overrides.' }
    }
    if (accountFingerprint && (accountProfile.profile !== profile
      || tripoAccountFingerprint(identity.key, identity.api_base_url) !== accountFingerprint)) {
      return { ...pending, errorCode: 'accountMismatch', error: 'Restore the Tripo account that submitted this task.' }
    }
    const verified = { ...pending, ...accountProfile }
    const lookup = await runTripo(ctx, query, ['task', 'get', taskId], accountProfile.profile)
    if (lookup.result.exitCode !== 0) {
      return { ...verified, ...accountError(lookup, 'statusUnavailable', 'Could not query this task. Retry the same task ID.') }
    }
    const task = lookup.data
    if (task?.task_id !== taskId || !taskStatuses.includes(task.status)) {
      return { ...verified, errorCode: 'invalidOutput', error: 'Tripo returned an invalid response for this task. Query the original task again.' }
    }
    const receipt = { ...verified, status: task.status }
    if (Number.isFinite(task.progress) && task.progress >= 0 && task.progress <= 100) receipt.progress = task.progress
    return download && receipt.status === 'success' ? await downloadModel(ctx, query, receipt) : receipt
  } catch {
    exec.signal.throwIfAborted()
    return { ...pending, errorCode: 'statusUnavailable', error: 'Could not query this task from the DSH workspace. Retry the same task ID.' }
  }
}

export function registerTaskTool(ctx) {
  // DSH 0.2.2-rc.5 accepts basic JSON schema types but not regex or numeric bounds.
  // The executor validates identifiers and progress before rendering the receipt.
  const taskId = { type: 'string' }
  const region = { type: 'string', enum: taskRegions }
  const profile = { type: 'string' }
  ctx.tools.register({
    name: taskToolName,
    description: 'Read one existing Tripo task and optionally download its GLB into the current DSH workspace. Pass the exact UUID and original Tripo region and CLI profile. Use after an approved Tripo CLI submission or when the user requests recovery. Never creates, retries, or charges for a generation.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['taskId', 'region'],
      properties: { taskId, region, profile, download: { type: 'boolean' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['taskId', 'region', 'status'],
        properties: {
          taskId, region, profile,
          status: { type: 'string', enum: taskStatuses },
          progress: { type: 'number' },
          modelPath: { type: 'string' },
          error: { type: 'string' },
          errorCode: { type: 'string', enum: taskErrorCodes },
        },
      },
      render: (_args, receipt) => [{ type: 'text', text: JSON.stringify(receipt) }],
    },
    async execute(args, exec) {
      return await inspectTask(ctx, args, exec)
    },
  })
}
