import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { registerPaidTools } from '../plugin/paid.js'

const input = {
  operation: 'generate', region: 'cn', profile: 'studio',
  model: 'tripo-v3.1', prompt: "A 'stone' arch", texture: false,
}
const taskId = '2121a32d-4b39-45c2-b54a-591bca03d317'
const approve = 'Submit Tripo task'
const reject = 'Cancel'
const answer = label => ({ answers: [{ id: 'tripo-submit', selected: [label] }] })

function fixture({ ask = async () => answer(approve), submission = { task_id: taskId } } = {}) {
  const workspaceRoot = tmpdir()
  const execFor = id => ({
    agent: { session: { id, header: { cwd: workspaceRoot, origin: 'user' } } },
    signal: new AbortController().signal,
  })
  const calls = { plans: [], submissions: [], questions: [] }
  const identity = {
    profile: input.profile, source: `profile:${input.profile}`, region: input.region,
    key: 'masked-before', balance: 100, api_base_url: 'https://example.invalid/',
  }
  const tools = new Map()
  registerPaidTools({
    tools: { register(tool) { tools.set(tool.name, tool) } },
    userQuestions: { async ask(request) { calls.questions.push(request); return await ask(request) } },
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot } } },
    shellEnv: { collect() { return {} } },
    shell: {
      resolve(spec) { return spec },
      async execute(spec) {
        assert.equal(spec.workdir, workspaceRoot)
        const command = spec.command
        let data
        if (command.startsWith('tripo whoami ')) {
          data = identity
        } else {
          assert.match(command, /^node -e /)
          assert.ok(!command.includes(input.prompt))
          const args = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64url').toString())
          assert.equal(args.at(-2), '--')
          if (args.includes('--dry-run')) {
            calls.plans.push(args)
            data = {
              valid: true, generation_credits_estimate: 10, warnings: [], errors: [],
              steps: [{ endpoint: '/v3/generation/text-to-model', payload: {
                prompt: args.at(-1), model: 'v3.1-20260211', texture: false, pbr: false,
              } }],
            }
          } else {
            calls.submissions.push(args)
            data = submission
          }
        }
        return { async result() { return { exitCode: 0, stdout: { text: JSON.stringify(data), truncated: false } } } }
      },
    },
  })
  const exec = execFor('owner')
  return {
    exec, calls, identity,
    estimate: () => tools.get('tripo_estimate').execute(input, exec),
    submit: (quoteId, owner = exec) => tools.get('tripo_submit').execute({ quoteId }, owner),
    anotherSession: execFor('another'),
  }
}

test('quotes an exact request without creating a task, then one native approval submits those same arguments', async () => {
  const { calls, exec, estimate, submit } = fixture()
  const quote = await estimate()
  assert.equal(quote.estimatedCredits, 10)
  assert.equal(quote.model, 'v3.1-20260211')
  assert.equal(quote.prompt, input.prompt)
  assert.doesNotMatch(JSON.stringify(quote), /masked-before|example\.invalid/)
  assert.equal(calls.plans.length, 1)
  assert.equal(calls.questions.length, 0)
  assert.equal(calls.submissions.length, 0)

  assert.deepEqual(await submit(quote.quoteId), { taskId, status: 'queued', region: input.region, profile: input.profile })
  const [request] = calls.questions
  const [question] = request.questions
  assert.equal(request.agent, exec.agent)
  assert.equal(request.signal, exec.signal)
  assert.deepEqual(question.intent, { kind: 'approval', approve, reject })
  assert.match(question.detail, /10 credits/)
  assert.ok(question.detail.includes(input.prompt))
  assert.deepEqual(calls.submissions, [calls.plans[0].filter(arg => arg !== '--dry-run')])
})

test('denial consumes the quote without any paid CLI invocation', async () => {
  const { calls, estimate, submit } = fixture({ ask: async () => answer(reject) })
  const { quoteId } = await estimate()
  assert.equal((await submit(quoteId)).status, 'cancelled')
  assert.equal((await submit(quoteId)).status, 'alreadyUsed')
  assert.equal(calls.questions.length, 1)
  assert.equal(calls.submissions.length, 0)
})

test('a concurrent call cannot consume a quote waiting for the first decision', async () => {
  let decide
  const consent = new Promise(resolve => { decide = resolve })
  const { calls, estimate, submit } = fixture({ ask: () => consent })
  const { quoteId } = await estimate()
  const original = submit(quoteId)
  try {
    assert.equal((await submit(quoteId)).status, 'alreadyUsed')
    assert.equal(calls.questions.length, 1)
    assert.equal(calls.submissions.length, 0)
  } finally {
    decide(answer(approve))
  }
  assert.equal((await original).taskId, taskId)
  assert.equal(calls.submissions.length, 1)
})

test('a quote from a different session cannot prompt or submit', async () => {
  const { calls, estimate, submit, anotherSession } = fixture()
  const { quoteId } = await estimate()
  assert.equal((await submit(quoteId, anotherSession)).status, 'expired')
  assert.equal(calls.questions.length, 0)
  assert.equal(calls.submissions.length, 0)
  assert.equal((await submit(quoteId)).taskId, taskId)
})

test('a change of effective account after quoting blocks even an approved submission', async () => {
  const { calls, identity, estimate, submit } = fixture()
  const { quoteId } = await estimate()
  identity.key = 'masked-after'
  assert.equal((await submit(quoteId)).status, 'unavailable')
  assert.equal(calls.questions.length, 1)
  assert.equal(calls.submissions.length, 0)
})

test('a submission without a valid task ID is unknown and the quote cannot be replayed', async () => {
  const { calls, estimate, submit } = fixture({ submission: {} })
  const { quoteId } = await estimate()
  const result = await submit(quoteId)
  assert.equal(result.status, 'unknown')
  assert.equal(result.taskId, undefined)
  assert.match(result.error, /Check account usage and task history/)
  assert.equal((await submit(quoteId)).status, 'alreadyUsed')
  assert.equal(calls.submissions.length, 1)
})
