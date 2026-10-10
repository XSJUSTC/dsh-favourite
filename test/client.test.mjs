/**
 * Client-half test: loads lib/client.js inside a ModuleLoader stub with a
 * require shim for the shell externals, then applies it against a mock client
 * context and asserts the slot registration contract.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const home = mkdtempSync(path.join(tmpdir(), 'dsh-favourite-client-'))
process.env.DSH_HOME = home

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Frozen-module-table stubs: only the shapes touched at load/apply time. */
function buildRequire() {
  const noop = () => {}
  const reactStub = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'Fragment') return 'Fragment'
      return noop
    }
  })
  const primitives = new Proxy({}, {
    get() {
      return function DummyPrimitive() {
        return null
      }
    }
  })
  const modules = {
    react: reactStub,
    'react/jsx-runtime': {
      jsx: (type, props, key) => ({ type, props, key }),
      jsxs: (type, props, key) => ({ type, props, key }),
      Fragment: 'Fragment'
    },
    '@deepseek-ai/cordis': {
      Service: class Service {
        constructor(ctx, serviceName) {
          this.ctx = ctx
          this.name = serviceName
        }
      }
    },
    '@deepseek-ai/dsh-client-store': {
      defineStore: (spec) => {
        // The real defineStore returns a callable store handle carrying the spec.
        const handle = () => spec
        handle.spec = spec
        return handle
      }
    },
    '@deepseek-ai/dsh-client-ui-primitives': primitives
  }
  return (specifier) => {
    if (!(specifier in modules)) throw new Error(`unexpected require: ${specifier}`)
    return modules[specifier]
  }
}

/** Load the bundle through a ModuleLoader capture and return its exports. */
function loadBundle() {
  let definition
  const window = {
    __ModuleLoader__: {
      load(def) {
        definition = def
      }
    },
    setInterval: () => 1,
    clearInterval: noop_clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  function noop_clearInterval() {}
  new Function('window', code)(window)
  assert.ok(definition, 'ModuleLoader.load captured')
  assert.equal(definition.id, '@xsj/dsh-favourite')
  const exports = definition.factory(buildRequire())
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  return { exports, window }
}

/** Mock client context: slots/remote/locale/effect capture. */
function mockClientCtx() {
  const registrations = []
  const slotInjects = []
  const providedRoot = []
  const locales = []
  const effects = []
  const sessionsService = {
    list: {
      getSnapshot: () => ({ phase: 'pending', ids: [], byId: {}, current: undefined }),
      subscribe: () => () => {}
    },
    searchResultLimit: 20,
    search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    binding: () => undefined,
    open: () => {},
    clear: () => {},
    create: async () => 'session-x',
    fork: async () => 'session-fork'
  }
  const workspacesService = {
    list: {
      getSnapshot: () => ({ phase: 'pending', items: [], archivedSessionIds: [] }),
      subscribe: () => () => {}
    },
    rename: async () => {},
    delete: async () => {},
    insertBefore: async () => [],
    insertSessionBefore: async () => {},
    create: async (input) => ({ workspaceId: 'ws-new', ...input })
  }
  const uiWorkspaceService = {
    openSession: () => {},
    startSession: () => {},
    forkSession: async () => 'session-fork',
    archiveSession: async () => {},
    connectWorkspace: async () => 'session-blank'
  }
  const ctx = {
    uiWorkspace: uiWorkspaceService,
    get(service) {
      if (service === 'sessions') return sessionsService
      if (service === 'workspaces') return workspacesService
      if (service === 'layout') return { selectPanel: () => {}, beginNavigation: () => new AbortController().signal }
      throw new Error(`unexpected ctx.get(${service})`)
    },
    remote: {
      directoryPicker: {
        pick: async () => ({ ok: false, error: { code: 'cancelled', message: 'stub' } }),
        list: async () => ({ ok: false, error: { code: 'x', message: 'stub' } })
      },
      $host: { home: '/home/tester' }
    },
    slots: {
      provideRoot(share) {
        providedRoot.push(share)
      },
      inject(slotName, factory) {
        slotInjects.push(slotName)
        factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
      entries: () => [],
      subscribe: () => () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries })
        return () => {}
      }
    },
    effect(fn, label) {
      const result = fn()
      effects.push({ label, result })
      return result
    },
    on: () => () => {},
    _registrations: registrations,
    _slotInjects: slotInjects,
    _providedRoot: providedRoot,
    _locales: locales,
    _effects: effects
  }
  return ctx
}

test('client bundle registers under its own id with the expected shape', () => {
  const { exports } = loadBundle()
  assert.equal(exports.name ?? 'dsh-favourite', 'dsh-favourite')
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout', 'uiWorkspace'])
})

test('apply registers the shadowed browser and the favorites locale', () => {
  const { exports } = loadBundle()
  const ctx = mockClientCtx()
  const result = exports.apply(ctx)
  assert.equal(result, undefined)
  assert.deepEqual(ctx._slotInjects, ['sidebar.workspaces'])
  assert.equal(ctx._registrations.length, 1)
  const { options, component } = ctx._registrations[0]
  assert.equal(options.name, 'sidebar.workspaces')
  assert.equal(options.priority, -1, 'shadows the shipped browser')
  assert.equal(options.children, undefined, 'declares no child slots')
  assert.equal(options.locale, 'workspaceFav')
  assert.equal(component.name, 'WorkspaceBrowser')
  // Store factory carries the favorites view flags and star color setting.
  const storeSpec = options.store()
  const initialState = storeSpec.init()
  assert.equal(initialState.favoritesOnly, false)
  assert.equal(initialState.hideUnfavorited, false)
  assert.equal(initialState.starColor, '')
  assert.equal(typeof storeSpec.actions.setFavoritesOnly, 'function')
  assert.equal(typeof storeSpec.actions.setHideUnfavorited, 'function')
  assert.equal(typeof storeSpec.actions.setStarColor, 'function')
  assert.equal(storeSpec.persist, 'dsh.favorites.view.v2')
  // The two display modes are mutually exclusive.
  const draft = storeSpec.init()
  storeSpec.actions.setHideUnfavorited(draft, true)
  assert.equal(draft.hideUnfavorited, true)
  storeSpec.actions.setFavoritesOnly(draft, true)
  assert.equal(draft.favoritesOnly, true)
  assert.equal(draft.hideUnfavorited, false)
  storeSpec.actions.setStarColor(draft, '#e5484d')
  assert.equal(draft.starColor, '#e5484d')
  // Locale registered with the fav keys in both dictionaries.
  assert.equal(ctx._locales.length, 1)
  assert.equal(ctx._locales[0].namespace, 'workspaceFav')
  for (const language of ['zh', 'en']) {
    const dictionary = ctx._locales[0].dictionaries[language]
    for (const key of ['fav.star', 'fav.unstar', 'fav.pin', 'fav.unpin', 'fav.filter', 'fav.hide', 'fav.section', 'fav.starColor', 'fav.color.gold', 'fav.meta.workspace', 'fav.meta.ungrouped', 'session.new', 'group.ungrouped', 'menu.fork']) {
      assert.ok(typeof dictionary[key] === 'string', `${language}.${key} present`)
    }
  }
})

test('injected browser face carries favorites actions and hooks', () => {
  const { exports } = loadBundle()
  const ctx = mockClientCtx()
  exports.apply(ctx)
  const { options } = ctx._registrations[0]
  const injected = options.inject()
  for (const key of ['startSession', 'open', 'searchSessions', 'renameSession', 'forkSession', 'renameWorkspace', 'deleteWorkspace', 'insertWorkspaceBefore', 'archiveSession', 'insertSessionBefore', 'createWorkspace', 'pickDirectory', 'toggleFavorite', 'setPinned']) {
    assert.equal(typeof injected[key], 'function', `injected ${key}`)
  }
  assert.equal(typeof injected.searchResultLimit, 'number')
  assert.equal(typeof injected.hooks.hostInfo.getSnapshot, 'function')
  const favorites = injected.hooks.favorites
  assert.equal(typeof favorites.getSnapshot, 'function')
  assert.equal(typeof favorites.subscribe, 'function')
  assert.equal(typeof favorites.toggleFavorite, 'function')
  assert.equal(typeof favorites.setPinned, 'function')
  const snapshot = favorites.getSnapshot()
  assert.deepEqual(snapshot, { ready: false, sessions: {}, workspaces: {} })
})

test('favorites source reflects host mutations through its snapshot', async () => {
  const { exports } = loadBundle()
  const ctx = mockClientCtx()
  exports.apply(ctx)
  const { options } = ctx._registrations[0]
  const favorites = options.inject().hooks.favorites
  // Serve a mutated document from a stubbed fetch.
  const originalFetch = globalThis.fetch
  let document = { sessions: { s1: { favorite: true, pinned: false, ts: 1 } }, workspaces: {} }
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: 1, sessions: document.sessions, workspaces: document.workspaces })
  })
  try {
    let notified = 0
    const unsubscribe = favorites.subscribe(() => {
      notified += 1
    })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(notified >= 1, 'subscribe emitted after first refresh')
    assert.equal(favorites.getSnapshot().ready, true)
    assert.deepEqual(Object.keys(favorites.getSnapshot().sessions), ['s1'])
    // toggleFavorite round trip through the stub.
    let posted
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') {
        posted = { url, body: JSON.parse(init.body) }
        if (url.endsWith('/toggle')) {
          document = { sessions: {}, workspaces: {} }
        }
      }
      return {
        ok: true,
        json: async () => ({ version: 1, sessions: document.sessions, workspaces: document.workspaces })
      }
    }
    await favorites.toggleFavorite('session', 's1')
    assert.equal(posted.body, undefined ?? posted.body, 'posted captured')
    assert.deepEqual(posted.body, { kind: 'session', id: 's1' })
    assert.deepEqual(favorites.getSnapshot().sessions, {})
    unsubscribe()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pickDirectory surfaces a readable failure', async () => {
  const { exports } = loadBundle()
  const ctx = mockClientCtx()
  exports.apply(ctx)
  const { options } = ctx._registrations[0]
  await assert.rejects(() => options.inject().pickDirectory(), /directory pick failed: cancelled/)
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})
