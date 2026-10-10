/**
 * Mode-behavior verification against the running virtual DSH.
 * Rows are located by data-dsh-session-id, so renames cannot break the checks.
 *
 * Usage: node test/mode-check.mjs <token> <parentSessionId> <plainSessionId>
 */
import { createRequire } from 'node:module'
const req = createRequire('Z:/workspace1/plugins/dsh-better-sidebar/package.json')
const { chromium } = req('@playwright/test')

const [, , token, parentId, plainId] = process.argv
console.log('[argv] parent:', parentId?.slice(0, 13), '| plain:', plainId?.slice(0, 13))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1480, height: 940 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)))
// The harness occasionally answers early page API calls with 401/404 on the
// very first load; reload until the favorites browser actually mounts.
let mounted = false
for (let attempt = 0; attempt < 4 && !mounted; attempt++) {
  await page.goto(`http://127.0.0.1:34411/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
  mounted = await page.waitForSelector('[data-dsh-favourite-browser]', { timeout: 25000 }).then(() => true).catch(() => false)
  if (!mounted) console.log(`[retry] browser not mounted on attempt ${attempt + 1}; reloading`)
}
// Dismiss the first-run API-key onboarding modal: it can mount later than the
// browser marker, so poll for the 稍后配置 button until it no longer appears.
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
  if (!clicked) {
    if (i >= 2) break
  }
  await page.waitForTimeout(800)
}

const rowOf = (id) => page.locator(`[data-dsh-session-id="${id}"]`).first()
const rowCount = async (id) => page.locator(`[data-dsh-session-id="${id}"]`).count()
const menuPick = async (label) => {
  await page.locator('button[aria-label="视图选项"], button[aria-label="View options"]').first().click()
  await page.waitForTimeout(350)
  await page.getByRole('menuitem', { name: label }).first().click()
  await page.waitForTimeout(400)
}

// ── reset: nothing favorited, nothing pinned ────────────────────────────────
await page.evaluate(async () => {
  const get = async () => (await fetch('/api/dsh-favourite', { cache: 'no-store' })).json()
  let state = await get()
  for (const id of Object.keys(state.sessions)) {
    await fetch('/api/dsh-favourite/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'session', id }) })
  }
  for (const id of Object.keys(state.workspaces)) {
    await fetch('/api/dsh-favourite/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'workspace', id }) })
  }
  state = await get()
  return state
})
// Expand the ws-demo group, then star the parent session via the API and wait
// for the client's favorites source to catch up (2s poll). The parent may sit
// beyond the 5-row collapse limit, so starring through the row is not reliable.
await page.evaluate(() => {
  const g = [...document.querySelectorAll('div[role="treeitem"]')].find((e) => e.textContent.includes('ws-demo'))
  if (g !== undefined && g.getAttribute('aria-expanded') !== 'true') g.click()
})
await page.waitForTimeout(400)
await page.evaluate(async (pid) => {
  await fetch('/api/dsh-favourite/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'session', id: pid }) })
}, parentId)
await page.waitForFunction((pid) => {
  return fetch('/api/dsh-favourite', { cache: 'no-store' }).then((r) => r.json()).then((s) => s.sessions[pid] !== undefined && Object.keys(s.workspaces).length === 0)
}, parentId, { timeout: 15000 })
await page.waitForTimeout(2300)

const checks = []
/** Expand every "show N more" overflow — never the collapse ("收起") button,
 * which appears on already-expanded groups and would re-fold them. */
const expandOverflow = async () => {
  for (let i = 0; i < 3; i++) {
    const buttons = page.locator('button[class*="sessionOverflowButton"]', { hasText: /展开其余|Show \d+ more/ })
    const count = await buttons.count()
    if (count === 0) return
    for (let b = 0; b < count; b++) await buttons.nth(b).click().catch(() => {})
    await page.waitForTimeout(250)
  }
}
const verify = async (label, expectPlainVisible, { fullView = false } = {}) => {
  if (expectPlainVisible && fullView) await expandOverflow()
  let count = await rowCount(plainId)
  if (expectPlainVisible && count === 0) {
    // Tolerate a transient re-render between the mode switch and the query.
    await page.waitForTimeout(800)
    count = await rowCount(plainId)
  }
  checks.push([`${label}: plain ${expectPlainVisible ? 'visible' : 'hidden'}`, expectPlainVisible ? count > 0 : count === 0])
}
const verifyParentVisible = async (label) => {
  checks.push([`${label}: favorited session visible`, (await rowCount(parentId)) > 0])
}

// 隐藏未收藏: unfavorited workspace holding a favorited session shows header + favorited only.
await menuPick('隐藏未收藏')
await page.waitForTimeout(2300)
await verify('hide', false)
await verifyParentVisible('hide')
checks.push(['hide: ws-demo header visible', await page.locator('div[role="treeitem"]', { hasText: 'ws-demo' }).count() > 0])

// 全部显示 restores.
await menuPick('全部显示')
await page.waitForTimeout(400)
await verify('show-all', true, { fullView: true })

// 只看收藏 (workspace unfavorited): the favorited session becomes a loose
// top-level row; its (unfavorited) workspace header stays hidden.
await menuPick('只看收藏')
await page.waitForTimeout(2300)
await verify('fav-only', false)
await verifyParentVisible('fav-only')
checks.push(['fav-only: ws-demo header hidden (unfavorited ws not shown)', await page.locator('div[role="treeitem"][aria-expanded]', { hasText: 'ws-demo' }).count() === 0])
// Star the workspace → it appears as an expandable group; the loose row folds
// into the expansion (no duplicate); expanding shows ALL its sessions.
import { readFileSync } from 'node:fs'
const wsRegistry = JSON.parse(readFileSync('Z:/workspace1/.fav-test/dsh-home/storages/workspace.json', 'utf8'))
const favoredWsId = Object.entries(wsRegistry.tables.workspaces).find(([, record]) => String(record.path).endsWith('ws-demo'))?.[0]
  ?? Object.keys(wsRegistry.tables.workspaces)[0]
await page.evaluate(async (wid) => {
  await fetch('/api/dsh-favourite/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'workspace', id: wid }) })
}, favoredWsId)
await page.waitForTimeout(2300)
// The group may already be expanded (auto-expand from the blank session) — the
// parent then renders inside it exactly once, never as a loose duplicate.
checks.push(['fav-only + ws star: parent appears exactly once (no duplicate loose row)', (await rowCount(parentId)) === 1])
const wsHeader = page.locator('div[role="treeitem"][aria-expanded]', { hasText: 'ws-demo' }).first()
checks.push(['fav-only + ws star: ws-demo header visible', await wsHeader.count() > 0])
if (await wsHeader.getAttribute('aria-expanded') !== 'true') await wsHeader.click()
await page.waitForTimeout(500)
checks.push(['fav-only + ws star: expansion shows ALL sessions (plain visible)', (await rowCount(plainId)) > 0])
await menuPick('只看收藏')
await page.waitForTimeout(400)
await verify('fav uncheck', true, { fullView: true })

// favorited workspace + hide: ALL sessions visible (structure kept).
await menuPick('隐藏未收藏')
await page.waitForTimeout(2300)
await verify('ws-fav hide', true)
checks.push(['ws-fav hide: no overflow button (modes bypass the limit)', await page.locator('button[class*="sessionOverflowButton"]').count() === 0])

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${label}`)
  if (!ok) failed += 1
}
console.log(failed === 0 ? '\nALL MODE CHECKS PASSED' : `\n${failed} MODE CHECKS FAILED`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
