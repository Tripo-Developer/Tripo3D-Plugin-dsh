import assert from 'node:assert/strict'
import test from 'node:test'
import { registerRemoteConnector } from '../plugin/connector.js'

function fixture({ failAccount = false, failServer = false, delayedRemoval = false } = {}) {
  const events = []
  let guard
  let account
  let registration
  let currentServer
  let finishRemoval
  const removal = new Promise(resolve => { finishRemoval = resolve })
  const ctx = {
    effect(activate) { return activate() },
    tools: {
      guard(filter) {
        events.push('guard:add')
        guard = filter
        return () => { events.push('guard:remove'); guard = undefined }
      },
    },
    mcpAccounts: {
      register(value) {
        events.push('account:add')
        if (failAccount) throw new Error('account registration failed')
        account = value
        return () => { events.push('account:remove'); account = undefined }
      },
    },
    mcpManager: {
      register(name, config) {
        events.push('server:add')
        if (failServer) throw new Error('server registration failed')
        assert.equal(typeof guard, 'function')
        registration = { name, config }
        currentServer = name
        return () => {
          events.push('server:remove')
          if (!delayedRemoval) currentServer = undefined
        }
      },
      list() { return currentServer ? [{ name: currentServer }] : [] },
      async *watch() {
        events.push('server:watch')
        yield await Promise.resolve(ctx.mcpManager.list())
        await removal
        currentServer = undefined
        yield []
      },
    },
  }
  return { ctx, events, finishRemoval, get guard() { return guard }, get account() { return account }, get registration() { return registration } }
}

test('default, unknown regions, and hosts without the enforcement seam stay disconnected', () => {
  for (const region of [undefined, 'global', 'https://attacker.invalid/mcp']) {
    const { ctx, events } = fixture()
    assert.equal(registerRemoteConnector(ctx, region), undefined)
    assert.deepEqual(events, [])
  }
  const { ctx, events } = fixture()
  delete ctx.tools.guard
  assert.equal(registerRemoteConnector(ctx, 'cn'), undefined)
  assert.deepEqual(events, [])
})

test('registers only pinned regional endpoints with distinct dynamic OAuth credentials', async () => {
  for (const [region, url] of [
    ['cn', 'https://developers.tripo3d.com/mcp'], ['ov', 'https://openapi-mcp.tripo3d.ai/mcp'],
  ]) {
    const f = fixture()
    const dispose = registerRemoteConnector(f.ctx, region)
    const name = `tripo-dsh-${region}`
    assert.deepEqual(f.registration, {
      name, config: { transport: 'streamable-http', url, oauth: { credentialKey: `mcp-client/${name}` }, toolLoading: 'on-demand' },
    })
    assert.equal(f.account.server, name)
    assert.equal(f.account.packageName, '@vastai/tripo-dsh')
    assert.ok(f.account.copy.activation.title.en)
    assert.deepEqual(f.events, ['guard:add', 'account:add', 'server:add'])
    await dispose()
    assert.deepEqual(f.events.slice(3), ['account:remove', 'server:remove', 'guard:remove'])
  }
})

test('rejects unknown or paid Tripo tools before loading or execution and leaves other namespaces alone', async () => {
  const f = fixture()
  const dispose = registerRemoteConnector(f.ctx, 'cn')
  const name = 'mcp__tripo-dsh-cn__'
  const read = ['tripo_task_status', 'tripo_balance', 'tripo_usage']
  for (const tool of read) assert.equal(f.guard({ name: name + tool }), undefined)
  assert.equal(f.guard({ name: name + 'load_tools', arguments: { tools: read } }), undefined)
  for (const tool of ['tripo_generate', 'tripo_submit', 'tripo_rig', 'unknown', 'tripo_usage_changed']) {
    assert.match(f.guard({ name: name + tool }), /only reads/)
    assert.match(f.guard({ name: name + 'load_tools', arguments: { tools: [read[0], tool] } }), /only reads/)
  }
  assert.match(f.guard({ name: name + 'load_tools', arguments: {} }), /only reads/)
  assert.equal(f.guard({ name: 'mcp__tripo-dsh-ov__tripo_generate' }), undefined)
  assert.equal(f.guard({ name: 'mcp__notion__create_page' }), undefined)
  assert.equal(f.guard({ name: 'tripo_submit' }), undefined)
  await dispose()
})

test('retains the guard while the manager is still withdrawing the server', async () => {
  const f = fixture({ delayedRemoval: true })
  const dispose = registerRemoteConnector(f.ctx, 'cn')
  const cleanup = dispose()
  assert.match(f.guard({ name: 'mcp__tripo-dsh-cn__tripo_generate' }), /only reads/)
  f.finishRemoval()
  await cleanup
  assert.equal(f.guard, undefined)
  assert.deepEqual(f.events.slice(-3), ['server:remove', 'server:watch', 'guard:remove'])
})

test('withdraws partial registrations on startup failure', () => {
  for (const [options, expected] of [
    [{ failAccount: true }, ['guard:add', 'account:add', 'guard:remove']],
    [{ failServer: true }, ['guard:add', 'account:add', 'server:add', 'account:remove', 'guard:remove']],
  ]) {
    const f = fixture(options)
    assert.throws(() => registerRemoteConnector(f.ctx, 'ov'), /registration failed/)
    assert.equal(f.guard, undefined)
    assert.equal(f.account, undefined)
    assert.deepEqual(f.events, expected)
  }
})
