import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerRetextureRemote } from '../plugin/retexture.js'
import { workspaceApprovalId } from '../plugin/workspace.js'

const sourceTaskId = '2121a32d-4b39-45c2-b54a-591bca03d317'
const childTaskId = 'af61d0ac-45bb-4b82-8acd-0d41732987ec'
const rigTaskId = '80a8c656-d1ff-4d9c-a7f3-e4182b3799dd'
const animationTaskId = '39075827-f365-4b05-bd7f-a9856a4b98c4'
const profile = 'studio'
const region = 'cn'
const model = 'v3.5-20260506'
const source = { sourceTaskId, region, profile, sourceSeq: 2 }
const prompt = 'Weathered copper with a blue patina'
const choose = (id, label) => ({ answers: [{ id, selected: [label] }] })
const approveQuestion = async ({ questions: [question] }) => choose(question.id, 'Submit Tripo task')

async function fixture(t, { approve = approveQuestion, output = { task_id: childTaskId } } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tripo-right-retexture-')))
  t.after(() => rm(home, { recursive: true }))
  const workdir = join(home, 'workspace')
  const modelPath = `tripo-task-${sourceTaskId.slice(0, 8)}-AbC123/source.glb`
  await mkdir(join(workdir, modelPath.split('/')[0]), { recursive: true })
  await writeFile(join(workdir, modelPath), 'glTF source')
  const sourceReceipt = { taskId: sourceTaskId, region, profile, status: 'success', modelPath }
  const events = [
    { type: 'tool/call', seq: 1, data: { name: 'tripo_task', callId: 'source-card' } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'source-card', isError: false,
      content: [{ type: 'text', text: JSON.stringify(sourceReceipt) }] } } },
  ]
  const sessionId = 'texture-owner'
  const session = { id: sessionId, seq: 3, header: { cwd: workdir, origin: 'user' },
    snapshotEvents(from = 0, until = 3) { return events.filter(event => event.seq >= from && event.seq < until) }, isOwnSeq: () => true }
  const agent = { session }
  const otherAgent = { session: { ...session, id: 'other', snapshotEvents: () => [] } }
  const signal = new AbortController().signal
  const calls = { approvals: [], plans: [], submissions: [], downloads: [], rigPlans: [], rigs: [], animationPlans: [], animations: [] }
  const identity = { region, profile, source: `profile:${profile}`, key: 'masked-original-account', balance: 100,
    api_base_url: 'https://example.invalid/' }
  const state = { childStatus: 'running', rigStatus: 'running', animationStatus: 'running' }

  function open() {
    let handler
    registerRetextureRemote({
      provide(key, value) { assert.equal(key, 'tripoTexture'); handler = value },
      typert: { register({ invocations }) { assert.deepEqual(invocations.map(method => method.method), ['quote', 'submit', 'versions', 'refresh']) } },
      effect() {},
      sessionController: { async resolveAgent(id) { return { agent: id === sessionId ? agent : otherAgent } } },
      shellEnv: { collect: () => ({ DSH_HOME: home }) },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workdir }) },
      workingDirectory: { get: () => workdir },
      userQuestions: { async ask(request) { calls.approvals.push(request); return await approve(request) } },
      shell: {
        resolve: spec => spec,
        async execute({ command }) {
          let data
          if (command.startsWith('tripo whoami ')) {
            data = identity
          } else if (command.startsWith('tripo task get ')) {
            const argv = command.split(' ')
            const id = argv[3]
            const rig = calls.rigs.at(-1)
            const tasks = {
              [sourceTaskId]: { status: 'success' },
              [childTaskId]: { status: state.childStatus },
              [rigTaskId]: { status: state.rigStatus, type: 'animate_rig', input: state.rigInput ?? { topology: rig?.bodyType, model: rig?.model } },
              [animationTaskId]: { status: state.animationStatus, type: 'animate_retarget' },
            }
            assert.ok(tasks[id])
            data = { task_id: id, ...tasks[id] }
            if (argv.includes('--download')) {
              assert.notEqual(id, sourceTaskId)
              assert.equal(data.status, 'success')
              const name = id === childTaskId ? 'retexture' : id === rigTaskId ? 'rigged' : 'animated'
              const path = `${argv[argv.indexOf('--out') + 1]}/${name}.glb`
              await writeFile(join(workdir, path), 'glTF texture')
              data.files = [path]
              calls.downloads.push(id)
            }
          } else {
            assert.match(command, /^node -e /)
            const args = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64url').toString())
            assert.deepEqual(args.slice(0, 3), ['--json', '--profile', profile])
            const rig = args.find(arg => arg.startsWith('rig:model='))
            const retarget = args.find(arg => arg.startsWith('retarget:animation='))
            if (retarget) {
              const [, preset] = /^retarget:animation=([^,]+),out_format=glb,export_with_geometry=true$/.exec(retarget)
              calls.animationPlans.push({ taskId: args.at(-1), preset })
              data = { valid: true, warnings: [], errors: [], steps: [{ endpoint: '/v3/animations/retarget', payload: {
                input: '<upstream>', animation: preset, out_format: 'glb', export_with_geometry: true,
              } }] }
            } else if (args[3] === 'anim' && args[4] === 'retarget') {
              calls.animations.push({ taskId: args.at(-1), preset: args[args.indexOf('--animation') + 1], format: args[args.indexOf('--out-format') + 1] })
              assert.ok(args.includes('--no-wait') && args.includes('export_with_geometry=true'))
              data = { task_id: animationTaskId }
            } else if (rig) {
              const [_, alias, bodyType] = /^rig:model=([^,]+),rig_type=([^,]+),out_format=glb$/.exec(rig)
              calls.rigPlans.push({ taskId: args.at(-1), bodyType, alias })
              const version = alias === 'v3.0' ? 'v3.0-20260909' : 'v2.5-20260210'
              data = { valid: true, warnings: [], errors: [], steps: [{ endpoint: '/v3/animations/rig', payload: {
                input: '<upstream>', model: version, rig_type: bodyType, out_format: 'glb',
              } }] }
            } else if (args[3] === 'anim' && args[4] === 'rig') {
              calls.rigs.push({ taskId: args.at(-1), bodyType: args[args.indexOf('--rig-type') + 1],
                model: args[args.indexOf('--model') + 1], format: args[args.indexOf('--out-format') + 1] })
              assert.ok(args.includes('--no-wait'))
              data = { task_id: rigTaskId }
            } else {
              assert.deepEqual(args.slice(3, 5), ['model', 'texture'])
              assert.deepEqual(args.slice(-2), ['--', sourceTaskId])
              const promptArg = args.find(arg => arg.startsWith('texture_prompt='))
              const text = JSON.parse(promptArg.slice('texture_prompt='.length)).text
              if (args.includes('--dry-run')) {
                calls.plans.push(text)
                data = { valid: true, warnings: [], errors: [], steps: [{ endpoint: '/v3/models/texture', payload: {
                  model, input: sourceTaskId, texture_quality: 'standard', pbr: false, texture_prompt: { text },
                } }] }
              } else {
                assert.equal(args[args.indexOf('--model') + 1], model)
                calls.submissions.push(text)
                data = output
              }
            }
          }
          return { async result() { return { exitCode: 0, stdout: { text: JSON.stringify(data), truncated: false } } } }
        },
      },
    })
    return {
      quote: (overrides = {}, id = sessionId) => handler.quote(id, { ...source, prompt, ...overrides }, signal),
      submit: (quoteId, owner = sessionId, cancellation = signal) => handler.submit(owner, quoteId, cancellation),
      versions: (selection = source) => handler.versions(sessionId, selection, signal),
      refresh: (selection = source) => handler.refresh(sessionId, selection, signal),
    }
  }
  return { ...open(), open, state, calls, identity, modelPath }
}

test('a right-sidebar texture quote uses one native approval and adds the result without replacing the source', async t => {
  const { quote, submit, versions, refresh, open, state, calls, modelPath } = await fixture(t)
  const estimate = await quote()
  assert.equal(estimate.sourceTaskId, sourceTaskId)
  assert.equal(estimate.estimatedCredits, 10)
  assert.equal(estimate.model, model)
  assert.doesNotMatch(JSON.stringify(estimate), /masked-original-account|example\.invalid/)
  assert.deepEqual(calls.plans, [prompt])
  assert.deepEqual(calls.submissions, [])
  assert.equal(calls.approvals.length, 0)
  assert.equal((await submit(estimate.quoteId, 'other')).status, 'expired')

  const result = await submit(estimate.quoteId)
  assert.deepEqual(result, { sourceTaskId, taskId: childTaskId, region, profile, status: 'queued' })
  assert.deepEqual(calls.submissions, [prompt])
  assert.equal(calls.approvals.length, 1)
  const [{ questions: [question] }] = calls.approvals
  assert.equal(question.id, `tripo-workspace-${estimate.quoteId}`)
  assert.equal(question.intent.kind, 'approval')
  assert.match(question.detail, /10 credits/)
  assert.ok(question.detail.includes(prompt) && question.detail.includes(sourceTaskId))
  assert.deepEqual(await submit(estimate.quoteId), result)
  assert.deepEqual(await open().submit(estimate.quoteId), result)

  const queued = await versions()
  assert.equal(queued.source.modelPath, modelPath)
  assert.deepEqual(queued.versions.map(({ taskId, status }) => [taskId, status]), [[childTaskId, 'queued']])
  const running = await refresh()
  assert.equal(running.versions[0].status, 'running')
  assert.deepEqual(calls.downloads, [])
  state.childStatus = 'success'
  const complete = await refresh({ ...source, targetTaskId: childTaskId })
  assert.equal(complete.source.modelPath, modelPath)
  assert.match(complete.versions[0].modelPath, /\/retexture\.glb$/)
  assert.equal((await open().versions({ sourceTaskId: childTaskId, region, profile })).versions[0].modelPath, complete.versions[0].modelPath)
  assert.deepEqual(calls.downloads, [childTaskId])
  assert.deepEqual(calls.submissions, [prompt])
})

test('a newer description, a concurrent duplicate, and a cancelled approval cannot charge', async t => {
  let asked
  let finish
  const held = new Promise(resolve => { asked = resolve })
  const choice = new Promise(resolve => { finish = resolve })
  const { quote, submit, calls, open } = await fixture(t, { approve: async ({ signal, questions: [question] }) => {
    asked()
    const label = await Promise.race([choice, new Promise(resolve => signal.addEventListener('abort', () => resolve('Cancel'), { once: true }))])
    return choose(question.id, label)
  } })
  const first = await quote()
  const initial = submit(first.quoteId)
  try {
    await Promise.race([held, initial.then(() => { throw new Error('Confirmation did not open') })])
    assert.equal((await submit(first.quoteId)).status, 'alreadyUsed')
    const replacement = await quote({ prompt: 'Green copper patina' })
    assert.equal((await initial).status, 'cancelled')
    assert.equal((await open().submit(first.quoteId)).status, 'cancelled')
    finish('Cancel')
    assert.equal((await submit(replacement.quoteId)).status, 'cancelled')
    assert.equal((await open().submit(replacement.quoteId)).status, 'cancelled')
    assert.deepEqual(calls.submissions, [])
  } finally {
    finish('Cancel')
  }
})

test('unknown submission outcomes are retained across a reload and never dispatched twice', async t => {
  const { quote, submit, open, calls } = await fixture(t, { output: {} })
  const { quoteId } = await quote()
  const result = await submit(quoteId)
  assert.equal(result.status, 'unknown')
  assert.equal(result.taskId, undefined)
  assert.deepEqual(await open().submit(quoteId), result)
  assert.deepEqual(calls.submissions, [prompt])
  assert.equal(calls.approvals.length, 1)
})

test('a foreign source, changed account, or restarted unhandled quote cannot submit', async t => {
  const { quote, submit, open, calls, identity } = await fixture(t)
  await assert.rejects(quote({}, 'other'))
  assert.deepEqual(calls.plans, [])
  const { quoteId } = await quote()
  assert.equal((await open().submit(quoteId)).status, 'expired')
  identity.key = 'masked-rebound-account'
  assert.equal((await submit(quoteId)).status, 'unavailable')
  assert.deepEqual(calls.submissions, [])
})

test('an approval that arrives after quote expiry cannot start a paid task', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const { quote, submit, open, calls } = await fixture(t, { approve: async request => {
    now += 10 * 60_000
    return await approveQuestion(request)
  } })
  const { quoteId } = await quote()
  const result = await submit(quoteId)
  assert.equal(result.status, 'expired')
  assert.deepEqual(await open().submit(quoteId), result)
  assert.equal(calls.approvals.length, 1)
  assert.deepEqual(calls.submissions, [])
})

test('rig approval uses the selected successful texture version, its exact body type and GLB export', async t => {
  const { quote, submit, refresh, open, calls, state } = await fixture(t)
  const textureQuote = await quote()
  await submit(textureQuote.quoteId)
  const selection = { operation: 'rig', sourceTaskId: childTaskId, sourceSeq: undefined, prompt: undefined, bodyType: 'avian' }
  await assert.rejects(quote(selection), /selected successful Tripo model/)
  assert.deepEqual(calls.rigPlans, [])

  state.childStatus = 'success'
  await refresh({ ...source, targetTaskId: childTaskId })
  await assert.rejects(quote({ ...selection, bodyType: 'unsupported' }), /supported rig body type/)
  const rigQuote = await quote(selection)
  assert.equal(rigQuote.operation, 'rig')
  assert.equal(rigQuote.sourceTaskId, childTaskId)
  assert.equal(rigQuote.bodyType, 'avian')
  assert.equal(rigQuote.estimatedCredits, 25)
  assert.deepEqual(calls.rigPlans, [{ taskId: childTaskId, bodyType: 'avian', alias: 'v2.5' }])
  assert.deepEqual(calls.rigs, [])
  assert.equal(calls.approvals.length, 1)

  const result = await submit(rigQuote.quoteId)
  assert.deepEqual(result, { sourceTaskId: childTaskId, taskId: rigTaskId, region, profile, status: 'queued', operation: 'rig', bodyType: 'avian' })
  assert.deepEqual(calls.rigs, [{ taskId: childTaskId, bodyType: 'avian', model: 'v2.5-20260210', format: 'glb' }])
  assert.equal(calls.approvals.length, 2)
  const detail = calls.approvals.at(-1).questions[0].detail
  assert.ok(detail.includes(childTaskId) && detail.includes('avian') && detail.includes('GLB') && detail.includes('25 credits'))
  assert.deepEqual(await open().submit(rigQuote.quoteId), result)
  const restored = await open().versions()
  const rig = restored.versions.find(version => version.taskId === rigTaskId)
  assert.equal(rig.sourceTaskId, sourceTaskId)
  assert.equal(rig.inputTaskId, childTaskId)
  assert.equal(rig.bodyType, 'avian')
  assert.equal(calls.rigs.length, 1)
})

test('rig and texture keep independent quotes for the same source', async t => {
  const { quote, submit, calls } = await fixture(t)
  const rig = { operation: 'rig', prompt: undefined, bodyType: 'biped' }
  const first = await quote(rig)
  const texture = await quote()
  const replacement = await quote({ ...rig, bodyType: 'others' })

  assert.equal((await submit(first.quoteId)).status, 'expired')
  assert.equal(calls.approvals.length, 0)
  assert.equal((await submit(texture.quoteId)).taskId, childTaskId)
  assert.equal((await submit(replacement.quoteId)).taskId, rigTaskId)
  const ids = calls.approvals.map(request => request.questions[0].id)
  assert.deepEqual(ids, [workspaceApprovalId(texture.quoteId), workspaceApprovalId(replacement.quoteId)])
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(calls.submissions, [prompt])
  assert.deepEqual(calls.rigs, [{ taskId: sourceTaskId, bodyType: 'others', model: 'v3.0-20260909', format: 'glb' }])
})

test('an approval answer for another quote cannot submit the current quote', async t => {
  let answerId
  const { quote, submit, calls } = await fixture(t, { approve: async () => choose(answerId, 'Submit Tripo task') })
  const first = await quote()
  const second = await quote({ prompt: 'Green bronze' })
  answerId = workspaceApprovalId(first.quoteId)

  assert.equal((await submit(second.quoteId)).status, 'cancelled')
  assert.equal(calls.approvals[0].questions[0].id, workspaceApprovalId(second.quoteId))
  assert.deepEqual(calls.submissions, [])
})

test('native approval dismissal resolves as cancellation while other native errors stay unavailable', async t => {
  let approvalError
  const { quote, submit, calls, open } = await fixture(t, { approve: async () => { throw approvalError } })
  const nativeError = (code, cause) => Object.assign(new Error('Native question did not finish', { cause }), { name: 'UserQuestionError', code })
  const dismissed = nativeError('ASK_CANCELLED', Object.assign(new Error('Remote question dismissed'), {
    name: 'UserQuestionError', code: 'ASK_CANCELLED',
  }))
  for (const [error, expectedStatus] of [
    [dismissed, 'cancelled'],
    [nativeError('ASK_TIMED_OUT'), 'unavailable'],
    [new Error('Connection closed', { cause: dismissed }), 'unavailable'],
    [Object.assign(new Error('ASK_CANCELLED'), { code: 'ASK_CANCELLED' }), 'unavailable'],
  ]) {
    approvalError = error
    const { quoteId } = await quote()
    const result = await submit(quoteId)
    assert.equal(result.status, expectedStatus)
    assert.deepEqual(await open().submit(quoteId), result)
  }
  assert.equal(calls.approvals.length, 4)
  assert.deepEqual(calls.submissions, [])
})

test('one compatible preset uses the selected rig, dedicated approval and persistent animated version', async t => {
  const { quote, submit, refresh, open, calls, state } = await fixture(t)
  const request = { operation: 'retarget', prompt: undefined, preset: 'preset:walk' }
  await assert.rejects(quote(request), /compatible preset for a rigged model/)
  const rig = await quote({ operation: 'rig', prompt: undefined, bodyType: 'biped' })
  await submit(rig.quoteId)
  const selected = { ...request, sourceTaskId: rigTaskId, sourceSeq: undefined }
  await assert.rejects(quote(selected), /selected successful Tripo model/)
  state.rigStatus = 'success'
  await refresh({ ...source, targetTaskId: rigTaskId })
  await assert.rejects(quote({ ...selected, preset: 'preset:quadruped:walk' }), /compatible preset for a rigged model/)

  for (const rigInput of [{ topology: 'quadruped' }, { topology: 'biped', model: 'v2.5-20260210' }]) {
    state.rigInput = rigInput
    await assert.rejects(quote(selected), /original compatible Tripo rig/)
  }
  state.rigInput = {}
  const animation = await quote(selected)
  assert.deepEqual(calls.animationPlans, [{ taskId: rigTaskId, preset: 'preset:walk' }])
  assert.equal(animation.operation, 'retarget')
  assert.equal(animation.sourceTaskId, rigTaskId)
  assert.equal(animation.estimatedCredits, 10)
  assert.equal(animation.model, 'v3.0-20260909')
  assert.deepEqual(calls.animations, [])

  const queued = await submit(animation.quoteId)
  assert.deepEqual(queued, { sourceTaskId: rigTaskId, taskId: animationTaskId, region, profile, status: 'queued', operation: 'retarget', preset: 'preset:walk' })
  const [question] = calls.approvals.at(-1).questions
  assert.equal(question.id, workspaceApprovalId(animation.quoteId))
  for (const detail of [rigTaskId, 'v3.0-20260909', 'preset:walk', '10 credits', 'GLB']) {
    assert.ok(question.detail.replaceAll('\\.', '.').includes(detail), `Missing approval detail: ${detail}`)
  }
  assert.deepEqual(await open().submit(animation.quoteId), queued)
  assert.deepEqual(calls.animations, [{ taskId: rigTaskId, preset: 'preset:walk', format: 'glb' }])

  state.animationStatus = 'success'
  await refresh({ ...source, targetTaskId: animationTaskId })
  const versions = await open().versions({ sourceTaskId: animationTaskId, region, profile })
  assert.equal(versions.source.taskId, sourceTaskId)
  const output = versions.versions.at(-1)
  assert.equal(output.inputTaskId, rigTaskId)
  assert.equal(output.operation, 'retarget')
  assert.equal(output.preset, 'preset:walk')
  assert.match(output.modelPath, /\/animated\.glb$/)
})
