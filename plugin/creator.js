import z from '@deepseek-ai/schemastery'
import { createTripoQuery, resolveTripoProfile, runTripo } from './task.js'
import { isTaskProfile, taskRegions } from './workspace.js'

const defaultRegions = ['auto', ...taskRegions]
const exportFormats = ['GLB', 'FBX', 'OBJ']
const choices = (values) => z.union(values.map(value => z.const(value)))

export const Config = z.object({
  workspaceDemo: z.boolean().default(false),
  defaultRegion: choices(defaultRegions).default('auto').volatile(),
  exportFormat: choices(exportFormats).default('GLB').volatile(),
  remoteConnectorRegion: choices(['off', ...taskRegions]).default('off'),
})

const defaultRegion = (config) => config?.defaultRegion?.get() ?? 'auto'

export function registerCreatorPrompt(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.variable('tripo_default_region', () => defaultRegion(config)))
  ctx.effect(() => ctx.systemPrompt.variable('tripo_export_format', () => config?.exportFormat?.get() ?? 'GLB'))
}

export function registerCreatorConnection(ctx, config) {
  ctx.tools.register({
    name: 'tripo_connection',
    description: 'Check the active Tripo CLI account and region, or check a named CLI profile, without charging credits or changing credentials. Uses the Tripo default region when no region is specified.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      region: { type: 'string', enum: taskRegions }, profile: { type: 'string' },
    } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['status', 'expectedRegion'], properties: {
        status: { type: 'string', enum: ['connected', 'regionMismatch', 'unavailable'] },
        expectedRegion: { type: 'string', enum: defaultRegions },
        region: { type: 'string', enum: taskRegions }, profile: { type: 'string' },
      } },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    async execute({ region, profile }, exec) {
      if ((region !== undefined && !taskRegions.includes(region)) || (profile !== undefined && !isTaskProfile(profile))) {
        throw new Error('Choose a valid Tripo region and CLI profile.')
      }
      const expectedRegion = region ?? defaultRegion(config)
      const unavailable = { status: 'unavailable', expectedRegion }
      const query = createTripoQuery(ctx, exec)
      try {
        const { result, data } = await runTripo(ctx, query, ['whoami'], profile)
        if (result.exitCode !== 0 || !taskRegions.includes(data?.region) || !Number.isFinite(data.balance)) return unavailable
        const detected = resolveTripoProfile(data, data.region, profile)
        if (!detected) return unavailable
        return {
          status: expectedRegion === 'auto' || expectedRegion === data.region ? 'connected' : 'regionMismatch',
          expectedRegion, region: data.region, ...detected,
        }
      } catch {
        query.signal.throwIfAborted()
        return unavailable
      }
    },
  })
}
