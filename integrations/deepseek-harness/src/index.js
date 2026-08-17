import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JamaDshProvider } from './provider.js'

export const name = 'jama'
export const inject = ['agents', 'sessions', 'tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  managementUrl: z.string().default('http://127.0.0.1:43121'),
  identityFile: z.string(),
  instanceKey: z.string(),
  name: z.string().default('DeepSeek Harness'),
  description: z.string().default('DeepSeek Harness connected through JAMA'),
  cwd: z.string(),
  agentPreset: z.string(),
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number(),
  leaseSeconds: z.number().default(60),
  reconnectDelayMs: z.number().default(1000),
  statusTool: z.boolean().default(true),
})

export function apply(ctx, config) {
  if (!config.enabled) return
  const resolved = {
    ...config,
    managementUrl: config.managementUrl || 'http://127.0.0.1:43121',
    name: config.name || 'DeepSeek Harness',
    description: config.description || 'DeepSeek Harness connected through JAMA',
    leaseSeconds: config.leaseSeconds || 60,
    reconnectDelayMs: config.reconnectDelayMs || 1000,
  }
  const provider = new JamaDshProvider(ctx, resolved)
  const controller = new AbortController()
  const lifetime = provider.serve(controller.signal).catch((error) => {
    if (!controller.signal.aborted) ctx.logger.error(`jama: Provider stopped: ${String(error)}`)
  })
  ctx.effect(() => async () => {
    controller.abort(new Error('JAMA plugin disposed'))
    await lifetime
  }, 'jama.provider()')

  if (config.statusTool !== false) {
    ctx.tools.register(defineTool({
      name: 'jama_connection_status',
      description: 'Check this DeepSeek Harness installation\'s local JAMA Provider connection state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `JAMA Provider state: ${value.state}`,
        }],
      },
      execute: () => Promise.resolve(provider.status()),
      isConcurrencySafe: () => true,
    }))
  }
}
