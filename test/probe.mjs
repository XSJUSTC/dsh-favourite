// Minimal probe: does the favorites browser marker appear? Capture console.
import { createRequire } from 'node:module'
const req = createRequire('Z:/workspace1/plugins/dsh-better-sidebar/package.json')
const { chromium } = req('@playwright/test')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1480, height: 940 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 400)) })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)))
await page.goto('http://127.0.0.1:34411/?token=x01tPtaFXDdn1Xt06mFNG61x0Qf4pymGKU6_FQcj2Zs', { waitUntil: 'domcontentloaded' })
try {
  await page.waitForSelector('[data-dsh-favorites-browser]', { timeout: 30000 })
  console.log('marker: TRUE')
} catch {
  console.log('marker: FALSE')
}
const titles = await page.evaluate(() => [...document.querySelectorAll('div[role="treeitem"]')].map((e) => e.textContent.slice(0, 16)))
console.log('rows:', JSON.stringify(titles))
await browser.close()
