// Страховочный релиз (Р1) в настоящем браузере на двух настоящих production-сборках:
//   • вкладка, открытая до деплоя, при переходе на новую страницу один раз сама
//     перезагружается и получает новую сборку — без белого экрана;
//   • если файл не появился и после перезагрузки — сообщение, а не цикл перезагрузок;
//   • уровень совместимости выше вшитого — окно без «Позже», сворачивается в полосу;
//   • /config.json отсутствует (nginx отдаёт index.html) — приложение стартует.
// Сервер стенда подменяет то, что отдаёт nginx: корень сборки, version.json, config.json.
// Supabase в сборке указывает на закрытый порт — страницам хватает того, что они рисуются.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { chromium } from 'playwright'
import { browserLaunchOptions, REPO } from '../tender/lib/stand.mjs'

const launch = browserLaunchOptions()

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

async function buildInto(outDir, buildId) {
  const saved = { ...process.env }
  Object.assign(process.env, {
    OSP_BUILD_ID: buildId,
    VITE_SUPABASE_URL: 'http://127.0.0.1:9',
    VITE_SUPABASE_ANON_KEY: 'release-test-anon-key',
  })
  try {
    await build({ root: REPO, configFile: path.join(REPO, 'vite.config.js'), logLevel: 'error', build: { outDir, emptyOutDir: true } })
  } finally {
    for (const k of ['OSP_BUILD_ID', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k]
    }
  }
}

// Как nginx: файл из корня сборки, иначе index.html (SPA); /assets/* — строго 404.
function startServer(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    state.requests.push(url.pathname + url.search)
    if (url.pathname === '/version.json' && state.version) {
      res.writeHead(200, { 'content-type': MIME['.json'] })
      return res.end(JSON.stringify(state.version))
    }
    if (url.pathname === '/config.json' && state.config) {
      res.writeHead(200, { 'content-type': MIME['.json'] })
      return res.end(state.config)
    }
    const file = path.join(state.root, decodeURIComponent(url.pathname))
    if (file.startsWith(state.root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      return res.end(fs.readFileSync(file))
    }
    if (url.pathname.startsWith('/assets/')) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(fs.readFileSync(path.join(state.root, 'index.html')))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('Страховочный релиз: обновление, ошибки чанков, конфиг', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let tmp, distA, distB, server, base, browser
  const state = { root: '', version: null, config: null, requests: [] }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-release-'))
    distA = path.join(tmp, 'a')
    distB = path.join(tmp, 'b')
    await buildInto(distA, '1000')
    await buildInto(distB, '2000')
    server = await startServer(state)
    base = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await new Promise((r) => server ? server.close(r) : r())
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function openPage() {
    const page = await browser.newPage({ locale: 'ru-RU' })
    let loads = 0
    page.on('load', () => { loads += 1 })
    return { page, loads: () => loads }
  }

  // Переход внутри приложения (как по ссылке): React Router слушает popstate.
  const navigate = (page, to) => page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, to)

  it('нет /config.json (вместо него index.html) — приложение стартует', async () => {
    Object.assign(state, { root: distA, version: null, config: null })
    const { page } = await openPage()
    await page.goto(`${base}/login`)
    await page.locator('.login-form').first().waitFor({ timeout: 30000 })
    await page.close()
  })

  it('?features= включает флаг только в этом браузере и убирается из адреса; «-флаг» снимает', async () => {
    Object.assign(state, { root: distA, version: null, config: null })
    const { page } = await openPage()
    await page.goto(`${base}/login?features=ospApiFiles,bad name!,x`)
    await page.locator('.login-form').first().waitFor({ timeout: 30000 })
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('osp.features'))), { ospApiFiles: true, x: true })
    assert.equal(await page.evaluate(() => window.location.search), '')
    assert.equal(new URL(page.url()).pathname, '/login')
    await page.goto(`${base}/login?features=-ospApiFiles,-x`)
    await page.locator('.login-form').first().waitFor({ timeout: 30000 })
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('osp.features'))), {})
    await page.close()
  })

  it('после деплоя старая вкладка один раз перезагружается и получает новую сборку', async () => {
    Object.assign(state, { root: distA, version: null, config: null })
    const { page, loads } = await openPage()
    await page.goto(`${base}/login`)
    await page.locator('.login-form').first().waitFor({ timeout: 30000 })
    assert.equal(loads(), 1)

    // Деплой «по-старому»: на сервере только новая сборка, файлов старой нет.
    state.root = distB
    state.requests.length = 0
    await navigate(page, '/public/tenders')
    await page.locator('.public-tenders-page').waitFor({ timeout: 30000 })
    assert.equal(loads(), 2, 'ровно одна перезагрузка')
    assert.ok(state.requests.some((r) => r === '/public/tenders'), 'страница загружена заново с сервера')
    assert.equal(await page.locator('.chunk-error').count(), 0)
    await page.close()
  })

  it('файла нет и после перезагрузки — сообщение вместо цикла перезагрузок', async () => {
    // Сборка A без чанка публичной страницы: ни до, ни после перезагрузки его нет.
    const distBroken = path.join(tmp, 'broken')
    fs.cpSync(distA, distBroken, { recursive: true })
    for (const f of fs.readdirSync(path.join(distBroken, 'assets'))) {
      if (f.startsWith('PublicTendersPage')) fs.rmSync(path.join(distBroken, 'assets', f))
    }
    Object.assign(state, { root: distBroken, version: null, config: null })
    const { page, loads } = await openPage()
    await page.goto(`${base}/login`)
    await page.locator('.login-form').first().waitFor({ timeout: 30000 })
    await navigate(page, '/public/tenders')
    await page.locator('.chunk-error').waitFor({ timeout: 30000 })
    await page.waitForTimeout(1500)
    assert.equal(loads(), 2, 'одна попытка перезагрузки, без цикла')
    assert.match(await page.locator('.chunk-error').innerText(), /Не удалось загрузить страницу/)
    await page.close()
  })

  it('новая обычная версия — окно с «Позже»; несовместимая — без «Позже», сворачивается в полосу', async () => {
    Object.assign(state, { root: distA, config: null, version: { buildId: '1500', compat: 1, rollbackFloor: 1 } })
    state.requests.length = 0
    const { page } = await openPage()
    await page.goto(`${base}/login`)
    await page.locator('.login-form').first().waitFor({ timeout: 30000 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.locator('.upd-prompt').waitFor({ timeout: 10000 })
    assert.match(await page.locator('.upd-prompt-title').innerText(), /Доступна новая версия/)
    assert.equal(await page.locator('.upd-prompt-later').innerText(), 'Позже')
    assert.ok(state.requests.some((r) => r.startsWith('/version.json?b=1000')), 'опрос несёт id сборки вкладки (для лога nginx)')
    await page.locator('.upd-prompt-later').click()

    // Сервер поднял уровень совместимости: вкладка, отложившая обновление, его всё равно увидит.
    state.version = { buildId: '3000', compat: 2, rollbackFloor: 2 }
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.locator('.upd-prompt').waitFor({ timeout: 10000 })
    assert.match(await page.locator('.upd-prompt-title').innerText(), /Нужно обновить страницу/)
    assert.equal(await page.locator('.upd-prompt-later').innerText(), 'Сначала сохраню')
    await page.locator('.upd-overlay').click({ position: { x: 5, y: 5 } })
    assert.equal(await page.locator('.upd-prompt').count(), 1, 'клик мимо окна его не закрывает')
    await page.locator('.upd-prompt-later').click()
    await page.locator('.upd-banner').waitFor({ timeout: 5000 })
    await page.close()
  })
})
