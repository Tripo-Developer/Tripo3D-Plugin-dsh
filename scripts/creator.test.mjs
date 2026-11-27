import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, registerCreatorConnection, registerCreatorPrompt } from '../plugin/creator.js'

test('creation preferences are validated volatile settings and feed the preset prompt', () => {
  const standard = Config({ workspaceDemo: true })
  assert.equal(standard.workspaceDemo, true)
  assert.equal(standard.defaultRegion.get(), 'auto')
  assert.equal(standard.exportFormat.get(), 'GLB')
  assert.throws(() => Config({ defaultRegion: 'invalid' }))
  assert.throws(() => Config({ exportFormat: 'invalid' }))

  const custom = Config({ defaultRegion: 'cn', exportFormat: 'FBX' })
  const variables = new Map()
  registerCreatorPrompt({
    effect: (register) => register(),
    systemPrompt: { variable: (key, resolve) => variables.set(key, resolve) },
  }, custom)
  assert.equal(variables.get('tripo_default_region')(), 'cn')
  assert.equal(variables.get('tripo_export_format')(), 'FBX')
})

test('connection checks use the selected CLI profile and expose only region and profile', async () => {
  const calls = []
  let tool
  let reply = { exitCode: 0, data: { region: 'ov', profile: 'studio', source: 'profile:studio', key: 'masked', balance: 24 } }
  registerCreatorConnection({
    tools: { register: (definition) => { tool = definition } },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    shellEnv: { collect: () => ({}) },
    shell: {
      resolve: (spec) => spec,
      execute: async (spec) => {
        calls.push(spec.command)
        return { result: async () => ({ exitCode: reply.exitCode, stdout: { text: JSON.stringify(reply.data) } }) }
      },
    },
  }, Config({ defaultRegion: 'cn' }))
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: '/workspace' } } } }

  assert.deepEqual(await tool.execute({ profile: 'studio' }, exec), {
    status: 'regionMismatch', expectedRegion: 'cn', region: 'ov', profile: 'studio',
  })
  assert.equal(calls[0], 'tripo whoami --json --profile studio')
  const connected = await tool.execute({ region: 'ov' }, exec)
  const [rendered] = tool.output.render({}, connected)
  assert.deepEqual(JSON.parse(rendered.text), { status: 'connected', expectedRegion: 'ov', region: 'ov', profile: 'studio' })

  reply = { exitCode: 0, data: { region: 'cn', source: 'env:TRIPO_API_KEY', key: 'masked', balance: 0 } }
  assert.deepEqual(await tool.execute({}, exec), { status: 'connected', expectedRegion: 'cn', region: 'cn' })
  reply = { exitCode: 3, data: { key: 'masked' } }
  assert.deepEqual(await tool.execute({}, exec), { status: 'unavailable', expectedRegion: 'cn' })
  await assert.rejects(tool.execute({ profile: 'studio; exit' }, exec), /valid Tripo region and CLI profile/)
  assert.equal(calls.length, 4)
})
