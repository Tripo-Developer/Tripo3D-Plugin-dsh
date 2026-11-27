import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recordSubmittedTask } from '../plugin/resume.js'
import { createTripoQuery } from '../plugin/task.js'
import { findTextureSource, readTextureVersions, recordTextureVersion, recoverTextureSubmission } from '../plugin/versions.js'
import { rigBodyTypes, textureEndpoints } from '../plugin/workspace.js'

const sourceTaskId = '2121a32d-4b39-45c2-b54a-591bca03d317'
const childTaskId = '08ffa228-6636-4c15-ada2-1b814a150bf5'
const siblingTaskId = '0f809b25-bb3a-40c9-a3c4-c4cde00b500e'
const quoteId = '08a51206-41a7-46ac-a76d-2174aba5fcf6'
const selection = { sourceTaskId, region: 'cn', profile: 'studio' }
const original = { taskId: sourceTaskId, region: 'cn', profile: 'studio', status: 'success' }
const account = { marker: 'test-account-marker', base: 'https://example.org', profile: 'studio' }

function receiptEvents(events, value, tool = 'tripo_task') {
  const callId = `tool-${events.length}`
  events.push({ type: 'tool/call', seq: events.length, data: { name: tool, callId } })
  events.push({ type: 'tool/result', seq: events.length, data: { message: {
    source: { callId }, content: [{ type: 'text', text: JSON.stringify(value) }],
  } } })
  return events.length - 1
}

async function harness(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tripo-versions-test-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const home = join(root, 'dsh-home')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const events = []
  const calls = []
  const statuses = new Map()
  const current = { region: 'cn', profile: 'studio', key: account.marker, api_base_url: account.base }
  const newExec = (id = 'owned-session', log = events) => ({
    agent: { session: { id, header: { cwd: workspace }, seq: log.length,
      isOwnSeq: () => true, snapshotEvents: (start, end) => log.slice(start, end) } },
    signal: new AbortController().signal,
  })
  const ctx = {
    shellEnv: { collect: () => ({ DSH_HOME: home }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
    workingDirectory: { get: () => workspace },
    shell: { resolve: options => options, execute: async ({ command }) => {
      calls.push(command)
      assert.match(command, /^tripo (whoami|task get) /)
      assert.match(command, /--profile studio$/)
      const [,, verb, taskId] = command.split(' ')
      let payload
      if (verb === 'get') {
        assert.ok([sourceTaskId, childTaskId, siblingTaskId].includes(taskId))
        const status = statuses.get(taskId) ?? 'success'
        payload = { task_id: taskId, status, progress: status === 'success' ? 100 : 20 }
        if (command.includes('--download')) {
          assert.equal(status, 'success')
          const directory = command.match(/--out (tripo-task-[a-z0-9-]+) /i)[1]
          const path = `${directory}/model.glb`
          await writeFile(join(workspace, path), `different model bytes ${taskId}`)
          payload.files = [path]
        }
      } else {
        payload = { ...current, source: `profile:${current.profile}` }
      }
      return { result: async () => ({ exitCode: 0, stdout: { text: JSON.stringify(payload), truncated: false } }) }
    } },
  }
  return { ctx, events, calls, statuses, current, newExec, workspace, home }
}

test('recognizes older owned GLB tool receipts and recovers the same source from a child ID', async t => {
  const { ctx, events, calls, newExec, workspace, home } = await harness(t)
  const path = 'tripo-task-2121a32d-abc123/original.glb'
  await mkdir(join(workspace, 'tripo-task-2121a32d-abc123'))
  await writeFile(join(workspace, path), 'old model')
  const seq = receiptEvents(events, { ...original, modelPath: path })
  for (let offset = 0; offset < 600; offset++) events.push({ type: 'assistant/message', seq: events.length })
  const exec = newExec()
  const query = createTripoQuery(ctx, exec)
  const input = { ...selection, sourceSeq: seq }
  assert.equal(await findTextureSource(query, selection), undefined)
  assert.deepEqual(await findTextureSource(query, input), { ...original, modelPath: path, seq })
  await recordTextureVersion(query, { ...input, taskId: childTaskId, quoteId }, account)
  assert.deepEqual(await recoverTextureSubmission(query, quoteId), { ...selection, taskId: childTaskId, status: 'queued' })
  assert.equal(await recoverTextureSubmission(createTripoQuery(ctx, newExec('another-session')), quoteId), undefined)

  const restarted = newExec('owned-session', [])
  const expected = { source: { ...original, modelPath: path, seq },
    versions: [{ taskId: childTaskId, ...selection, status: 'queued' }] }
  assert.deepEqual(await readTextureVersions(ctx, restarted, {}), expected)
  assert.deepEqual(await readTextureVersions(ctx, restarted, { ...selection, sourceTaskId: childTaskId }), expected)
  for (const input of [{ ...selection, region: 'ov' }, { ...selection, profile: 'another' }]) {
    assert.deepEqual(await readTextureVersions(ctx, restarted, input), { versions: [] })
  }
  assert.deepEqual(await readTextureVersions(ctx, newExec('another-session', []), {}), { versions: [] })
  assert.deepEqual(calls, [])
  const directory = join(home, 'tripo-texture-versions-v1')
  const [file] = await readdir(directory)
  assert.doesNotMatch(await readFile(join(directory, file), 'utf8'), /test-account-marker|https:\/\/example\.org/)
})

test('registers parallel children without losing versions and restores both downloaded GLBs', async t => {
  const { ctx, events, calls, statuses, newExec, workspace } = await harness(t)
  receiptEvents(events, original)
  const exec = newExec()
  const query = createTripoQuery(ctx, exec)
  await Promise.all([
    recordTextureVersion(query, { ...selection, taskId: childTaskId, quoteId }, account),
    recordTextureVersion(query, { ...selection, taskId: siblingTaskId }, account),
  ])
  statuses.set(childTaskId, 'running')
  const pending = await readTextureVersions(ctx, exec, { ...selection, targetTaskId: childTaskId }, { refresh: true })
  assert.equal(pending.versions.length, 2)
  assert.equal(pending.versions.find(item => item.taskId === childTaskId).status, 'running')
  assert.ok(!pending.source.modelPath)
  assert.ok(!pending.versions.find(item => item.taskId === siblingTaskId).modelPath)
  assert.equal(calls.filter(command => command.includes('--download')).length, 0)

  statuses.set(childTaskId, 'success')
  const [withSource, complete] = await Promise.all([
    readTextureVersions(ctx, exec, { ...selection, targetTaskId: sourceTaskId }, { refresh: true }),
    readTextureVersions(ctx, exec, { ...selection, targetTaskId: childTaskId }, { refresh: true }),
  ])
  assert.equal(calls.filter(command => command.includes('--download')).length, 2)
  const child = complete.versions.find(item => item.taskId === childTaskId)
  for (const receipt of [withSource.source, child]) {
    assert.match(receipt.modelPath, /^tripo-task-[a-f0-9]{8}-/)
    assert.equal(await readFile(join(workspace, receipt.modelPath), 'utf8'), `different model bytes ${receipt.taskId}`)
  }
  assert.notEqual(withSource.source.modelPath, child.modelPath)
  assert.deepEqual(await readTextureVersions(ctx, newExec('owned-session', []), {}), complete)
  assert.equal(calls.filter(command => command.includes('--download')).length, 2)
})

test('an owned success receipt takes priority over a queued recovery record even before download', async t => {
  const { ctx, events, calls, newExec } = await harness(t)
  const seq = receiptEvents(events, original)
  const exec = newExec()
  const query = createTripoQuery(ctx, exec)
  await recordSubmittedTask(query, { ...original, status: 'queued' }, account)
  assert.deepEqual(await readTextureVersions(ctx, exec, selection), { source: { ...original, seq }, versions: [] })
  const refreshed = await readTextureVersions(ctx, exec, { ...selection, targetTaskId: sourceTaskId }, { refresh: true })
  assert.equal(refreshed.source.status, 'success')
  assert.equal(refreshed.source.seq, seq)
  assert.ok(refreshed.source.modelPath)
  assert.equal(calls.filter(command => command.includes('--download')).length, 1)
})

test('uses the selected texture result for rigging and keeps all versions after reopening the session', async t => {
  const { ctx, events, calls, newExec, workspace } = await harness(t)
  const alternateTextureTaskId = '34471658-93a4-4f10-899c-93db057d767c'
  receiptEvents(events, original)
  const query = createTripoQuery(ctx, newExec())
  const selected = { ...selection, sourceTaskId: childTaskId }
  await recordTextureVersion(query, { ...selection, taskId: childTaskId }, account)
  assert.equal((await findTextureSource(query, selected)).taskId, sourceTaskId)
  assert.equal((await findTextureSource(query, selected, { exact: true })).status, 'queued')

  const directory = 'tripo-task-08ffa228-abc123'
  const modelPath = `${directory}/texture.glb`
  await mkdir(join(workspace, directory))
  await writeFile(join(workspace, modelPath), 'the selected texturing result')
  const version = { ...original, taskId: childTaskId, modelPath }
  receiptEvents(events, version)
  const rigQuery = createTripoQuery(ctx, newExec())
  const chosen = await findTextureSource(rigQuery, selected, { exact: true })
  assert.equal(chosen.taskId, childTaskId)
  assert.equal(chosen.status, 'success')
  assert.equal(chosen.modelPath, modelPath)
  assert.match(chosen.accountFingerprint, /^[a-f0-9]{64}$/)

  await Promise.all([
    recordTextureVersion(rigQuery, { ...selected, taskId: siblingTaskId, operation: 'rig', bodyType: 'avian', quoteId }, account),
    recordTextureVersion(rigQuery, { ...selection, taskId: alternateTextureTaskId }, account),
  ])
  assert.deepEqual(await recoverTextureSubmission(rigQuery, quoteId), {
    ...selected, taskId: siblingTaskId, status: 'queued', operation: 'rig', bodyType: 'avian',
  })
  const reopened = newExec('owned-session', [])
  const { source, versions } = await readTextureVersions(ctx, reopened, { ...selection, sourceTaskId: siblingTaskId })
  assert.equal(source.taskId, sourceTaskId)
  assert.equal(source.modelPath, undefined)
  assert.deepEqual(versions.find(v => v.taskId === childTaskId), { ...version, sourceTaskId, seq: chosen.seq })
  assert.deepEqual(versions.find(v => v.taskId === siblingTaskId), {
    ...selection, taskId: siblingTaskId, status: 'queued', operation: 'rig', bodyType: 'avian', inputTaskId: childTaskId,
  })
  assert.deepEqual(versions.find(v => v.taskId === alternateTextureTaskId), { ...selection, taskId: alternateTextureTaskId, status: 'queued' })
  assert.equal((await findTextureSource(createTripoQuery(ctx, reopened), selected, { exact: true })).modelPath, modelPath)

  const refreshed = await readTextureVersions(ctx, reopened, { ...selection, targetTaskId: siblingTaskId }, { refresh: true })
  const rigged = refreshed.versions.find(v => v.taskId === siblingTaskId)
  assert.equal(rigged.inputTaskId, childTaskId)
  assert.equal(rigged.status, 'success')
  assert.notEqual(rigged.modelPath, modelPath)
  assert.ok(calls.filter(command => command.includes('task get')).every(command => command.includes(siblingTaskId)))
})

test('does not trust foreign, symlinked or reassigned sources', async t => {
  const { ctx, events, calls, newExec, current, workspace } = await harness(t)
  const basename = 'tripo-task-2121a32d-abc123'
  const modelPath = `${basename}/model.glb`
  await mkdir(join(workspace, basename))
  await writeFile(join(workspace, 'different.glb'), 'test')
  await symlink(join(workspace, 'different.glb'), join(workspace, modelPath))
  receiptEvents(events, { ...original, modelPath }, 'unrelated_tool')
  assert.equal(await findTextureSource(createTripoQuery(ctx, newExec()), selection), undefined)
  receiptEvents(events, { ...original, modelPath })
  const exec = newExec()
  const query = createTripoQuery(ctx, exec)
  assert.equal((await findTextureSource(query, selection)).modelPath, undefined)
  await recordTextureVersion(query, { ...selection, taskId: childTaskId, quoteId }, account)
  current.key = 'changed-account'
  await assert.rejects(recordTextureVersion(query, { ...selection, taskId: siblingTaskId }, { ...account, marker: current.key }), /account changed/i)
  const result = await readTextureVersions(ctx, exec, { ...selection, targetTaskId: childTaskId }, { refresh: true })
  assert.equal(result.versions[0].errorCode, 'accountMismatch')
  assert.deepEqual(calls, ['tripo whoami --json --profile studio'])
  await assert.rejects(readTextureVersions(ctx, exec, { ...selection, targetTaskId: siblingTaskId }, { refresh: true }), /does not belong/)
  assert.equal(calls.length, 1)
})

test('registers strict typed input without a way to supply a local model path', () => {
  const parse = (method, value) => textureEndpoints.find(item => item.method === method).parameters[1].codec.create().parse(value)
  assert.deepEqual(parse('versions', {}), {})
  assert.deepEqual(parse('refresh', { ...selection, targetTaskId: childTaskId }), { ...selection, targetTaskId: childTaskId })
  assert.equal(parse('submit', quoteId), quoteId)
  assert.throws(() => parse('quote', { ...selection, prompt: 'linen fabric', modelPath: '../secret.glb' }), TypeError)
  assert.throws(() => parse('quote', { ...selection, prompt: '' }), TypeError)
  assert.throws(() => parse('versions', { ...selection, targetTaskId: childTaskId }), TypeError)
  assert.throws(() => parse('refresh', { ...selection, profile: '../other' }), TypeError)
})

test('validates the rig and texture shapes independently while leaving the previous texture contract valid', () => {
  const quote = textureEndpoints.find(item => item.method === 'quote')
  const parseInput = quote.parameters[1].codec.create().parse
  const parseOutput = quote.result.create().parse
  const pricing = { quoteId, model: 'v2.5', pricing: 'Tripo API list price', estimatedCredits: 25, expiresAt: 1000 }
  const texture = { ...selection, prompt: 'glazed porcelain' }
  assert.deepEqual(parseInput(texture), texture)
  assert.deepEqual(parseOutput({ ...texture, ...pricing }), { ...texture, ...pricing })
  assert.equal(rigBodyTypes.length, 8)
  for (const bodyType of rigBodyTypes) {
    const rig = { ...selection, operation: 'rig', bodyType }
    assert.deepEqual(parseInput(rig), rig)
    assert.deepEqual(parseOutput({ ...rig, ...pricing }), { ...rig, ...pricing })
    assert.throws(() => parseInput({ ...rig, prompt: 'a texture description' }), TypeError)
  }
  assert.throws(() => parseInput({ ...selection, operation: 'rig', bodyType: 'spider' }), TypeError)
  assert.throws(() => parseOutput({ ...selection, ...pricing, operation: 'rig' }), TypeError)
  assert.throws(() => parseInput({ ...texture, bodyType: 'biped' }), TypeError)
})

test('movement quotes only accept one supported preset and retain the source rig on the wire', () => {
  const [quote, submit, versions] = textureEndpoints
  const parseInput = quote.parameters[1].codec.create().parse
  const parseReceipt = submit.result.create().parse
  const parseVersions = versions.result.create().parse
  const request = { ...selection, sourceTaskId: childTaskId, operation: 'retarget', preset: 'preset:quadruped:walk' }
  assert.deepEqual(parseInput(request), request)
  for (const options of [{ preset: ['preset:walk', 'preset:run'] }, { preset: 'preset:biped:walk' }, { bodyType: 'quadruped' }, { prompt: 'Walk fast' }]) {
    assert.throws(() => parseInput({ ...request, ...options }), TypeError)
  }
  const queued = { ...request, taskId: siblingTaskId, status: 'queued' }
  assert.deepEqual(parseReceipt(queued), queued)
  const version = { ...queued, sourceTaskId: selection.sourceTaskId, inputTaskId: childTaskId }
  const group = { source: original, versions: [version] }
  assert.deepEqual(parseVersions(group), group)
  assert.throws(() => parseVersions({ ...group, versions: [{ ...version, inputTaskId: undefined }] }), TypeError)
})
