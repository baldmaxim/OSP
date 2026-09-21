// Помощник стенда: статический сервер в этом же процессе + Playwright.
//
//   import { openStand, fullPageShot, elementShot, tableMetrics } from './lib.mjs'
//   const s = await openStand({ variant: 'cur' })
//   await elementShot(s.page, '.main-content', 'C:/tmp/tp-cur.png')
//   console.log(await tableMetrics(s.page))
//   await s.close()
//
// Сервер отдаёт .tmp-preview/out/<variant>, а чего там нет — из public/
// (шрифты Inter по /fonts/inter/*).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const OUT = path.join(HERE, 'out')
const PUBLIC = path.join(REPO, 'public')
// /assets/fonts/* — локальная копия Google Fonts (кладёт build.mjs).
const ASSETS = path.join(HERE, 'assets')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

// Сборка Chromium от Playwright может быть не скачана (в проекте так и есть) —
// тогда берём системный Chrome или Edge, как это делают tests/tender.
export function browserLaunchOptions() {
  try {
    if (fs.existsSync(chromium.executablePath())) return {}
  } catch { /* сборка не скачана */ }
  const found = [
    process.env.PSDC_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find((p) => fs.existsSync(p))
  if (!found) throw new Error('Не найден браузер: поставьте `npx playwright install chromium` или задайте PSDC_BROWSER')
  return { executablePath: found }
}

// Один сервер на все варианты: /old/..., /cur/..., /new/...
export function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const candidates = []
    const rel = urlPath.replace(/^\/+/, '')
    candidates.push(path.join(OUT, rel || 'index.html'))
    if (!rel || rel.endsWith('/')) candidates.push(path.join(OUT, rel, 'index.html'))
    candidates.push(path.join(PUBLIC, rel))
    if (rel.startsWith('assets/')) candidates.push(path.join(ASSETS, rel.slice('assets/'.length)))

    for (const file of candidates) {
      if (!file.startsWith(OUT) && !file.startsWith(PUBLIC) && !file.startsWith(ASSETS)) continue
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        fs.createReadStream(file).pipe(res)
        return
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`404 ${urlPath}`)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/**
 * Открыть вариант стенда в браузере.
 * @param {object} o
 * @param {'old'|'cur'|'new'} o.variant
 * @param {string} [o.view] construction | materials | warranty | joint | other
 * @param {number} [o.width] ширина окна (по умолчанию 1720)
 * @param {number} [o.height] высота окна (по умолчанию 1000)
 * @param {string} [o.theme] light | dark
 * @param {string} [o.now] «сегодня» (ISO) или 'real'
 * @param {string} [o.role] роль в фейковом RoleContext
 * @param {boolean} [o.headless]
 * @param {object} [o.server] уже поднятый сервер (чтобы не плодить порты)
 */
export async function openStand(o = {}) {
  const {
    variant = 'cur', view = 'construction', width = 1720, height = 1000,
    theme = 'light', now, role, readonly, headless = true, server: given,
  } = o
  const server = given || await startServer()
  const browser = await chromium.launch({ ...browserLaunchOptions(), headless })
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  })
  const page = await context.newPage()

  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('requestfailed', (r) => {
    // Google Fonts может быть недоступен — это не ошибка стенда.
    if (!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) {
      errors.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`)
    }
  })

  const q = new URLSearchParams({ view, theme })
  if (now) q.set('now', now)
  if (role) q.set('role', role)
  if (readonly) q.set('readonly', '1')
  const url = `${server.url}/${variant}/index.html?${q}`

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__STAND_READY__ === true, null, { timeout: 30000 })
  // Таблица (или «нет данных») отрисована, шрифты доехали.
  await page.waitForSelector('.tenders-registry tbody tr, .tenders-page .no-data', { timeout: 30000 })
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(300) // ClampText меряет переполнение в ResizeObserver

  return {
    page,
    browser,
    context,
    server,
    url,
    errors,
    async close() {
      await browser.close()
      if (!given) await server.close()
    },
  }
}

export async function fullPageShot(page, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await page.screenshot({ path: file, fullPage: true })
  return file
}

// Снимок одного элемента (обычно '.main-content' — рабочая область без сайдбара).
export async function elementShot(page, selector, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await page.locator(selector).first().screenshot({ path: file })
  return file
}

// Замеры таблицы реестра: высоты строк, ширины колонок, переполнение по ширине.
export async function tableMetrics(page) {
  return page.evaluate(() => {
    const table = document.querySelector('.tenders-registry')
    if (!table) return null
    const container = table.closest('.table-container')
    const num = (x) => Math.round(x * 10) / 10
    const headCells = [...table.querySelectorAll('thead th')]
    const bodyRows = [...table.querySelectorAll('tbody > tr')]
      .filter((tr) => !tr.classList.contains('expanded-row'))

    const rows = bodyRows.map((tr) => {
      const cells = [...tr.children]
      // Плотный реестр: № и счётчик в одной ячейке; старый вид — отдельной.
      const numberCell = tr.querySelector('.tp-num-value') || tr.querySelector('.tp-num') || tr.firstElementChild
      return {
        number: (numberCell?.textContent || '').trim().split('\n')[0],
        height: num(tr.getBoundingClientRect().height),
        cells: cells.length,
        clampToggle: !!tr.querySelector('.ui-clamp-toggle'),
        addressToggle: !!tr.querySelector('.tp-addr-toggle'),
        addressVisible: !!tr.querySelector('.tp-obj-address')
          && !tr.querySelector('.tp-addr-block[hidden]'),
      }
    })

    return {
      classes: table.className,
      pageClasses: document.querySelector('.tenders-page')?.className || '',
      bodyClasses: document.body.className,
      font: getComputedStyle(table.querySelector('tbody td') || table).fontFamily,
      tableFontSize: getComputedStyle(table.querySelector('tbody td') || table).fontSize,
      tableWidth: num(table.getBoundingClientRect().width),
      containerWidth: num(container?.getBoundingClientRect().width || 0),
      horizontalScroll: container ? container.scrollWidth > container.clientWidth + 1 : false,
      headerHeight: num(table.querySelector('thead tr')?.getBoundingClientRect().height || 0),
      columns: headCells.map((th) => ({
        title: th.innerText.replace(/\s+/g, ' ').trim(),
        width: num(th.getBoundingClientRect().width),
      })),
      rowCount: rows.length,
      rowHeightAvg: num(rows.reduce((s, r) => s + r.height, 0) / (rows.length || 1)),
      rows,
    }
  })
}

export const VARIANT_LIST = ['old', 'cur', 'new']
