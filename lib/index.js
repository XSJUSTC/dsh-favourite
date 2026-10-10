/**
 * dsh-favourite — Host half.
 *
 * Registers three same-origin HTTP routes backing the client favorites store,
 * listens for forked sessions to inherit the parent's favorite state, and
 * persists everything to one JSON file under the DSH home.
 *
 * Storage model: `<DSH_HOME>/storages/dsh-favourite.json`
 *   { version, sessions: { [sessionId]: entry }, workspaces: { [workspaceId]: entry } }
 *   entry = { favorite: true, pinned: boolean, ts, pinnedAt?, inheritedFrom? }
 * Presence in a map means "favorited"; removal means "unfavorited".
 *
 * Fork inheritance (requirement 4): on `session/created`, a seeded child whose
 * header carries `parentSession` (and is not a subagent child) copies the
 * parent's entry — favorite plus its pinned flag — at fork time. A parent that
 * was not favorited leaves the child unfavorited (the default state).
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-favourite'

/** Hard dependency: routes cannot exist without the web server. */
export const inject = ['webServer']

/** Route prefix, matching the client half exactly. */
export const API = '/api/dsh-favourite'

/** Body cap for the JSON RPC routes (mirrors the harness plugin convention). */
const BODY_LIMIT = 64 * 1024

/** Resolve the DSH home the same way the harness default does: $DSH_HOME, then ~/.dsh. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(homedir(), '.dsh')
}

/** Favorites file path inside the resolved home. */
function storageFile() {
  return path.join(dshHome(), 'storages', 'dsh-favourite.json')
}

/**
 * An empty favorites document.
 * @returns the empty state object.
 */
function emptyState() {
  return { version: 1, sessions: {}, workspaces: {} }
}

/**
 * Normalize one stored entry to the durable shape.
 * @param value - raw parsed entry.
 * @returns the normalized entry, or undefined when unusable.
 */
function normalizeEntry(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const pinned = value.pinned === true
  const ts = typeof value.ts === 'number' && Number.isFinite(value.ts) ? value.ts : Date.now()
  const entry = { favorite: true, pinned, ts }
  if (pinned && typeof value.pinnedAt === 'number' && Number.isFinite(value.pinnedAt)) entry.pinnedAt = value.pinnedAt
  if (typeof value.inheritedFrom === 'string' && value.inheritedFrom !== '') entry.inheritedFrom = value.inheritedFrom
  return entry
}

/**
 * Load and validate the persisted document; any defect falls back to empty.
 * @param file - storage file path.
 * @returns the loaded favorites state.
 */
async function loadState(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return emptyState()
    const state = emptyState()
    for (const kind of ['sessions', 'workspaces']) {
      const bucket = parsed[kind]
      if (typeof bucket !== 'object' || bucket === null) continue
      for (const [id, entry] of Object.entries(bucket)) {
        if (typeof id !== 'string' || id === '') continue
        const normalized = normalizeEntry(entry)
        if (normalized !== undefined) state[kind][id] = normalized
      }
    }
    return state
  } catch {
    return emptyState()
  }
}

/**
 * Create the favorites service: one in-memory state, atomic file persistence,
 * and the fork-inheritance listener.
 * @param ctx - Cordis context (used for the session/created event and logging).
 * @returns the service object with state access and mutators.
 */
function createFavoritesService(ctx) {
  const file = storageFile()
  let state = emptyState()
  let persistChain = Promise.resolve()

  /** Schedule one atomic persist; chains behind prior writes. */
  function persist() {
    persistChain = persistChain.then(async () => {
      const dir = path.dirname(file)
      await mkdir(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await rename(tmp, file)
    }).catch((error) => {
      console.warn('[dsh-favourite] persist failed:', error)
    })
    return persistChain
  }

  const service = {
    /** Current persisted-adjacent snapshot (owned plain data, safe to serialize). */
    snapshot() {
      return {
        version: state.version,
        sessions: { ...state.sessions },
        workspaces: { ...state.workspaces }
      }
    },
    /** Whether an id is favorited in a bucket. */
    isFavorited(kind, id) {
      const bucket = kind === 'workspace' ? state.workspaces : state.sessions
      return bucket[id] !== undefined
    },
    /** Toggle favorite membership for one id. @returns the resulting favorited boolean. */
    async toggle(kind, id) {
      const bucket = kind === 'workspace' ? state.workspaces : state.sessions
      if (bucket[id] !== undefined) delete bucket[id]
      else bucket[id] = { favorite: true, pinned: false, ts: Date.now() }
      await persist()
      return bucket[id] !== undefined
    },
    /** Set the pinned flag; pinning requires an existing favorite. @returns true when the state changed. */
    async setPinned(kind, id, pinned) {
      const bucket = kind === 'workspace' ? state.workspaces : state.sessions
      const entry = bucket[id]
      if (entry === undefined) return false
      const next = pinned === true
      if (entry.pinned === next) return false
      entry.pinned = next
      if (next) entry.pinnedAt = Date.now()
      else delete entry.pinnedAt
      await persist()
      return true
    },
    /** Copy the parent's favorite state onto a forked child (fork-time inheritance). */
    inheritFromParent(childId, parentId) {
      const parent = state.sessions[parentId]
      if (parent === undefined) return false
      state.sessions[childId] = {
        favorite: true,
        pinned: parent.pinned === true,
        ts: Date.now(),
        ...(parent.pinned === true && typeof parent.pinnedAt === 'number' ? { pinnedAt: parent.pinnedAt } : {}),
        inheritedFrom: parentId
      }
      persist()
      return true
    }
  }

  /**
   * Fork inheritance: a published session whose header names a parent and is
   * seeded (an ordinary fork, not a subagent child) inherits the parent's
   * favorite state as it stood at fork time. Unfavorited parents leave the
   * child at the default (unfavorited) state.
   */
  ctx.effect(() => ctx.on('session/created', (session) => {
    try {
      const header = session?.header
      if (header === undefined || header === null) return
      const parentId = header.parentSession
      if (typeof parentId !== 'string' || parentId === '') return
      if (header.origin === 'subagent') return
      if (header.delegationDepth !== undefined) return
      if (header.isSeeded !== true) return
      if (state.sessions[session.id] !== undefined) return
      if (service.inheritFromParent(session.id, parentId)) {
        console.info(`[dsh-favourite] fork inheritance: ${session.id} <- ${parentId}`)
      }
    } catch (error) {
      console.warn('[dsh-favourite] fork inheritance failed:', error)
    }
  }), 'dsh-favourite: fork inheritance')

  service._load = async () => {
    const loaded = await loadState(file)
    // Merge, never clobber: a mutation racing ahead of the initial read wins.
    for (const kind of ['sessions', 'workspaces']) {
      for (const [id, entry] of Object.entries(loaded[kind])) {
        if (state[kind][id] === undefined) state[kind][id] = entry
      }
    }
  }

  return service
}

/**
 * Read one JSON request body with a hard size cap.
 * @param req - incoming request.
 * @returns the parsed body, or undefined on any defect.
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        req.destroy()
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * Write one JSON response.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * Activate the plugin.
 * @param ctx - Cordis context.
 * @returns undefined (returning anything else is fatal under Cordis).
 */
export function apply(ctx) {
  const { webServer } = ctx
  const favorites = createFavoritesService(ctx)

  ctx.effect(() => {
    return favorites._load()
  }, 'dsh-favourite: initial load')

  const kinds = new Set(['session', 'workspace'])

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      writeJson(res, 200, { ok: true, ...favorites.snapshot() })
    }
  }), 'dsh-favourite: GET state')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/toggle`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body !== 'object' || body === null || !kinds.has(body.kind) || typeof body.id !== 'string' || body.id === '') {
        writeJson(res, 400, { ok: false, error: 'expected { kind: "session" | "workspace", id: string }' })
        return
      }
      const favorited = await favorites.toggle(body.kind, body.id)
      writeJson(res, 200, { ok: true, favorited, ...favorites.snapshot() })
    }
  }), 'dsh-favourite: POST toggle')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/pin`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body !== 'object' || body === null || !kinds.has(body.kind) || typeof body.id !== 'string' || body.id === '' || typeof body.pinned !== 'boolean') {
        writeJson(res, 400, { ok: false, error: 'expected { kind: "session" | "workspace", id: string, pinned: boolean }' })
        return
      }
      const changed = await favorites.setPinned(body.kind, body.id, body.pinned)
      if (!changed && !favorites.isFavorited(body.kind, body.id)) {
        writeJson(res, 409, { ok: false, error: 'only favorited items can be pinned' })
        return
      }
      writeJson(res, 200, { ok: true, changed, ...favorites.snapshot() })
    }
  }), 'dsh-favourite: POST pin')

  // POST /open-explorer — open a workspace directory in the OS file manager
  // WITH window focus. The harness's own open-in-app shell-open channel
  // launches detached, and detached explorer windows do not take the
  // foreground — so Windows goes through the Shell.Application COM (plus an
  // AppActivate fallback); darwin/linux use their foreground openers. The
  // path travels through an environment variable, never a command string.
  const openFocused = (dir) => {
    if (process.platform === 'win32') {
      // Focus strategy: the shell-open window cannot take the foreground from
      // a background process (Windows foreground lock), so after opening we
      // locate the new window via the Shell COM, then MINIMIZE + RESTORE it —
      // ShowWindow is not foreground-restricted, and a restore always raises
      // and activates the window. The path travels through an environment
      // variable, never a command string.
      const script = [
        '$p = $env:DSH_FAV_PATH',
        '$shell = New-Object -ComObject Shell.Application',
        '$shell.Open($p)',
        'Start-Sleep -Milliseconds 1200',
        'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class FavWin { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }\'',
        '$target = $null',
        'foreach ($w in $shell.Windows()) {',
        '  try {',
        '    $u = [System.Uri]::UnescapeDataString($w.LocationURL)',
        '    if ($u -ieq ("file:///" + $p.Replace("\\", "/"))) { $target = $w; break }',
        '  } catch {}',
        '}',
        'if ($target -ne $null -and $target.HWND) {',
        '  [FavWin]::ShowWindow($target.HWND, 6)',
        '  Start-Sleep -Milliseconds 120',
        '  [FavWin]::ShowWindow($target.HWND, 9)',
        '}'
      ].join('\n');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, DSH_FAV_PATH: dir },
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/open-explorer`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body?.path !== 'string' || body.path === '' || !path.isAbsolute(body.path)) {
        writeJson(res, 400, { ok: false, error: 'expected { path: absolute directory }' })
        return
      }
      try {
        const info = await stat(body.path)
        if (!info.isDirectory()) throw new Error('not a directory')
      } catch {
        writeJson(res, 400, { ok: false, error: 'path is not an existing directory' })
        return
      }
      openFocused(body.path)
      writeJson(res, 200, { ok: true })
    }
  }), 'dsh-favourite: POST open-explorer')

  // Expose the service for tests and sibling host code (read-only usage).
  // Called directly (not wrapped) — provide() manages its own lifetime, and
  // apply() must itself return undefined.
  ctx.provide('dshFavourite', {
    snapshot: () => favorites.snapshot(),
    toggle: (kind, id) => favorites.toggle(kind, id),
    setPinned: (kind, id, pinned) => favorites.setPinned(kind, id, pinned),
    isFavorited: (kind, id) => favorites.isFavorited(kind, id)
  })
}
