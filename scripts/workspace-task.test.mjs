import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { recordSubmittedTask, registerTaskRecovery, registerTaskRecoveryRemote } from '../plugin/resume.js'
import { registerTaskTool } from '../plugin/task.js'
import { latestTaskReceipt, readAssetHistory, readTaskReceipt, readWorkspaceModel, workspaceGlbPath } from '../plugin/workspace.js'

const taskId = '2121a32d-4b39-45c2-b54a-591bca03d317'
const otherTaskId = '08ffa228-6636-4c15-ada2-1b814a150bf5'
const request = { taskId, region: 'cn', profile: 'studio' }
const identity = { region: 'cn', profile: 'studio', source: 'profile:studio', key: 'mock-sensitive-value' }

const fullReadTooLarge = { ok: false, error: { code: 'workspace-file/too-large' } }

test('assembles native byte windows only after the complete-file cap rejects the read', async () => {
  const chunks = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)]
  const offsets = []
  const signal = new AbortController().signal
  const result = await readWorkspaceModel(async (path, options, readSignal) => {
    assert.equal(path, 'result/model.glb')
    assert.equal(readSignal, signal)
    if (!options.range) return fullReadTooLarge
    const { offset } = options.range
    offsets.push(offset)
    return { ok: true, value: { data: chunks[offsets.length - 1], offset, bytes: 5, version: 'stable', eof: offset > 0 } }
  }, 'result/model.glb', signal)
  assert.deepEqual(offsets, [0, 3])
  assert.deepEqual(result.value.data, Uint8Array.of(1, 2, 3, 4, 5))
  assert.equal(result.value.version, 'stable')
})

test('only indexes saved Tripo downloads paired with their exact tool calls', () => {
  const modelPath = 'tripo-task-2121a32d-abc123/model.glb'
  const receipt = { ...request, modelPath, status: 'success' }
  const call = (seq, name) => ({ event: { seq, type: 'tool/call', data: { name, callId: String(seq) } } })
  const result = (seq, callId, value, isError = false) => ({
    event: { seq, time: seq, type: 'tool/result', data: {
      message: { toolCallId: String(callId), isError, content: [{ type: 'text', text: JSON.stringify(value) }] },
    } },
  })
  assert.deepEqual(readAssetHistory([
    call(1, 'another_plugin'), result(2, 1, receipt),
    call(3, 'tripo_task'), result(4, 3, receipt),
    call(5, 'tripo_batch'), result(6, 5, { tasks: [{ ...receipt, modelPath: '../secret.glb' }, receipt] }),
    call(7, 'tripo_task'), result(8, 7, receipt, true),
  ]), [{ ...receipt, seq: 6, time: 6 }])
})

test('GLB document addresses preserve paths and cannot switch the source session', () => {
  const address = 'dsh-resource://file/session/workspace//tmp/mesh%20one%23.GLb?line=2'
  assert.equal(workspaceGlbPath(address, 'workspace'), '/tmp/mesh one#.GLb')
  assert.equal(workspaceGlbPath(address, 'other'), null)
  assert.equal(workspaceGlbPath('dsh-resource://file/absolute/tmp/mesh.glb', 'workspace'), null)
  assert.equal(workspaceGlbPath('dsh-resource://file/session/workspace/foo%XX.glb', 'workspace'), null)
})

test('stops a byte-window read for excessive size, changed versions, or failed authorization', async () => {
  const signal = new AbortController().signal
  const denied = { ok: false, error: { code: 'gateway/access-denied' } }
  assert.equal(await readWorkspaceModel(async () => denied, 'result/model.glb', signal), denied)
  const segment = { data: Uint8Array.of(1), bytes: 2, version: 'a', offset: 0, eof: false }
  assert.equal(await readWorkspaceModel(async (_, options) => options.range
    ? { ok: true, value: { ...segment, bytes: 129 * 1024 * 1024 } } : fullReadTooLarge, 'result/model.glb', signal), fullReadTooLarge)
  await assert.rejects(readWorkspaceModel(async (_, options) => options.range
    ? { ok: true, value: options.range.offset === 0 ? segment : { ...segment, offset: 1, version: 'b', eof: true } }
    : fullReadTooLarge, 'result/model.glb', signal), /Model changed while being read/)
})

test('replays task cards in event order and uses the path from a later download', () => {
  const queued = { ...request, seq: 20, status: 'queued' }
  const first = { ...request, seq: 30, status: 'success', modelPath: 'first.glb' }
  const retry = { ...first, seq: 40, modelPath: 'retry.glb' }
  const statusOnly = { ...request, seq: 45, status: 'success' }
  assert.equal(latestTaskReceipt(first, queued), first)
  assert.equal(latestTaskReceipt(first, retry), retry)
  assert.deepEqual(latestTaskReceipt(retry, statusOnly), { ...statusOnly, modelPath: 'retry.glb' })
  const otherAccount = { ...statusOnly, profile: 'other' }
  assert.equal(latestTaskReceipt(retry, otherAccount), otherAccount)
})

test('merges automatic updates without dropping a downloaded file on replay or lookup failure', () => {
  const queued = { ...request, seq: 20, status: 'queued' }
  const running = { ...queued, status: 'running', progress: 50 }
  const complete = { ...queued, status: 'success', progress: 100 }
  const download = { ...complete, modelPath: 'tripo-task-2121a32d-abc123/model.glb' }
  const failure = { ...request, seq: 25, status: 'unknown', errorCode: 'accountMismatch' }
  assert.equal(latestTaskReceipt(queued, running, true), running)
  assert.equal(latestTaskReceipt(running, { ...running }, true), running)
  assert.equal(latestTaskReceipt(running, { ...complete, seq: 19 }, true), running)
  assert.equal(latestTaskReceipt(running, { ...complete, profile: 'other' }, true), running)
  assert.equal(latestTaskReceipt(complete, download), download)
  assert.equal(latestTaskReceipt(download, { ...complete }, true), download)
  assert.deepEqual(latestTaskReceipt(download, { ...queued, seq: 24 }), { ...download, seq: 24 })
  assert.deepEqual(latestTaskReceipt({ ...queued, seq: 24 }, download), { ...download, seq: 24 })
  assert.deepEqual(latestTaskReceipt({ ...complete, seq: 24 }, download), { ...download, seq: 24 })
  assert.deepEqual(latestTaskReceipt({ ...complete, seq: 24 }, { ...download, modelPath: '../bad.glb' }), { ...complete, seq: 24 })
  assert.deepEqual(latestTaskReceipt(download, failure), { ...failure, status: 'success', modelPath: download.modelPath })
  assert.deepEqual(latestTaskReceipt(failure, download), { ...download, seq: 25, errorCode: failure.errorCode })
  for (const status of ['failed', 'cancelled']) {
    const terminal = { ...request, seq: 20, status }
    assert.deepEqual(latestTaskReceipt(terminal, { ...running, seq: 24 }), { ...terminal, seq: 24 })
    assert.deepEqual(latestTaskReceipt({ ...running, seq: 24 }, terminal), { ...terminal, seq: 24 })
  }
})

async function harness(t, replies, mode = 'workspace-write', switchedRoot) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tripo-dsh-test-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const calls = []
  const session = { id: 'owned-session', header: { cwd: root } }
  const policy = { mode, workspaceRoot: switchedRoot?.policyRoot ?? root }
  const abort = new AbortController()
  const exec = { agent: { session }, signal: abort.signal }
  let tool
  registerTaskTool({
    tools: { register(value) { tool = value } },
    sandboxPolicy: { resolve({ session: owner }) { assert.equal(owner, session); return policy } },
    workingDirectory: { get(owner) { assert.equal(owner, session); return switchedRoot?.currentRoot ?? root } },
    shellEnv: { collect(value) { assert.equal(value, exec); return { DSH_SESSION_ID: session.id } } },
    shell: {
      resolve(spec) { return spec },
      async execute(spec) {
        assert.equal(spec.workdir, root)
        assert.equal(spec.signal, abort.signal)
        assert.equal(spec.sandboxPolicy, policy)
        assert.equal(spec.dshEnv.DSH_SESSION_ID, session.id)
        assert.match(spec.command, /^tripo (whoami|task get) /)
        calls.push(spec.command)
        const reply = replies[calls.length - 1]
        return { async result() { return typeof reply === 'function' ? await reply(spec.command, root) : reply } }
      },
    },
  })
  return { root, tool, exec, abort, calls }
}

function reply(data, exitCode = 0) {
  return { exitCode, stdout: { text: JSON.stringify(data), truncated: false } }
}

test('advertises identifiers and progress using DSH 0.2.2-rc.5 schema types', async t => {
  const { tool } = await harness(t, [])
  assert.deepEqual(tool.parameters.properties.taskId, { type: 'string' })
  assert.deepEqual(tool.output.schema.properties.profile, { type: 'string' })
  assert.deepEqual(tool.output.schema.properties.progress, { type: 'number' })
})

test('queries explicit task status using the original CLI profile and returns a replayable receipt', async t => {
  const { tool, exec, calls, root } = await harness(t, [reply(identity), reply({
    task_id: taskId,
    status: 'running',
    progress: 24,
    output: { model: 'https://example.org/asset.glb?token=mock-private' },
  })])
  const value = await tool.execute({ ...request, download: true }, exec)
  assert.deepEqual(calls, ['tripo whoami --json --profile studio', `tripo task get ${taskId} --json --profile studio`])
  assert.deepEqual(value, { ...request, status: 'running', progress: 24 })
  assert.deepEqual(readTaskReceipt(tool.output.render(request, value)), value)
  assert.deepEqual(await readdir(root), [])
})

test('rejects CLI options, aliases and relative paths instead of querying them', async t => {
  const { tool, exec, calls } = await harness(t, [])
  for (const value of ['@last', '--download', '../model.glb', `${taskId}\n`]) {
    await assert.rejects(tool.execute({ ...request, taskId: value }, exec), /explicit Tripo task UUID/)
  }
  await assert.rejects(tool.execute({ ...request, profile: '../studio' }, exec), /explicit Tripo task UUID/)
  await assert.rejects(tool.execute({ ...request, profile: 'studio\n' }, exec), /explicit Tripo task UUID/)
  assert.deepEqual(calls, [])
})

test('refuses region changes and environment credentials overriding an explicit profile', async t => {
  for (const actual of [{ ...identity, region: 'ov' }, { ...identity, source: 'env:TRIPO_API_KEY' }]) {
    const { tool, exec, calls } = await harness(t, [reply(actual)])
    const value = await tool.execute(request, exec)
    assert.equal(value.status, 'unknown')
    assert.equal(value.errorCode, 'accountMismatch')
    assert.equal(calls.length, 1)
  }
})

test('maps account/task lookup failure without copying raw CLI messages', async t => {
  for (const [lookup, errorCode] of [
    [reply({ exit_code: 8, error: 'private upstream error' }, 8), 'taskNotFound'],
    [reply({ task_id: otherTaskId, status: 'success' }), 'invalidOutput'],
  ]) {
    const { tool, exec } = await harness(t, [reply(identity), lookup])
    const value = await tool.execute(request, exec)
    assert.equal(value.taskId, taskId)
    assert.equal(value.status, 'unknown')
    assert.equal(value.errorCode, errorCode)
    assert.doesNotMatch(value.error, /private upstream error/)
  }
})

test('downloads only a successful task and returns a workspace-relative GLB in the fresh directory', async t => {
  const { tool, exec, calls, root } = await harness(t, [reply(identity), reply({ task_id: taskId, status: 'success' }), async (command, cwd) => {
    const directory = command.match(/--out (tripo-task-[A-Za-z0-9-]+) --json/)[1]
    const modelPath = `${directory}/model.glb`
    await writeFile(join(cwd, modelPath), 'GLB fixture')
    return reply({ task_id: taskId, status: 'success', files: [modelPath, `${directory}/preview.png`] })
  }])
  const value = await tool.execute({ ...request, download: true }, exec)
  assert.equal(value.status, 'success')
  assert.equal(value.modelPath, `${(await readdir(root))[0]}/model.glb`)
  assert.deepEqual(readTaskReceipt(tool.output.render(request, value)), value)
  assert.match(calls[2], new RegExp(`^tripo task get ${taskId} --download --out tripo-task-`))
})

test('never publishes a symlink, traversal path or a download for another task', async t => {
  for (const unsafe of ['symlink', 'traversal', 'other-task']) {
    const { tool, exec } = await harness(t, [reply(identity), reply({ task_id: taskId, status: 'success' }), async (command, cwd) => {
      const directory = command.match(/--out (tripo-task-[A-Za-z0-9-]+) --json/)[1]
      const modelPath = `${directory}/model.glb`
      if (unsafe === 'symlink') {
        await writeFile(join(cwd, 'other.glb'), 'unrelated file')
        await symlink(join(cwd, 'other.glb'), join(cwd, modelPath), 'file')
      }
      return reply({
        task_id: unsafe === 'other-task' ? otherTaskId : taskId,
        status: 'success',
        files: [unsafe === 'traversal' ? `${directory}/../other.glb` : modelPath],
      })
    }])
    const value = await tool.execute({ ...request, download: true }, exec)
    assert.equal(value.status, 'success')
    assert.equal(value.errorCode, 'invalidOutput')
    assert.equal(value.modelPath, undefined)
  }
})

test('honors read-only mode without writing files or invoking the download', async t => {
  const { tool, exec, calls, root } = await harness(t, [reply(identity), reply({ task_id: taskId, status: 'success' })], 'read-only')
  const value = await tool.execute({ ...request, download: true }, exec)
  assert.equal(value.status, 'success')
  assert.equal(value.errorCode, 'downloadFailed')
  assert.equal(calls.length, 2)
  assert.deepEqual(await readdir(root), [])
})

test('does not write to the original header cwd when the effective workspace has changed', async t => {
  const alternate = await realpath(await mkdtemp(join(tmpdir(), 'tripo-dsh-root-')))
  t.after(() => rm(alternate, { force: true, recursive: true }))
  for (const options of [{ policyRoot: alternate }, { currentRoot: alternate }]) {
    const { tool, exec, calls, root } = await harness(t, [reply(identity), reply({ task_id: taskId, status: 'success' })], 'workspace-write', options)
    const value = await tool.execute({ ...request, download: true }, exec)
    assert.equal(value.status, 'success')
    assert.equal(value.errorCode, 'downloadFailed')
    assert.equal(calls.length, 2)
    assert.deepEqual(await readdir(root), [])
    assert.deepEqual(await readdir(alternate), [])
  }
})

test('removes a failed attempt’s empty directory without changing the task ID or status', async t => {
  const { tool, exec, root } = await harness(t, [reply(identity), reply({ task_id: taskId, status: 'success' }), reply({}, 7)])
  const value = await tool.execute({ ...request, download: true }, exec)
  assert.equal(value.taskId, taskId)
  assert.equal(value.status, 'success')
  assert.equal(value.errorCode, 'downloadFailed')
  assert.deepEqual(await readdir(root), [])
})

test('propagates cancellation before running CLI commands', async t => {
  const { tool, exec, calls, abort } = await harness(t, [])
  abort.abort()
  await assert.rejects(tool.execute(request, exec), { name: 'AbortError' })
  assert.deepEqual(calls, [])
})

const account = { marker: identity.key, base: 'https://example.org' }

async function recoveryHarness(t, replies, events = [], firstOwnedSeq = 0) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tripo-dsh-recovery-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const calls = []
  const hooks = new Map()
  const disposers = []
  const dshEnv = { DSH_HOME: root }
  const newAgent = (id = 'owned-session') => ({ session: {
    id, header: { cwd: root }, get seq() { return events.length },
    isOwnSeq: seq => seq >= firstOwnedSeq, snapshotEvents: from => events.slice(from),
  } })
  const ctx = {
    on(name, handler) { hooks.set(name, handler) },
    effect(effect) { disposers.push(effect()) },
    shellEnv: { collect() { return dshEnv } },
    sandboxPolicy: { resolve() { return { mode: 'read-only', workspaceRoot: root } } },
    shell: { resolve: value => value, async execute(spec) {
      assert.equal(spec.workdir, root)
      assert.equal(spec.sandboxPolicy.mode, 'read-only')
      assert.match(spec.command, /^tripo (whoami|task get) /)
      assert.doesNotMatch(spec.command, /--download/)
      calls.push(spec.command)
      const next = replies.shift()
      return { result: async () => typeof next === 'function' ? await next(spec) : next }
    } },
  }
  const recovery = registerTaskRecovery(ctx, { intervalMs: 4, maxAttempts: 3, maxDurationMs: 1_000 })
  t.after(() => disposers.forEach(dispose => dispose()))
  return { root, dshEnv, newAgent, ctx, calls, hooks, recovery }
}

async function waitForTaskRecovery(recovery, agent) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = recovery.start(agent)
    if (!snapshot.polling) return snapshot.tasks
    await delay(5)
  }
  assert.fail('Tripo recovery did not stop')
}

function historyReceipt(events, name, value) {
  const callId = `call-${events.length}`
  events.push({ type: 'tool/call', seq: events.length, data: { name, callId } })
  events.push({ type: 'tool/result', seq: events.length, data: {
    message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(value) }] },
  } })
}

test('resumes against the original account once and persists the terminal receipt across a second restart', async t => {
  const events = []
  historyReceipt(events, 'tripo_batch_submit', { tasks: [{ ...request, status: 'queued' }] })
  const whoami = reply({ ...identity, api_base_url: account.base })
  const { root, dshEnv, newAgent, calls, hooks, recovery, ctx } = await recoveryHarness(t, [
    whoami, reply({}, 7),
    whoami, reply({ task_id: taskId, status: 'running', progress: 60 }),
    whoami, reply({ task_id: taskId, status: 'success', progress: 100 }),
  ], events)
  const agent = newAgent()
  await recordSubmittedTask({ dshEnv, session: agent.session }, { ...request, status: 'queued' }, account)
  hooks.get('agent/created')({ agent, source: 'resume' })
  assert.equal(recovery.start(agent).polling, true)
  assert.equal(recovery.start(agent).polling, true)
  const expected = [{ ...request, status: 'success', progress: 100, seq: 1 }]
  assert.deepEqual(await waitForTaskRecovery(recovery, agent), expected)
  const hostCalls = [...calls]
  assert.deepEqual(hostCalls, Array(3).fill([
    'tripo whoami --json --profile studio', `tripo task get ${taskId} --json --profile studio`,
  ]).flat())
  const restarted = registerTaskRecovery(ctx)
  assert.deepEqual(await waitForTaskRecovery(restarted, newAgent()), expected)
  assert.deepEqual(await waitForTaskRecovery(restarted, newAgent('another-session')), [])
  assert.deepEqual(calls, hostCalls)
  const folder = join(root, 'tripo-task-recovery-v1')
  const [session] = await readdir(folder)
  const [file] = await readdir(join(folder, session))
  assert.doesNotMatch(await readFile(join(folder, session, file), 'utf8'), /mock-sensitive-value|https:\/\/example\.org/)
})

test('skips history-only tasks, preserves account separation and aborts a disposed session', async t => {
  const events = []
  historyReceipt(events, 'tripo_submit', { ...request, taskId: otherTaskId, status: 'queued' })
  let querySignal
  const { dshEnv, newAgent, calls, hooks, recovery } = await recoveryHarness(t, [
    reply({ ...identity, key: 'different-account', api_base_url: account.base }),
    ({ signal }) => {
      querySignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  ], events)
  const agent = newAgent()
  assert.deepEqual(await waitForTaskRecovery(recovery, agent), [])
  assert.deepEqual(calls, [])
  await recordSubmittedTask({ dshEnv, session: agent.session }, { ...request, status: 'queued' }, account)
  const resumed = newAgent()
  assert.deepEqual(await waitForTaskRecovery(recovery, resumed), [{ ...request, status: 'unknown', errorCode: 'accountMismatch' }])
  assert.deepEqual(calls, ['tripo whoami --json --profile studio'])
  const next = newAgent()
  assert.equal(recovery.start(next).polling, true)
  for (let attempt = 0; attempt < 100 && !querySignal; attempt++) await delay(4)
  assert.ok(querySignal)
  hooks.get('agent/disposed')({ agent: next })
  await waitForTaskRecovery(recovery, next)
  assert.equal(querySignal.aborted, true)
  assert.deepEqual(calls, Array(2).fill('tripo whoami --json --profile studio'))
})

test('the DSH recovery endpoint never resolves agents for unrelated sessions', async t => {
  const { ctx, recovery, newAgent, dshEnv, calls } = await recoveryHarness(t, [])
  const agent = newAgent()
  const lookups = []
  let handler
  let endpoint
  registerTaskRecoveryRemote({
    ...ctx,
    provide(_name, value) { handler = value },
    typert: { register({ invocations }) { [endpoint] = invocations } },
    sessionController: { async resolveAgent(id) { lookups.push(id); return { agent } } },
  }, recovery)
  const signal = new AbortController().signal
  assert.throws(() => endpoint.parameters[0].codec.create().parse(''), TypeError)
  assert.deepEqual(await handler.resume(agent.session.id, signal), { tasks: [], polling: false })
  assert.deepEqual(lookups, [])
  await recordSubmittedTask({ dshEnv, session: agent.session }, { ...request, status: 'queued' }, account)
  assert.equal((await handler.resume(agent.session.id, signal)).polling, true)
  assert.deepEqual(lookups, [agent.session.id])
  assert.equal((await waitForTaskRecovery(recovery, agent)).length, 1)
  assert.ok(calls.every(command => command === 'tripo whoami --json --profile studio'))
})
