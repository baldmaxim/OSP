// Политика содержимого страницы портала (deploy/docker/web/csp.conf) в настоящем браузере:
//   • свои скрипты и рабочие потоки работают; встроенные скрипты, адреса javascript:, чужие скрипты и <object> — нет;
//   • страницу нельзя встроить в чужую; окно просмотра файла (iframe с другого адреса, blob:) открывается;
//   • настоящая карта Яндекса («Объекты») строится без отказов политики (нет сети до Яндекса — эта проверка пропускается).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { browserLaunchOptions, REPO } from '../tender/lib/stand.mjs'

const launch = browserLaunchOptions()
const CSP = /add_header Content-Security-Policy "([^"]+)" always;/.exec(fs.readFileSync(path.join(REPO, 'deploy', 'docker', 'web', 'csp.conf'), 'utf8'))[1]

const PAGE = `<!doctype html><meta charset="utf-8"><title>стенд</title>
<script>window.__inline = true</script>
<script src="/app.js"></script>
<a id="js" href="javascript:window.__jsHref=true">ссылка</a>
<div id="map" style="width:400px;height:300px"></div>`
const APP = `window.__own = true
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI))
window.__worker = new Promise((resolve) => { const w = new Worker('/worker.js'); w.onmessage = (e) => resolve(e.data); w.onerror = () => resolve('error') })
window.__blobFrame = () => new Promise((resolve) => {
  const f = document.createElement('iframe'); f.onload = () => resolve('loaded')
  f.src = URL.createObjectURL(new Blob(['<p>файл</p>'], { type: 'text/html' })); document.body.append(f)
  setTimeout(() => resolve('timeout'), 3000)
})
window.__foreignScript = (url) => new Promise((resolve) => {
  const s = document.createElement('script'); s.src = url; s.onload = () => resolve('loaded'); s.onerror = () => resolve('blocked'); document.head.append(s)
})
window.__objectTag = () => new Promise((resolve) => {
  const o = document.createElement('object'); o.data = '/app.js'; o.onload = () => resolve('loaded'); o.onerror = () => resolve('blocked'); document.body.append(o)
  setTimeout(() => resolve('blocked'), 1000)
})`

describe('Политика содержимого страницы портала', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 180000 }, () => {
  let browser
  let server
  let foreign
  let origin
  let foreignOrigin
  const listen = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve(s))
  })

  before(async () => {
    server = await listen((req, res) => {
      const url = req.url.split('?')[0]
      if (url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(APP) }
      if (url === '/worker.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('postMessage("ok")') }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'x-frame-options': 'SAMEORIGIN' })
      res.end(PAGE)
    })
    origin = `http://127.0.0.1:${server.address().port}`
    foreign = await listen((req, res) => {
      if (req.url === '/evil.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.__evil = true') }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><iframe id="f" src="${origin}/"></iframe>`)
    })
    foreignOrigin = `http://127.0.0.1:${foreign.address().port}`
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await new Promise((r) => server?.close(r))
    await new Promise((r) => foreign?.close(r))
  })

  it('свои скрипты и потоки работают; встроенные, javascript:, чужие скрипты и <object> — нет', async () => {
    const page = await browser.newPage()
    await page.goto(`${origin}/`)
    assert.equal(await page.evaluate(() => window.__own), true, 'свой скрипт')
    assert.equal(await page.evaluate(() => window.__worker), 'ok', 'свой рабочий поток')
    assert.equal(await page.evaluate(() => window.__inline), undefined, 'встроенный скрипт')
    await page.locator('#js').click()
    assert.equal(await page.evaluate(() => window.__jsHref), undefined, 'адрес javascript:')
    assert.equal(await page.evaluate((u) => window.__foreignScript(u), `${foreignOrigin}/evil.js`), 'blocked', 'чужой скрипт')
    assert.equal(await page.evaluate(() => window.__evil), undefined)
    assert.equal(await page.evaluate(() => window.__objectTag()), 'blocked', '<object>')
    assert.equal(await page.evaluate(() => window.__blobFrame()), 'loaded', 'окно просмотра: blob:')
    await page.close()
  })

  it('страницу нельзя встроить в чужую', async () => {
    const page = await browser.newPage()
    await page.goto(`${foreignOrigin}/`)
    const frame = page.frames().find((f) => f.url().startsWith(origin))
    const framed = frame ? await frame.evaluate(() => window.__own === true).catch(() => false) : false
    assert.equal(framed, false)
    await page.close()
  })

  it('карта Яндекса строится под этой политикой', async (t) => {
    const reachable = await fetch('https://api-maps.yandex.ru/2.1/?apikey=&lang=ru_RU', { signal: AbortSignal.timeout(15000) }).then((r) => r.ok, () => false)
    if (!reachable) return t.skip('нет сети до api-maps.yandex.ru')
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${origin}/`)
    const built = await page.evaluate(async () => {
      await window.__foreignScript('https://api-maps.yandex.ru/2.1/?apikey=&lang=ru_RU')
      if (!window.ymaps) return 'нет ymaps'
      return new Promise((resolve) => {
        window.ymaps.ready(() => {
          const map = new window.ymaps.Map('map', { center: [55.75, 37.62], zoom: 10 })
          map.geoObjects.add(new window.ymaps.Placemark([55.75, 37.62]))
          resolve('ok')
        })
        setTimeout(() => resolve('timeout'), 30000)
      })
    })
    assert.equal(built, 'ok')
    await page.waitForTimeout(1500)
    const violations = await page.evaluate(() => window.__violations)
    assert.deepEqual(violations.filter((v) => /^script-src/.test(v)), [], 'скрипты карты не заблокированы')
    assert.deepEqual(violations.filter((v) => !/^script-src/.test(v)), [], 'остальное для карты не заблокировано')
    await page.close()
  })
})
