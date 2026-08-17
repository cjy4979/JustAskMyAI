import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { ProviderConnector } from '../src/connector.js'
import { createInstanceKey, loadIdentity, saveIdentity } from '../src/identity.js'
import { extractAssistantText } from '../src/result.js'

test('extractAssistantText returns only the latest assistant output after the job boundary', () => {
  const events = [
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'old' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'question' }] } },
    { type: 'assistant/message', data: { content: [
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: '{"answer":"new"}' },
    ] } },
  ]
  assert.equal(extractAssistantText(events, 1), '{"answer":"new"}')
})

test('extractAssistantText accepts the rc.5 nested assistant message shape', () => {
  const events = [{
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'private' },
          { type: 'text', text: '{"answer":"rc.5"}' },
        ],
      },
    },
  }]
  assert.equal(extractAssistantText(events), '{"answer":"rc.5"}')
})

test('provider identity round-trips through a private local file without logging the token', async () => {
  const root = join(tmpdir(), `jama-dsh-identity-${randomUUID()}`)
  const path = join(root, 'identity.json')
  const identity = {
    instanceKey: createInstanceKey(),
    agentId: 'agent-local',
    accessToken: 'secret-token-value',
  }
  try {
    assert.equal(await loadIdentity(path), undefined)
    await saveIdentity(path, identity)
    assert.deepEqual(await loadIdentity(path), identity)
    assert.match(await readFile(path, 'utf8'), /secret-token-value/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('connector propagates parent cancellation and does not complete a lost job', async () => {
  const connector = new ProviderConnector({
    managementUrl: 'http://127.0.0.1:1',
    agentId: 'agent',
    accessToken: 'token',
  })
  let completed = false
  let failed = false
  connector.complete = async () => { completed = true }
  connector.fail = async () => { failed = true }
  const parent = new AbortController()
  parent.abort(new Error('shutdown'))
  await connector.execute({ id: 'job', leaseToken: 'lease' }, async (_job, signal) => {
    assert.equal(signal.aborted, true)
    throw signal.reason
  }, parent.signal)
  assert.equal(completed, false)
  assert.equal(failed, false)
})

test('package declares the DSH profile bundle and pins the tested preview', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.compatibility.tested, '0.1.0-rc.6')
  assert.equal(packageJson.peerDependencies['@deepseek-ai/dsh-agent'], '0.1.0-rc.6')
  assert.equal(packageJson.peerDependenciesMeta['@deepseek-ai/dsh-agent'].optional, true)
})
