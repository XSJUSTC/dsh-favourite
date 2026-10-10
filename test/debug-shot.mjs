import { createRequire } from 'node:module'
const req = createRequire('Z:/workspace1/plugins/dsh-better-sidebar/package.json')
const { chromium } = req('@playwright/test')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1480, height: 940 } })
await page.goto('http://127.0.0.1:34411/?token=N08pD4qKx8kE9vWPiM8mwUPklnVjSVLh8gw4Pn5l3iY', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-dsh-favourite-browser]', { timeout: 45000 })
await page.waitForTimeout(1200)
for (let i = 0; i < 10; i++) {
  const clicked = await page.evaluate(() => { const t = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('稍后配置')); if (t !== undefined) { t.click(); return true } return false })
  if (!clicked && i >= 2) break
  await page.waitForTimeout(800)
}
await page.locator('button[aria-label="视图选项"]').click()
await page.waitForTimeout(350)
await page.getByRole('menuitem', { name: '只看收藏' }).first().click()
await page.waitForTimeout(2300)
await page.screenshot({ path: 'Z:/workspace1/.fav-test/final-favonly.png' })
await browser.close()
console.log('saved')
