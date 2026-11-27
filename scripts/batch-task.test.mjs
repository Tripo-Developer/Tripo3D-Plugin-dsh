import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerBatchTool } from '../plugin/batch.js'
import { registerPaidTools } from '../plugin/paid.js'

const ready = '2111a32d-4b39-45c2-b54a-591bca03d317'
const missing = '2121a32d-4b39-45c2-b54a-591bca03d317'
const running = '2131a32d-4b39-45c2-b54a-591bca03d317'

function fixture({ abortOnLookup = false } = {}) {
  const region = 'cn'
  const profile = 'studio'
  const workspaceRoot = tmpdir()
  const controller = new AbortController()
  const exec = { signal: controller.signal, agent: { session: { header: { cwd: workspaceRoot } } } }
  const calls = []
  let tool
  registerBatchTool({
    tools: { register(value) { tool = value } },
    sandboxPolicy: { resolve: () => ({ workspaceRoot, mode: 'workspace-write' }) },
    shellEnv: { collect: () => ({}) },
    shell: {
      resolve(spec) { return spec },
      async execute({ command, signal }) {
        assert.equal(signal, controller.signal)
        calls.push(command)
        assert.match(command, /^tripo (?:whoami|task get) /)
        const id = command.split(' ')[3]
        const data = command.startsWith('tripo whoami')
          ? { region, source: `profile:${profile}`, profile }
          : { task_id: id, status: id === ready ? 'success' : 'running' }
        const exitCode = id === missing ? 8 : 0
        if (abortOnLookup && command.startsWith('tripo task get')) controller.abort()
        return { async result() { return { exitCode, stdout: { text: JSON.stringify(data), truncated: false } } } }
      },
    },
  })
  return { calls, tool, run: args => tool.execute({ region, profile, ...args }, exec) }
}

test('reads each unique ID in order and preserves later results after an individual failure', async () => {
  const { calls, tool, run } = fixture()
  const receipt = await run({ taskIds: [running, running.toUpperCase(), missing, ready] })
  assert.deepEqual(receipt.tasks.map(task => [task.taskId, task.status, task.errorCode]), [
    [running, 'running', undefined], [missing, 'unknown', 'taskNotFound'], [ready, 'success', undefined],
  ])
  assert.deepEqual(calls.filter(call => call.startsWith('tripo task get')).map(call => call.split(' ')[3]), [running, missing, ready])
  assert.deepEqual(JSON.parse(tool.output.render({}, receipt)[0].text), receipt)
})

test('rejects an invalid or out-of-range batch before any CLI invocation', async () => {
  const { calls, run } = fixture()
  for (const taskIds of [[], [ready, '@last'], Array(9).fill(ready)]) {
    await assert.rejects(run({ taskIds }), /Use 1 to 8 explicit Tripo task UUIDs/)
  }
  assert.deepEqual(calls, [])
})

test('cancellation prevents subsequent tasks from being dispatched', async () => {
  const { calls, run } = fixture({ abortOnLookup: true })
  await assert.rejects(run({ taskIds: [ready, running] }), { name: 'AbortError' })
  assert.equal(calls.length, 2)
  assert.match(calls[1], new RegExp(ready))
})

const prompts = ['A carved arch', 'A clay pot', 'A brass lantern']
const paidModel = 'v3.1-20260211'
const batchAnswer = label => ({ answers: [{ id: 'tripo-batch-submit', selected: [label] }] })

async function generationFixture(t, { ask = async () => batchAnswer('Submit Tripo batch'), submit } = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), 'tripo-batch-test-'))
  t.after(() => rm(dshHome, { recursive: true }))
  const calls = { plans: [], submissions: [], approvals: [] }
  const identity = { region: 'cn', profile: 'studio', source: 'profile:studio',
    key: 'masked-account', balance: 100, api_base_url: 'https://example.invalid/' }
  const session = { id: 'batch-test', header: { cwd: dshHome, origin: 'user' } }
  const controller = new AbortController()
  const exec = { agent: { session }, signal: controller.signal }
  function loadTools() {
    const tools = new Map()
    registerPaidTools({
      tools: { register(tool) { tools.set(tool.name, tool) } },
      sandboxPolicy: { resolve: () => ({ workspaceRoot: dshHome, mode: 'workspace-write' }) },
      shellEnv: { collect: () => ({ DSH_HOME: dshHome }) },
      userQuestions: { async ask(request) { calls.approvals.push(request.questions[0]); return await ask(request) } },
      shell: {
        resolve: spec => spec,
        async execute({ command }) {
          let data
          if (command.startsWith('tripo whoami ')) {
            data = identity
          } else {
            const args = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64url').toString())
            const prompt = args.at(-1)
            assert.equal(args.at(-2), '--')
            if (args.includes('--dry-run')) {
              calls.plans.push(prompt)
              data = { valid: true, generation_credits_estimate: 10, warnings: [], errors: [], steps: [
                { endpoint: '/v3/generation/text-to-model', payload: { prompt, model: paidModel, texture: false, pbr: false } },
              ] }
            } else {
              assert.equal(args[args.indexOf('--model') + 1], paidModel)
              calls.submissions.push(prompt)
              data = submit ? await submit(prompt, identity) : { task_id: ready }
            }
          }
          return { async result() { return { exitCode: 0, stdout: { text: JSON.stringify(data), truncated: false } } } }
        },
      },
    })
    return {
      estimate: (input = prompts) => tools.get('tripo_batch_estimate').execute({ prompts: input, region: 'cn', profile: 'studio', texture: false }, exec),
      submit: (batchId, options = exec) => tools.get('tripo_batch_submit').execute({ batchId }, options),
    }
  }
  return { ...loadTools(), loadTools, exec, calls, controller }
}

test('a batch gets one native approval, keeps ordered results after an unknown submission, and reopens without new charges', async t => {
  const { estimate, submit, loadTools, calls } = await generationFixture(t, { submit: async prompt => {
    if (prompt === prompts[1]) return {}
    return { task_id: prompt === prompts[0] ? ready : running }
  } })
  const quote = await estimate()
  assert.equal(quote.estimatedCredits, 30)
  assert.deepEqual(quote.items.map(item => [item.prompt, item.estimatedCredits]), prompts.map(prompt => [prompt, 10]))
  assert.deepEqual(calls.plans, prompts)
  assert.equal(calls.submissions.length, 0)
  assert.equal(calls.approvals.length, 0)
  assert.doesNotMatch(JSON.stringify(quote), /masked-account|example\.invalid/)

  const result = await submit(quote.batchId)
  assert.equal(calls.approvals.length, 1)
  assert.equal(calls.approvals[0].intent.kind, 'approval')
  assert.match(calls.approvals[0].detail, /30 credits/)
  for (const prompt of prompts) assert.ok(calls.approvals[0].detail.includes(prompt))
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.tasks.map(item => [item.index, item.status, item.region, item.profile, item.taskId]), [
    [1, 'queued', 'cn', 'studio', ready], [2, 'unknown', 'cn', 'studio', undefined], [3, 'queued', 'cn', 'studio', running],
  ])
  assert.deepEqual(await submit(quote.batchId), result)
  assert.deepEqual(await loadTools().submit(quote.batchId), result)
  assert.deepEqual(calls.submissions, prompts)
  assert.equal(calls.approvals.length, 1)
})

test('an expired or denied batch never submits from a different or reopened conversation', async t => {
  const { estimate, submit, loadTools, exec, calls } = await generationFixture(t, { ask: async () => batchAnswer('Cancel') })
  for (const input of [[], [prompts[0]], Array(9).fill(prompts[0]), [prompts[0], '  ']]) {
    await assert.rejects(estimate(input))
  }
  assert.deepEqual(calls.plans, [])
  const { batchId } = await estimate()
  const another = { ...exec, agent: { session: { ...exec.agent.session, id: 'another' } } }
  assert.equal((await submit(batchId, another)).status, 'expired')
  assert.equal((await loadTools().submit(batchId)).status, 'expired')
  const result = await submit(batchId)
  assert.equal(result.status, 'cancelled')
  assert.ok(result.tasks.every(task => task.status === 'notSubmitted'))
  assert.deepEqual(await loadTools().submit(batchId), result)
  assert.equal(calls.approvals.length, 1)
  assert.deepEqual(calls.submissions, [])
})

test('a reopened batch preserves an in-flight marker and does not submit future items', async t => {
  let started
  let finish
  const request = new Promise(resolve => { started = resolve })
  const response = new Promise(resolve => { finish = resolve })
  const { estimate, submit, loadTools, calls, controller } = await generationFixture(t, { submit: async () => {
    started()
    return await response
  } })
  const { batchId } = await estimate()
  const original = submit(batchId)
  try {
    await Promise.race([request, original.then(() => { throw new Error('The submission did not start') })])
    const result = await loadTools().submit(batchId)
    assert.equal(result.status, 'incomplete')
    assert.deepEqual(result.tasks.map(task => task.status), ['unknown', 'notSubmitted', 'notSubmitted'])
    assert.equal(calls.approvals.length, 1)
    assert.deepEqual(calls.submissions, prompts.slice(0, 1))
  } finally {
    controller.abort()
    finish({ task_id: ready })
  }
  const final = await original
  assert.equal(final.status, 'partial')
  assert.equal(final.tasks[0].taskId, ready)
  assert.deepEqual(final.tasks.map(task => task.status), ['queued', 'notSubmitted', 'notSubmitted'])
  assert.deepEqual(await loadTools().submit(batchId), final)
})

test('a changed Tripo account prevents the remaining approved batch items from submitting', async t => {
  const { estimate, submit, calls } = await generationFixture(t, { submit: async (_, identity) => {
    identity.key = 'different-account'
    return { task_id: ready }
  } })
  const { batchId } = await estimate()
  const result = await submit(batchId)
  assert.equal(result.status, 'partial')
  assert.match(result.error, /account changed/)
  assert.deepEqual(result.tasks.map(task => task.status), ['queued', 'notSubmitted', 'notSubmitted'])
  assert.deepEqual(calls.submissions, prompts.slice(0, 1))
})
