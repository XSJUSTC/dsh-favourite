/**
 * API-level end-to-end test against a RUNNING virtual DSH seeded with
 * completed-turn sessions (see test/seed-sessions.mjs).
 *
 * Drives the real /api RPC channel exactly like the browser client does:
 *   POST /api/<namespace>/<method>  with { type:'client-request', rpcId, method, payload:{args} }
 *
 * Covers: workspace/session listing over the seeded history, favorites
 * toggle/pin on the plugin routes, and fork inheritance through the real
 * session/created event path.
 *
 * Usage: node test/e2e-api.mjs <baseUrl> <launchToken> <seededParentId> <seededPlainId>
 */
import assert from 'node:assert/strict'

const [, , baseUrlArg, tokenArg, parentIdArg, plainIdArg] = process.argv
if (baseUrlArg === undefined || tokenArg === undefined || parentIdArg === undefined || plainIdArg === undefined) {
  console.error('usage: node test/e2e-api.mjs <baseUrl> <launchToken> <seededParentId> <seededPlainId>')
  process.exit(2)
}
const base = baseUrlArg.replace(/\/+$/, '')
const token = tokenArg
const parentSessionId = parentIdArg
const plainSessionId = plainIdArg

/** Exchange the launch token for the session cookie. */
async function authenticate() {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = res.headers.getSetCookie?.() ?? []
  const auth = cookies.map((cookie) => cookie.split(';')[0]).filter((pair) => pair.startsWith('dsh-auth-'))
  assert.ok(auth.length > 0, `expected an auth cookie, got: ${cookies.join(' | ')}`)
  return auth.join('; ')
}

let cookie
let rpcCounter = 0

/** Invoke one /api RPC endpoint with the browser envelope. */
async function rpc(endpoint, args, paramName = 'request') {
  rpcCounter += 1
  const rpcId = `e2e-${rpcCounter}`
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { [paramName]: args ?? {} } } })
  })
  assert.equal(res.status, 200, `rpc ${endpoint} http status`)
  const body = await res.json()
  assert.equal(body.type, 'server-response', `rpc ${endpoint} envelope`)
  assert.equal(body.rpcId, rpcId, `rpc ${endpoint} correlation`)
  return body.result
}

async function favorites() {
  const res = await fetch(`${base}/api/dsh-favourite`, { headers: { cookie } })
  assert.equal(res.status, 200)
  return res.json()
}

async function toggle(kind, id) {
  const res = await fetch(`${base}/api/dsh-favourite/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ kind, id })
  })
  assert.equal(res.status, 200)
  return res.json()
}

async function pin(kind, id, pinned) {
  const res = await fetch(`${base}/api/dsh-favourite/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ kind, id, pinned })
  })
  assert.equal(res.status, 200)
  return res.json()
}

const results = []
const check = (label, fn) => {
  results.push({ label, fn })
}

// ── scenario ────────────────────────────────────────────────────────────────
let workspaceId

check('authenticate via launch token', async () => {
  cookie = await authenticate()
})

check('seeded sessions appear in session.list', async () => {
  const result = await rpc('session/list', {}, '_request')
  assert.equal(result.ok, true, `session/list: ${JSON.stringify(result)}`)
  const value = result.value
  const items = value?.items ?? Object.values(value?.byId ?? {})
  const ids = items.map((item) => item.sessionId ?? item.id)
  assert.ok(ids.includes(parentSessionId), `parent ${parentSessionId} listed; value keys: ${JSON.stringify(Object.keys(value ?? {}))}, sample: ${JSON.stringify(value).slice(0, 300)}`)
  assert.ok(ids.includes(plainSessionId), `plain ${plainSessionId} listed`)
})

check('workspace.create adopts the seeded demo directory', async () => {
  const dir = process.env.DSH_FAV_DEMO_DIR
  assert.ok(dir, 'DSH_FAV_DEMO_DIR set')
  const result = await rpc('workspace/create', { path: dir })
  assert.equal(result.ok, true, `workspace/create: ${JSON.stringify(result)}`)
  workspaceId = result.value?.workspaceId ?? result.value?.workspace?.workspaceId ?? result.value?.id
  assert.ok(workspaceId, `workspace id in value: ${JSON.stringify(result.value).slice(0, 200)}`)
})

check('favorites: star + pin the parent session', async () => {
  // Idempotent: the favorites document persists across runs.
  const before = await favorites()
  if (before.sessions[parentSessionId] === undefined) {
    const state = await toggle('session', parentSessionId)
    assert.equal(state.favorited, true)
  }
  const pinned = await pin('session', parentSessionId, true)
  assert.equal(pinned.sessions[parentSessionId].pinned, true)
  assert.equal(pinned.sessions[parentSessionId].favorite, true)
})

check('session.fork forks the seeded parent (real runtime fork)', async () => {
  const result = await rpc('session/fork', { sessionId: parentSessionId })
  assert.equal(result.ok, true, `session/fork: ${JSON.stringify(result)}`)
  const childId = result.value.sessionId
  assert.ok(childId && childId !== parentSessionId)
  check('fork inherited the parent favorite state (requirement 4)', async () => {
    const state = await favorites()
    const child = state.sessions[childId]
    assert.ok(child, 'child inherited a favorite entry')
    assert.equal(child.favorite, true)
    assert.equal(child.pinned, true, 'pinned state inherited')
    assert.equal(child.inheritedFrom, parentSessionId)
  })
})

check('unfavorited parent leaves the fork at the default state', async () => {
  const forked = await rpc('session/fork', { sessionId: plainSessionId })
  assert.equal(forked.ok, true, `session/fork plain: ${JSON.stringify(forked)}`)
  const childId = forked.value.sessionId
  const state = await favorites()
  assert.equal(state.sessions[plainSessionId], undefined)
  assert.equal(state.sessions[childId], undefined)
})

check('favoriting a workspace does not favorite its sessions (requirement 1)', async () => {
  const before = await favorites()
  if (before.workspaces[workspaceId] === undefined) await toggle('workspace', workspaceId)
  const state = await favorites()
  assert.ok(state.workspaces[workspaceId], 'workspace favorited')
  assert.ok(state.sessions[parentSessionId], 'session favorite independent of the workspace favorite')
  // The plain session stays unfavorited even though it lives in the favorited workspace.
  assert.equal(state.sessions[plainSessionId], undefined)
})

// ── runner (live array: checks may enqueue follow-ups) ─────────────────────
let failed = 0
for (let index = 0; index < results.length; index++) {
  const { label, fn } = results[index]
  try {
    await fn()
    console.log(`✔ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`✖ ${label}`)
    console.log(String(error?.stack ?? error).split('\n').slice(0, 6).map((line) => `    ${line}`).join('\n'))
  }
}
console.log(failed === 0 ? `\nALL E2E CHECKS PASSED` : `\n${failed} E2E CHECKS FAILED`)
process.exit(failed === 0 ? 0 : 1)
