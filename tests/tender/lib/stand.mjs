// Запуск стенда карточки тендера в браузере и замер сценария «ВОР → Сравнение КП».
// srcRoot — каталог с исходниками (текущий репозиторий или worktree исходной версии).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.join(HERE, '..', 'ui')
export const REPO = path.resolve(HERE, '..', '..', '..')

export function browserLaunchOptions() {
  try {
    if (fs.existsSync(chromium.executablePath())) return {}
  } catch { /* сборка Playwright не скачана */ }
  const found = [
    process.env.PSDC_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find((p) => fs.existsSync(p))
  return found ? { executablePath: found } : null
}

export async function startStand(srcRoot) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\.(js|jsx)$/, '').toLowerCase()
  const supabaseDir = norm(path.join(srcRoot, 'src', 'supabase'))
  const roleCtx = norm(path.join(srcRoot, 'src', 'contexts', 'RoleContext'))
  const port = 49000 + Math.floor(Math.random() * 900)
  const server = await createServer({
    configFile: false,
    root: UI,
    logLevel: 'error',
    plugins: [react(), {
      name: 'tender-stand',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!importer) return null
        if (source.includes('src/pages/TenderDetailPage')) return path.join(srcRoot, 'src', 'pages', 'TenderDetailPage.jsx')
        if (source.includes('src/index.css')) return path.join(srcRoot, 'src', 'index.css')
        if (!source.startsWith('.')) return null
        const resolved = norm(path.resolve(path.dirname(importer), source))
        if (resolved === supabaseDir || resolved === `${supabaseDir}/index`) return path.join(UI, 'fake-supabase.js')
        if (resolved === roleCtx) return path.join(UI, 'fake-role.jsx')
        return null
      },
    }],
    resolve: { dedupe: ['react', 'react-dom', 'react-router-dom'] },
    server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [REPO, srcRoot] } },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react-router-dom', 'xlsx', 'pizzip', 'file-saver'] },
  })
  await server.listen()
  return { server, url: `http://127.0.0.1:${port}/index.html` }
}

// Сценарий пользователя. Возвращает метрики в мс и счётчики запросов.
// tolerant: шаг, не уложившийся в stepTimeout, записывается как «не дождались», сценарий
// на этом останавливается (нужно для замера исходной версии, где вкладка могла зависнуть).
export async function runScenario(browser, url, opts = {}) {
  if (!opts.tolerant) return runScenarioSteps(browser, url, opts, {})
  const m = {}
  try {
    await runScenarioSteps(browser, url, opts, m)
  } catch (e) {
    m.stoppedAt = m.currentStep
    m.stopReason = String(e.message || e).split('\n')[0]
  }
  return m
}

async function runScenarioSteps(browser, url, { items = 5000, cps = 10, latency = 120, stepTimeout = 180000 } = {}, m) {
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // «Failed to load resource» — favicon стенда, к странице отношения не имеет.
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
  page.on('dialog', (d) => d.accept())
  const stats = () => page.evaluate(() => ({
    proposalSelects: window.__supabaseStats.requests.filter((r) => r.table === 'tender_counterparty_proposals' && r.op === 'select').length,
    maxActive: window.__supabaseStats.maxActive,
  }))
  const step = async (name, fn) => {
    m.currentStep = name
    const t = Date.now()
    await fn()
    return Date.now() - t
  }

  try {
    // Прогрев: первая загрузка компилирует модули dev-сервером — в замер не входит.
    await page.goto(`${url}?items=20&cps=2&latency=0`)
    await page.locator('.estimate-table').waitFor({ timeout: 120000 })

    m.vorLoadMs = await step('загрузка ВОР', async () => {
      await page.goto(`${url}?items=${items}&cps=${cps}&latency=${latency}`)
      // ВОР загружен целиком: счётчик на вкладке показывает все позиции.
      await page.locator('.tender-tab', { hasText: 'ВОР' }).first()
        .locator('.tab-count', { hasText: new RegExp(`^${items}$`) }).waitFor({ timeout: stepTimeout })
      await page.locator('.estimate-table tbody tr').first().waitFor({ timeout: stepTimeout })
    })
    m.vorDomRows = await page.locator('.estimate-table tbody tr').count()

    const beforeCompare = await stats()
    m.compareLoadMs = await step('открытие Сравнения КП', async () => {
      await page.locator('.tender-tab', { hasText: 'Сравнение КП' }).click()
      await page.locator('.proposals-table tbody tr').first().waitFor({ timeout: stepTimeout })
    })
    m.compareDomRows = await page.locator('.proposals-table tbody tr').count()
    const afterCompare = await stats()
    m.compareRequests = afterCompare.proposalSelects - beforeCompare.proposalSelects

    // «учтено» у первой нерасценённой позиции.
    const checkbox = page.locator('.proposals-table .covered-check input').first()
    if (await checkbox.count()) {
      m.toggleMs = await step('отметка «учтено»', async () => {
        // Флажок управляемый: отмечается после ответа сервера, поэтому click, а не check.
        await checkbox.click({ timeout: stepTimeout })
        await page.locator('.proposals-table .covered-note-input').first().waitFor({ timeout: stepTimeout })
      })
      m.toggleProposalSelects = (await stats()).proposalSelects - afterCompare.proposalSelects
    }

    // Уход на ВОР и возврат.
    await page.locator('.tender-tab', { hasText: 'ВОР' }).first().click({ timeout: stepTimeout })
    await page.locator('.estimate-table').waitFor({ timeout: stepTimeout })
    m.compareReturnMs = await step('возврат на Сравнение КП', async () => {
      await page.locator('.tender-tab', { hasText: 'Сравнение КП' }).click({ timeout: stepTimeout })
      await page.locator('.proposals-table tbody tr').first().waitFor({ timeout: stepTimeout })
    })

    m.materialsMs = await step('подвкладка «Материалы»', async () => {
      await page.locator('.proposals-subtab', { hasText: 'Материалы' }).click({ timeout: stepTimeout })
      await page.locator('.proposals-table-aggregate').waitFor({ timeout: stepTimeout })
    })

    m.maxParallelRequests = (await stats()).maxActive
    delete m.currentStep
    return m
  } finally {
    m.errors = errors
    await context.close().catch(() => {})
  }
}
