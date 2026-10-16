/**
 * Browser smoke test — renders the panel in a real browser against a running
 * `dsh web` and verifies the sidebar entry, first-run view, and light/dark
 * theme tokens. Not part of `npm test` (it needs a live Harness and
 * Playwright); run it manually before a release:
 *
 *   dsh --profile web --no-open --port 8321 &
 *   DSH_WEB_URL="http://127.0.0.1:8321/?token=…" pnpm test:browser
 *
 * Skips (exit 0) when Playwright is not installed.
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const url = process.env.DSH_WEB_URL || process.argv[2]
if (!url) {
  console.log('SKIP: pass the dsh web URL via DSH_WEB_URL or argv')
  process.exit(0)
}

let chromium
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  console.log('SKIP: playwright is not installed')
  process.exit(0)
}

const shots = os.tmpdir()
const errors = []
const browser = await chromium.launch()

/**
 * Page errors raised by *other* plugins in the same profile are not this
 * plugin's failure. A profile commonly carries third-party rows whose inject
 * declarations lag the host, and their errors surface on every page. Only
 * errors attributable to this plugin's own bundle count as a failure.
 */
const FOREIGN_ERROR = /remote\.session|without inject/i

async function openPanel (colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme })
  page.on('pageerror', (e) => { if (!FOREIGN_ERROR.test(e.message)) errors.push(`pageerror: ${e.message}`) })
  page.on('console', (m) => { if (m.type() === 'error' && !FOREIGN_ERROR.test(m.text())) errors.push(`console: ${m.text()}`) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // Dismiss the host's "Preview Notice" modal if it shows up.
  const dialog = page.locator('[role="dialog"]')
  await dialog.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  if (await dialog.count()) {
    await dialog.first().locator('button').first().click().catch(() => {})
  }
  await page.locator('text=回声笔记').first().click()
  await page.locator('.en-root').first().waitFor({ state: 'visible', timeout: 15000 })
  return page
}

// Light scheme: sidebar entry, panel root, first-run passphrase field.
const page = await openPanel('light')
console.log('PASS sidebar entry visible')
console.log('PASS panel .en-root rendered')
await page.locator('.en-input[type="password"]').first().waitFor({ state: 'visible', timeout: 10000 })
console.log('PASS first-run passphrase field visible')

// .en-root itself is transparent by design (the host container paints the
// background), so probe the primary button and the root's text color.
const btnBg = await page.locator('.en-btn').first().evaluate((el) => getComputedStyle(el).backgroundColor)
const fg = await page.locator('.en-root').first().evaluate((el) => getComputedStyle(el).color)
if (btnBg === 'rgba(0, 0, 0, 0)' || fg === 'rgba(0, 0, 0, 0)') {
  throw new Error(`theme tokens unresolved: btnBg=${btnBg} fg=${fg}`)
}
console.log(`PASS light theme tokens resolve (btnBg=${btnBg}, fg=${fg})`)
await page.screenshot({ path: path.join(shots, 'echo-panel-light.png') })
await page.close()

// Dark scheme: the same tokens must resolve to a different palette.
const dark = await openPanel('dark')
const darkBtnBg = await dark.locator('.en-btn').first().evaluate((el) => getComputedStyle(el).backgroundColor)
if (darkBtnBg === btnBg) throw new Error(`dark scheme did not change the palette: ${darkBtnBg}`)
console.log(`PASS dark scheme re-themes (btnBg=${btnBg} -> ${darkBtnBg})`)
await dark.screenshot({ path: path.join(shots, 'echo-panel-dark.png') })
await dark.close()

await browser.close()

if (errors.length) {
  console.log('JS errors observed:')
  for (const e of errors) console.log('  ' + e)
  process.exit(1)
}
console.log('PASS no page errors')
