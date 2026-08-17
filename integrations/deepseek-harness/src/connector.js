import { setTimeout as delay } from 'node:timers/promises'

/**
 * Dependency-free JAMA Provider transport embedded in the installable plugin.
 * The open SSE request is ordinary code and creates no DSH model turn while idle.
 */
export class ProviderConnector {
  constructor(options) {
    this.options = options
    this.fetchImpl = options.fetch ?? fetch
    this.leaseSeconds = Math.min(300, Math.max(15, options.leaseSeconds ?? 60))
    this.reconnectDelayMs = Math.max(100, options.reconnectDelayMs ?? 1000)
    this.cursor = 0
  }

  static async register(input) {
    const fetchImpl = input.fetch ?? fetch
    return requestJson(fetchImpl, `${trimSlash(input.managementUrl)}/api/provider/connect/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceKey: input.instanceKey,
        name: input.name,
        description: input.description,
        capabilities: input.capabilities,
        accessToken: input.accessToken,
      }),
    })
  }

  status() {
    return this.call('/api/provider/connect/status')
  }

  async claim() {
    const response = await this.call('/api/provider/connect/claim', {
      method: 'POST',
      body: JSON.stringify({ leaseSeconds: this.leaseSeconds }),
    })
    return response.status === 'CLAIMED' ? response.job : undefined
  }

  renew(job) {
    return this.call(`/api/provider/connect/jobs/${job.id}/renew`, {
      method: 'POST',
      body: JSON.stringify({ leaseToken: job.leaseToken, leaseSeconds: this.leaseSeconds }),
    })
  }

  progress(job, message, percent) {
    return this.call(`/api/provider/connect/jobs/${job.id}/progress`, {
      method: 'POST',
      body: JSON.stringify({ leaseToken: job.leaseToken, message, percent }),
    })
  }

  complete(job, result) {
    return this.call(`/api/provider/connect/jobs/${job.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ leaseToken: job.leaseToken, ...result }),
    })
  }

  fail(job, error) {
    return this.call(`/api/provider/connect/jobs/${job.id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ leaseToken: job.leaseToken, error: conciseError(error) }),
    })
  }

  async *events(signal) {
    while (!signal?.aborted) {
      try {
        const response = await this.fetchImpl(
          `${trimSlash(this.options.managementUrl)}/api/provider/connect/events?after=${this.cursor}`,
          { headers: this.headers(), signal },
        )
        if (!response.ok || !response.body) {
          throw new Error(`provider event stream failed (${response.status}): ${await response.text()}`)
        }
        for await (const block of eventBlocks(response.body, signal)) {
          const event = parseEvent(block)
          if (!event) continue
          this.cursor = Math.max(this.cursor, event.sequence)
          yield event
        }
        if (!signal?.aborted) await delay(this.reconnectDelayMs, undefined, { signal }).catch(() => undefined)
      } catch {
        if (signal?.aborted) return
        await delay(this.reconnectDelayMs, undefined, { signal }).catch(() => undefined)
      }
    }
  }

  async serve(handler, signal) {
    while (!signal?.aborted) {
      try {
        await this.drain(handler, signal)
        for await (const event of this.events(signal)) {
          if (event.type !== 'job.available' && event.type !== 'agent.activated') continue
          await this.drain(handler, signal)
        }
      } catch {
        if (signal?.aborted) return
        await delay(this.reconnectDelayMs, undefined, { signal }).catch(() => undefined)
      }
    }
  }

  async drain(handler, signal) {
    let job
    while (!signal?.aborted && (job = await this.claim())) await this.execute(job, handler, signal)
  }

  async execute(job, handler, parentSignal) {
    const renewEveryMs = Math.max(5000, Math.floor(this.leaseSeconds * 500))
    const controller = new AbortController()
    let ownershipLost = false
    const abortFromParent = () => controller.abort(parentSignal?.reason)
    if (parentSignal?.aborted) abortFromParent()
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    const timer = setInterval(() => {
      void this.renew(job).catch((error) => {
        ownershipLost = true
        controller.abort(error)
      })
    }, renewEveryMs)
    timer.unref()
    try {
      const result = await handler(job, controller.signal)
      if (ownershipLost || parentSignal?.aborted) return
      await this.complete(job, result)
    } catch (error) {
      if (ownershipLost || parentSignal?.aborted) return
      await this.fail(job, error).catch(() => undefined)
    } finally {
      clearInterval(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }

  headers() {
    return {
      authorization: `Bearer ${this.options.accessToken}`,
      'x-jama-provider-agent': this.options.agentId,
    }
  }

  call(path, init = {}) {
    return requestJson(this.fetchImpl, `${trimSlash(this.options.managementUrl)}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...this.headers(), ...init.headers },
    })
  }
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init)
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return await response.json()
}

async function* eventBlocks(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (block) yield block
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(block) {
  const data = block.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return undefined
  const parsed = JSON.parse(data)
  return typeof parsed.sequence === 'number' ? parsed : undefined
}

function trimSlash(value) {
  return value.replace(/\/$/, '')
}

function conciseError(error) {
  const value = error instanceof Error ? error.message : String(error)
  return value.slice(0, 1000)
}
