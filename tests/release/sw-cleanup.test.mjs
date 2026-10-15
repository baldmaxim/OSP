// Самоудаление service worker прежнего сайта на адресе портала (public/sw.js) — в настоящем браузере:
//   • до 13.10 на tender.su10.ru жил другой сайт (HUBTender, PWA): его service worker отдаёт свою страницу из
//     кэша на любой переход — и после того, как сервер отдаёт уже портал ОСП;
//   • сервер начинает отдавать наш /sw.js — после обычного перехода вкладка сама перезагружается и
//     показывает портал, регистраций service worker и кэшей не остаётся;
//   • в браузере без прежнего service worker портал свой не регистрирует и /sw.js не запрашивает.
// «Прежний сайт» устроен как сборка workbox: кэш при установке, любой переход — страница из кэша.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { browserLaunchOptions, REPO } from '../tender/lib/stand.mjs'

const launch = browserLaunchOptions()
const OUR_SW = fs.readFileSync(path.join(REPO, 'public', 'sw.js'), 'utf8')

const OLD_PAGE = `<!doctype html><meta charset="utf-8"><title>TenderHUB</title><h1 id="site">TenderHUB</h1>
<script>navigator.serviceWorker.register('/sw.js', { scope: '/' })</script>`
const OLD_SW = `
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open('workbox-precache-v2').then((c) => c.addAll(['/index.html']))) })
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') e.respondWith(caches.match('/index.html').then((r) => r || fetch(e.request)))
})`
const NEW_PAGE = '<!doctype html><meta charset="utf-8"><title>ОСП</title><h1 id="site">ОСП</h1>'

function startServer(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    state.requests.push(`${state.phase} ${url.pathname}`)
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache, no-store, must-revalidate' })
      return res.end(state.phase === 'old' ? OLD_SW : OUR_SW)
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(state.phase === 'old' ? OLD_PAGE : NEW_PAGE)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// Что показывает вкладка; во время перезагрузки страницы чтение может сорваться — повторяем.
async function siteShown(page, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await page.textContent('#site', { timeout: 1000 })
      if (last === expected) return last
    } catch { /* страница перезагружается */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return last
}

const swState = (page) => page.evaluate(async () => ({
  registrations: (await navigator.serviceWorker.getRegistrations()).length,
  caches: (await caches.keys()).length,
}))

describe('Самоудаление service worker прежнего сайта на адресе портала', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 120000 }, () => {
  let browser, server, base
  const state = { phase: 'old', requests: [] }

  before(async () => {
    server = await startServer(state)
    base = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ headless: true, ...launch })
  })
  after(async () => {
    await browser?.close()
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  })

  it('прежний service worker заменяется нашим: вкладка сама переходит на портал, регистраций и кэшей нет', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    state.phase = 'old'
    await page.goto(`${base}/login`)
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 })

    // Сервер уже отдаёт портал, а прежний service worker — свою страницу из кэша (то, что видели люди).
    state.phase = 'new'
    state.requests.length = 0
    await page.goto(`${base}/tenders/construction`)
    assert.equal(await page.textContent('#site'), 'TenderHUB', 'прежний service worker отдаёт страницу из кэша')

    // Тот же переход заставляет браузер проверить /sw.js: наш заменяет прежний и перезагружает вкладку.
    assert.equal(await siteShown(page, 'ОСП', 30000), 'ОСП', 'вкладка сама перешла на портал')
    assert.ok(state.requests.includes('new /sw.js'), 'браузер скачал наш /sw.js')
    assert.equal(new URL(page.url()).pathname, '/tenders/construction', 'адрес вкладки тот же')
    let after = await swState(page)
    for (let i = 0; i < 20 && after.registrations; i++) {
      await new Promise((r) => setTimeout(r, 250))
      after = await swState(page)
    }
    assert.deepEqual(after, { registrations: 0, caches: 0 }, 'регистраций service worker и кэшей не осталось')

    // Следующие переходы — с сервера.
    await page.goto(`${base}/contracts`)
    assert.equal(await page.textContent('#site'), 'ОСП')
    await context.close()
  })

  it('без прежнего service worker портал свой не регистрирует и /sw.js не запрашивает', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    state.phase = 'new'
    state.requests.length = 0
    await page.goto(`${base}/login`)
    assert.equal(await page.textContent('#site'), 'ОСП')
    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(await swState(page), { registrations: 0, caches: 0 })
    assert.ok(!state.requests.includes('new /sw.js'), '/sw.js не запрашивался')
    await context.close()
  })
})
