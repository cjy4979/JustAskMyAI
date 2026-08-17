import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function defaultIdentityFile() {
  return join(homedir(), '.dsh', 'jama-provider.json')
}

export async function loadIdentity(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value.instanceKey !== 'string'
      || typeof value.agentId !== 'string'
      || typeof value.accessToken !== 'string') {
      throw new Error('identity is missing instanceKey, agentId, or accessToken')
    }
    return value
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw new Error(`invalid JAMA Provider identity file: ${path}`, { cause: error })
  }
}

export async function saveIdentity(path, identity) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => undefined)
}

export function createInstanceKey() {
  return `dsh_${randomUUID()}`
}
