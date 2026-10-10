/**
 * UI-level end-to-end test: drives the real virtual DSH in headless Chrome
 * (system channel) and verifies the favorites browser end to end:
 *   - star a session / star a workspace from the UI (host store reflects it)
 *   - requirement 2: 只看收藏 shows favorited rows only
 *   - requirement 5: 隐藏未收藏 keeps the workspace structure — favorited
 *     workspace shows ALL sessions; unfavorited workspace with favorited
 *     members shows only those; both toggles live in the view-options menu
 *   - requirement 3: pin renders the single-row form (no workspace name),
 *     hover reveals workspace + session meta
 *   - requirement 4: forking a pinned session inherits favorite + pinned
 *
 * Usage: node test/e2e-ui.mjs <baseUrl> <launchToken> <parentSessionId> <plainSessionId>
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const [, , baseUrlArg, tokenArg, parentSessionId, plainSessionId] = process.argv
if (baseUrlArg === undefined || tokenArg === undefined || parentSessionId === undefined || plainSessionId === undefined) {
  console.error('usage: node test/e2e-ui.mjs <baseUrl> <launchToken> <parentSessionId> <plainSessionId>')
  process.exit(2)
}
const base = baseUrlArg.replace(/\/+$/, '')
const PARENT_TITLE = '收藏演示会话 1'
const PLAIN_TITLE = '收藏演示会话 3'
const WS_TITLE = 'ws-demo'

const betterSidebarRequire = createRequire('Z:/workspace1/plugins/dsh-better-sidebar/package.json')
const { chromium } = betterSidebarRequire('@playwright/test')

/** Node-side RPC used only to prepare display titles before the UI checks. */
let rpcCounter = 0
async function authenticate() {
  const res = await fetch(`${base}/?token=${encodeURIComponent(tokenArg)}`, { redirect: 'manual' })
  const cookies = res.headers.getSetCookie?.() ?? []
  const auth = cookies.map((cookie) => cookie.split(';')[0]).filter((pair) => pair.startsWith('dsh-auth-'))
  assert.ok(auth.length > 0, 'auth cookie granted')
  return auth.join('; ')
}
async function rpc(cookie, endpoint, args) {
  rpcCounter += 1
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `ui-${rpcCounter}`, method: endpoint, payload: { args: { request: args } } })
  })
  return (await res.json()).result
}

const setupCookie = await authenticate()
for (const [id, title] of [[parentSessionId, PARENT_TITLE], [plainSessionId, PLAIN_TITLE]]) {
  const renamed = await rpc(setupCookie, 'session/rename', { sessionId: id, title })
  assert.equal(renamed.ok, true, `rename ${id}: ${JSON.stringify(renamed)}`)
}

const consoleErrors = []
const pageErrors = []
const results = []
const check = (label, fn) => {
  results.push({ label, fn })
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1480, height: 940 } })
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

const favoritesState = async () => page.evaluate(async () => (await fetch('/api/dsh-favourite', { cache: 'no-store' })).json())

/** Open the view-options menu and pick one of the localized item labels. */
async function viewMenuPick(labels) {
  const trigger = page.locator('button[aria-label="视图选项"], button[aria-label="View options"]').first()
  await trigger.click()
  for (const label of labels) {
    const item = page.getByRole('menuitem', { name: label }).first()
    if (await item.isVisible({ timeout: 1000 }).catch(() => false)) {
      await item.click()
      return label
    }
  }
  throw new Error(`view menu item none of [${labels.join(', ')}] visible`)
}

/** Open a row's actions menu (⋯) and pick one of the localized labels. */
async function rowMenuAction(row, labels) {
  await row.hover()
  const anchor = row.locator('button[aria-label*="操作"], button[aria-label*="actions" i]').first()
  await anchor.click()
  for (const label of labels) {
    const item = page.getByRole('menuitem', { name: label }).first()
    if (await item.isVisible({ timeout: 1000 }).catch(() => false)) {
      await item.click()
      return label
    }
  }
  throw new Error(`row menu item none of [${labels.join(', ')}] visible`)
}

const PIN = ['置顶', 'Pin to top']
const FORK = ['分叉会话', 'Fork session']
const FAV_ONLY = ['只看收藏', 'Favorites only']
const HIDE_UNFAV = ['隐藏未收藏', 'Hide unfavorites']

const parentRow = () => page.locator(`[data-dsh-session-id="${parentSessionId}"]`).first()
const plainRow = () => page.locator(`[data-dsh-session-id="${plainSessionId}"]`).first()
const groupRow = () => page.locator('div[role="treeitem"]', { hasText: WS_TITLE }).first()
/** Expand every "show N more" overflow — full view folds long groups at 5 rows. */
const expandOverflow = async () => {
  for (let i = 0; i < 3; i++) {
    const buttons = page.locator('button[class*="sessionOverflowButton"]', { hasText: /展开其余|Show \d+ more/ })
    const count = await buttons.count()
    if (count === 0) return
    for (let b = 0; b < count; b++) await buttons.nth(b).click().catch(() => {})
    await page.waitForTimeout(250)
  }
}

// ── scenario ────────────────────────────────────────────────────────────────
check('page loads and the favorites browser renders', async () => {
  await page.goto(`${base}/?token=${encodeURIComponent(tokenArg)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-dsh-favourite-browser]', { timeout: 45000 })
  // Dismiss the first-run "add an API key" onboarding modal: it can mount
  // later than the browser marker, so poll for the 稍后配置 button.
  await page.waitForTimeout(1200)
  for (let i = 0; i < 10; i++) {
    const clicked = await page.evaluate(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('稍后配置'))
      if (t !== undefined) {
        t.click()
        return true
      }
      return false
    })
    if (!clicked && i >= 2) break
    await page.waitForTimeout(800)
  }
})

check('workspace group expands; both sessions render', async () => {
  await groupRow().waitFor({ timeout: 20000 })
  // The auto-connected blank session may have expanded the group already.
  if (await groupRow().getAttribute('aria-expanded') !== 'true') await groupRow().click()
  await expandOverflow()
  await parentRow().waitFor({ timeout: 10000 })
  await plainRow().waitFor({ timeout: 10000 })
})

check('starring a session from the UI reaches the host store', async () => {
  const before = await favoritesState()
  if (before.sessions[parentSessionId] === undefined) {
    const row = parentRow()
    await row.hover()
    await row.locator('button.dsh-fav-star').first().click()
  }
  await page.waitForFunction((id) => {
    return fetch('/api/dsh-favourite', { cache: 'no-store' }).then((res) => res.json()).then((state) => state.sessions[id] !== undefined)
  }, parentSessionId, { timeout: 10000 })
})

check('requirement 2: 只看收藏 shows loose favorited sessions + favorited workspaces only', async () => {
  // Deterministic start: make sure the demo workspace is UNfavorited.
  const ws0 = await favoritesState()
  if (Object.keys(ws0.workspaces).length > 0) {
    const group = groupRow()
    await group.hover()
    await group.locator('button.dsh-fav-star').first().click()
    await page.waitForFunction(() => {
      return fetch('/api/dsh-favourite', { cache: 'no-store' }).then((res) => res.json()).then((state) => Object.keys(state.workspaces).length === 0)
    }, undefined, { timeout: 10000 })
  }
  await viewMenuPick(FAV_ONLY)
  await page.waitForTimeout(2300)
  // The favorited session appears as a loose top-level row…
  await parentRow().waitFor({ timeout: 8000 })
  // …the unfavorited session is gone…
  assert.equal(await plainRow().count(), 0, 'unfavorited session hidden under 只看收藏')
  // …and the unfavorited workspace header does not appear at all.
  assert.equal(await page.locator('div[role="treeitem"][aria-expanded]', { hasText: WS_TITLE }).count(), 0, 'unfavorited workspace header hidden')
  await viewMenuPick(FAV_ONLY) // toggle back off
  await expandOverflow()
  await plainRow().waitFor({ timeout: 8000 })
})

check('requirement 5: 隐藏未收藏 keeps structure; favorited workspace shows all', async () => {
  await viewMenuPick(HIDE_UNFAV)
  await page.waitForTimeout(500)
  await groupRow().waitFor({ timeout: 8000 })
  // Deterministic start: make sure the demo workspace is UNfavorited.
  const ws0 = await favoritesState()
  if (Object.keys(ws0.workspaces).length > 0) {
    const group = groupRow()
    await group.hover()
    await group.locator('button.dsh-fav-star').first().click()
    await page.waitForFunction(() => {
      return fetch('/api/dsh-favourite', { cache: 'no-store' }).then((res) => res.json()).then((state) => Object.keys(state.workspaces).length === 0)
    }, undefined, { timeout: 10000 })
  }
  await page.waitForTimeout(400)
  // Unfavorited workspace holding a favorited session: header shown, favorited sessions only.
  await groupRow().waitFor({ timeout: 8000 })
  assert.equal(await plainRow().count(), 0, 'unfavorited session hidden inside the unfavorited workspace')
  // Star the workspace from the UI: the group now shows ALL of its sessions.
  const group = groupRow()
  await group.hover()
  await group.locator('button.dsh-fav-star').first().click()
  await page.waitForFunction(() => {
    return fetch('/api/dsh-favourite', { cache: 'no-store' }).then((res) => res.json()).then((state) => Object.keys(state.workspaces).length > 0)
  }, undefined, { timeout: 10000 })
  await expandOverflow()
  await plainRow().waitFor({ timeout: 8000 })
  // Back to the full list.
  await viewMenuPick(HIDE_UNFAV)
  await page.waitForTimeout(400)
})

check('requirement 3: pin renders the single-row form without the workspace name', async () => {
  const existing = page.locator(`[data-dsh-fav-pinned-block="session"] [data-dsh-session-id="${parentSessionId}"]`)
  if (await existing.count() === 0) {
    const row = parentRow()
    await rowMenuAction(row, PIN)
  }
  const pinnedBlock = page.locator('[data-dsh-fav-pinned-block="session"]')
  await pinnedBlock.waitFor({ timeout: 10000 })
  const pinnedRow = pinnedBlock.locator(`[data-dsh-session-id="${parentSessionId}"]`).first()
  const pinnedText = await pinnedRow.textContent()
  assert.ok(!pinnedText.includes(WS_TITLE), `pinned row must not show the workspace name, got: ${pinnedText}`)
  assert.ok(pinnedText.includes('收藏演示会话'), `pinned row shows the session title, got: ${pinnedText}`)
})

check('requirement 3: hovering the pinned row reveals workspace + session meta', async () => {
  const pinnedRow = page.locator('[data-dsh-fav-pinned-block="session"] div[role="treeitem"]').first()
  await pinnedRow.hover()
  const hoverContent = page.locator('[class*="hoverContent"]', { hasText: 'ws-demo' }).first()
  await hoverContent.waitFor({ timeout: 8000 })
  const metaText = await hoverContent.textContent()
  assert.ok(metaText.includes('收藏演示会话'), `hover meta shows the session title: ${metaText}`)
  assert.ok(metaText.includes('ws-demo'), `hover meta mentions the workspace: ${metaText}`)
})

check('requirement 4: forking the pinned session inherits favorite + pinned', async () => {
  const before = await favoritesState()
  const pinnedRow = page.locator('[data-dsh-fav-pinned-block="session"] div[role="treeitem"]').first()
  await rowMenuAction(pinnedRow, FORK)
  const childHandle = await page.waitForFunction(([parentId, previous]) => {
    return fetch('/api/dsh-favourite', { cache: 'no-store' }).then((res) => res.json()).then((state) => {
      const child = Object.entries(state.sessions).find(([id, entry]) => entry.inheritedFrom === parentId && previous[id] === undefined)
      return child === undefined ? null : child
    })
  }, [parentSessionId, before.sessions], { timeout: 20000 }).catch(() => null)
  // Tolerate a transient read between the fork RPC and the inherited entry.
  let child = null
  for (let attempt = 0; attempt < 10 && child === null; attempt++) {
    const after = await favoritesState()
    child = Object.entries(after.sessions).find(([id, entry]) => entry.inheritedFrom === parentSessionId && before.sessions[id] === undefined) ?? null
    if (child === null) await page.waitForTimeout(500)
  }
  if (child === null) {
    const after = await favoritesState()
    console.log('    diagnose: after =', JSON.stringify(after))
  }
  assert.ok(child, 'fork child present in the favorites store')
  assert.equal(child[1].favorite, true)
  assert.equal(child[1].pinned, true, 'pinned inherited')
})

check('star color setting is applied to the browser root', async () => {
  await viewMenuPick(['红色', 'Red'])
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-dsh-favourite-browser]')
    return root !== null && root.style.getPropertyValue('--dsh-fav-star-color') === '#e5484d'
  }, undefined, { timeout: 8000 })
  await viewMenuPick(['金黄', 'Gold'])
})

check('no plugin errors in the page console', async () => {
  const relevant = [...consoleErrors, ...pageErrors].filter((text) => /dsh-favourite|ModuleLoader|Failed to load/i.test(text))
  assert.deepEqual(relevant, [], `console/page errors: ${JSON.stringify(relevant)}`)
})

// ── runner ──────────────────────────────────────────────────────────────────
let failed = 0
try {
  for (let index = 0; index < results.length; index++) {
    const { label, fn } = results[index]
    try {
      await fn()
      console.log(`✔ ${label}`)
    } catch (error) {
      failed += 1
      console.log(`✖ ${label}`)
      console.log(String(error?.stack ?? error).split('\n').slice(0, 8).map((line) => `    ${line}`).join('\n'))
    }
  }
} finally {
  await browser.close()
}
console.log(failed === 0 ? '\nALL UI CHECKS PASSED' : `\n${failed} UI CHECKS FAILED`)
process.exit(failed === 0 ? 0 : 1)
