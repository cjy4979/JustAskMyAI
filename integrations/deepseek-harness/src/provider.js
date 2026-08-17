import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ProviderConnector } from './connector.js'
import {
  createInstanceKey,
  defaultIdentityFile,
  loadIdentity,
  saveIdentity,
} from './identity.js'
import { extractAssistantText } from './result.js'

const CAPABILITIES = Object.freeze({
  isolatedSessions: true,
  sessionResume: true,
  structuredContextualOutput: true,
  separateMemoryNamespace: true,
  supportsCancellation: true,
  maxConcurrency: 1,
  operations: ['ask', 'review'],
  artifactTypes: ['text', 'contextual-answer'],
  isolationAssurance: 'self-reported',
})

export class JamaDshProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.identityFile = config.identityFile || defaultIdentityFile()
    this.connector = undefined
    this.statusSnapshot = { state: 'starting' }
  }

  status() {
    return {
      state: this.statusSnapshot.state,
      ...(this.statusSnapshot.error ? { error: this.statusSnapshot.error } : {}),
    }
  }

  async serve(signal) {
    while (!signal.aborted) {
      try {
        await this.connectAndServe(signal)
      } catch (error) {
        if (signal.aborted) return
        this.statusSnapshot = { state: 'disconnected', error: conciseError(error) }
        this.ctx.logger.warn(`jama: provider disconnected: ${conciseError(error)}`)
        await delay(this.config.reconnectDelayMs, undefined, { signal }).catch(() => undefined)
      }
    }
  }

  async connectAndServe(signal) {
    const stored = await loadIdentity(this.identityFile)
    const instanceKey = stored?.instanceKey || this.config.instanceKey || createInstanceKey()
    const registration = await ProviderConnector.register({
      managementUrl: this.config.managementUrl,
      instanceKey,
      name: this.config.name,
      description: this.config.description,
      capabilities: CAPABILITIES,
      accessToken: stored?.accessToken,
    })
    const accessToken = stored?.accessToken || registration.accessToken
    if (!accessToken) throw new Error('JAMA did not return the first-registration access token')
    if (stored && registration.agent.id !== stored.agentId) {
      throw new Error('JAMA registration returned a different Agent identity')
    }
    const identity = {
      instanceKey,
      agentId: registration.agent.id,
      accessToken,
    }
    if (!stored) await saveIdentity(this.identityFile, identity)
    this.connector = new ProviderConnector({
      managementUrl: this.config.managementUrl,
      agentId: identity.agentId,
      accessToken: identity.accessToken,
      leaseSeconds: this.config.leaseSeconds,
      reconnectDelayMs: this.config.reconnectDelayMs,
    })
    this.statusSnapshot = {
      state: registration.agent.status,
      agentId: registration.agent.id,
    }
    if (registration.agent.status === 'pending') {
      this.ctx.logger.info('jama: Provider registered and awaits Owner activation in the JAMA Owner Hub')
    } else {
      this.ctx.logger.info(`jama: Provider ${registration.agent.status}; passive event connection starting`)
    }
    await this.connector.serve((job, jobSignal) => this.execute(job, jobSignal), signal)
  }

  async execute(job, signal) {
    this.statusSnapshot = { ...this.statusSnapshot, state: 'working', jobId: job.id }
    await this.connector?.progress(job, 'DeepSeek Harness session starting')
    let handle
    try {
      const agentOptions = {
        ...(this.config.provider ? { provider: this.config.provider } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.maxTokens ? { maxTokens: this.config.maxTokens } : {}),
      }
      if (job.request.resumeSessionId) {
        handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(job.request.resumeSessionId),
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          signal,
          setup: agentCtx => isolateExternalAgent(agentCtx),
        })
      } else {
        handle = await this.ctx.agents.create({
          sessionId: SessionId(randomUUID()),
          meta: {
            ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
            ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
          },
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          signal,
          setup: agentCtx => isolateExternalAgent(agentCtx),
        })
      }
      const { agent } = handle
      const startIndex = agent.session.events.length
      const abortAgent = () => agent.cancel({ kind: 'hook', reason: 'JAMA lease or Connector ownership ended' })
      signal.addEventListener('abort', abortAgent, { once: true })
      try {
        if (signal.aborted) throw signal.reason ?? new Error('JAMA job was cancelled')
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: job.request.prompt }],
          source: { kind: 'plugin', plugin: 'jama' },
        }))
        await agent.whenIdle()
        if (signal.aborted) throw signal.reason ?? new Error('JAMA job ownership was lost')
        const text = extractAssistantText(agent.session.events, startIndex)
        await this.ctx.sessions.flush(agent.session)
        return { text, sessionId: agent.id }
      } finally {
        signal.removeEventListener('abort', abortAgent)
      }
    } finally {
      if (handle) await handle.dispose()
      const { jobId: _jobId, ...rest } = this.statusSnapshot
      this.statusSnapshot = { ...rest, state: 'active' }
    }
  }
}

function isolateExternalAgent(agentCtx) {
  // The first preview is deliberately hermetic: the authorized JAMA projection
  // arrives in the prompt, while every ordinary DSH workspace/network/action
  // tool is hidden. Later releases map explicit JAMA action grants to selected
  // structured tools; an unscoped terminal will never be enabled.
  agentCtx.tools.restrict({ allow: [] })
  agentCtx.tools.presentAs('native')
}

function conciseError(error) {
  const value = error instanceof Error ? error.message : String(error)
  return value.slice(0, 1000)
}
