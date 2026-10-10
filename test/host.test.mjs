/**
 * Host-half test: applies lib/index.js against a mock Cordis context and
 * exercises the routes, storage, and fork-inheritance behavior.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const home = mkdtempSync(path.join(tmpdir(), 'dsh-favourite-test-'))
process.env.DSH_HOME = home

const { apply, name, inject, API } = await import('../lib/index.js')

/** Build a mock Cordis context with route + listener capture. */
function mockCtx() {
  const routes = new Map()
  const listeners = new Map()
  const provided = new Map()
  const effects = []
  const ctx = {
    effect(fn, label) {
      const result = fn()
      effects.push({ label, result })
      return result
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const list = listeners.get(event) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    provide(key, service) {
      provided.set(key, service)
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      }
    },
    _routes: routes,
    _listeners: listeners,
    _provided: provided,
    _effects: effects
  }
  return ctx
}

/** Fake minimal IncomingMessage. */
function fakeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

/** Capture writeHead/end into a plain object. */
function fakeRes() {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(payload) {
      res.body = payload === undefined ? undefined : JSON.parse(payload)
    }
  }
  return res
}

async function call(routes, pathName, method, body) {
  const handler = routes.get(pathName)
  if (handler === undefined) throw new Error(`no route for ${pathName}`)
  const res = fakeRes()
  await handler(fakeReq(method, body), res)
  return res
}

/** Await the initial-storage load effect (effects run in registration order). */
async function loaded(ctx) {
  const effect = ctx._effects.find((entry) => entry.label === 'dsh-favourite: initial load')
  assert.ok(effect, 'load effect registered')
  await effect.result
}

test('plugin shape', () => {
  assert.equal(name, 'dsh-favourite')
  assert.deepEqual(inject, ['webServer'])
})

test('apply returns undefined and registers routes', async () => {
  const ctx = mockCtx()
  const result = apply(ctx)
  assert.equal(result, undefined)
  for (const expected of [API, `${API}/toggle`, `${API}/pin`]) {
    assert.ok(ctx._routes.has(expected), `route ${expected} registered`)
  }
  const load = ctx._effects.find((effect) => effect.label === 'dsh-favourite: initial load')
  assert.ok(load, 'initial load effect present')
  await load.result
})

test('GET starts empty', async () => {
  const ctx = mockCtx()
  apply(ctx)
  await loaded(ctx)
  const res = await call(ctx._routes, API, 'GET')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.sessions, {})
  assert.deepEqual(res.body.workspaces, {})
})

test('toggle + pin round trip', async () => {
  const ctx = mockCtx()
  apply(ctx)
  await loaded(ctx)
  const toggled = await call(ctx._routes, `${API}/toggle`, 'POST', { kind: 'session', id: 'session-1' })
  assert.equal(toggled.body.favorited, true)
  const pinned = await call(ctx._routes, `${API}/pin`, 'POST', { kind: 'session', id: 'session-1', pinned: true })
  assert.equal(pinned.body.changed, true)
  assert.equal(pinned.body.sessions['session-1'].pinned, true)
  assert.equal(typeof pinned.body.sessions['session-1'].pinnedAt, 'number')
  const workspace = await call(ctx._routes, `${API}/toggle`, 'POST', { kind: 'workspace', id: 'workspace-1' })
  assert.equal(workspace.body.favorited, true)
  const state = await call(ctx._routes, API, 'GET')
  assert.deepEqual(Object.keys(state.body.sessions), ['session-1'])
  assert.deepEqual(Object.keys(state.body.workspaces), ['workspace-1'])
  // Untoggle removes the whole entry (including the pin).
  const untoggled = await call(ctx._routes, `${API}/toggle`, 'POST', { kind: 'session', id: 'session-1' })
  assert.equal(untoggled.body.favorited, false)
  assert.equal(untoggled.body.sessions['session-1'], undefined)
})

test('pin requires an existing favorite (409)', async () => {
  const ctx = mockCtx()
  apply(ctx)
  await loaded(ctx)
  const res = await call(ctx._routes, `${API}/pin`, 'POST', { kind: 'session', id: 'ghost', pinned: true })
  assert.equal(res.status, 409)
})

test('invalid bodies are 400, wrong methods 405', async () => {
  const ctx = mockCtx()
  apply(ctx)
  await loaded(ctx)
  assert.equal((await call(ctx._routes, `${API}/toggle`, 'POST', { kind: 'nope', id: 'x' })).status, 400)
  assert.equal((await call(ctx._routes, `${API}/toggle`, 'POST', { kind: 'session' })).status, 400)
  assert.equal((await call(ctx._routes, `${API}/pin`, 'POST', { kind: 'session', id: 'x', pinned: 'yes' })).status, 400)
  assert.equal((await call(ctx._routes, API, 'POST', {})).status, 405)
})

test('fork inheritance copies favorite + pinned at fork time', async () => {
  const ctx = mockCtx()
  apply(ctx)
  await loaded(ctx)
  // Favorite the parent and pin it.
  await call(ctx._routes, `${API}/toggle`, 'POST', { kind: 'session', id: 'parent-1' })
  await call(ctx._routes, `${API}/pin`, 'POST', { kind: 'session', id: 'parent-1', pinned: true })
  const handlers = ctx._listeners.get('session/created')
  assert.ok(handlers.length === 1, 'session/created listener registered')
  const fork = (header) => handlers[0]({ id: header.id, header })
  // Seeded ordinary fork inherits favorite + pinned.
  fork({ id: 'child-1', parentSession: 'parent-1', isSeeded: true })
  // Unfavorited parent leaves the child at the default.
  fork({ id: 'child-2', parentSession: 'stranger', isSeeded: true })
  // Subagent children and non-seeded sessions never inherit.
  fork({ id: 'child-3', parentSession: 'parent-1', isSeeded: true, origin: 'subagent' })
  fork({ id: 'child-4', parentSession: 'parent-1' })
  const state = (await call(ctx._routes, API, 'GET')).body
  assert.equal(state.sessions['child-1'].favorite, true)
  assert.equal(state.sessions['child-1'].pinned, true)
  assert.equal(state.sessions['child-1'].inheritedFrom, 'parent-1')
  assert.equal(state.sessions['child-2'], undefined)
  assert.equal(state.sessions['child-3'], undefined)
  assert.equal(state.sessions['child-4'], undefined)
})

test('state survives a reload (fresh apply reads the same file)', async () => {
  const first = mockCtx()
  apply(first)
  await loaded(first)
  await call(first._routes, `${API}/toggle`, 'POST', { kind: 'workspace', id: 'ws-persist' })
  const second = mockCtx()
  apply(second)
  await loaded(second)
  const res = await call(second._routes, API, 'GET')
  assert.equal(res.body.workspaces['ws-persist'].favorite, true)
})

test('provided service mirrors state', async () => {
  const ctx = mockCtx()
  apply(ctx)
  await loaded(ctx)
  const service = ctx._provided.get('dshFavourite')
  assert.ok(service, 'dshFavourite provided')
  await service.toggle('session', 'svc-1')
  assert.equal(service.isFavorited('session', 'svc-1'), true)
  await service.setPinned('session', 'svc-1', true)
  assert.equal(service.snapshot().sessions['svc-1'].pinned, true)
})

test('storage file lives under DSH_HOME/storages', async () => {
  const { access } = await import('node:fs/promises')
  await access(path.join(home, 'storages', 'dsh-favourite.json'))
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})
