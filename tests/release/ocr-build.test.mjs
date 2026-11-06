// Распознавание скана в боевой сборке и под настоящей политикой содержимого (deploy/docker/web/csp.conf). Стенд UI работает через
// dev-сервер и без политики, а здесь могло бы сломаться то, чего он не видит: рабочий поток и ядро — файлы сборки с хэшем в имени, языки
// — файлы public, и всё это браузер запускает под запретами. Сломалось бы молча: скан просто снова «не читается».
//   • всё грузится со своего адреса: у библиотеки по умолчанию чужой адрес (jsdelivr), политика его не пропустит;
//   • отказов политики нет, цены прочитаны верно.
// Файлы распознавателя (ядро 3,9 МБ, языки 5,6 МБ) подгружаются, только когда встретился скан: при обычном чтении их не запрашиваем.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { chromium } from 'playwright'
import { browserLaunchOptions, REPO } from '../tender/lib/stand.mjs'
import { invoiceJpeg, jpegPdf } from '../supply/lib/scan-pdf.mjs'

const launch = browserLaunchOptions()
const CSP = /add_header Content-Security-Policy "([^"]+)" always;/.exec(fs.readFileSync(path.join(REPO, 'deploy', 'docker', 'web', 'csp.conf'), 'utf8'))[1]
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'application/octet-stream', '.css': 'text/css' }

const INVOICE = `<h2>Счет № 123456 от 2 Ноября 2026 г.</h2>
  <table><tr><th style="width:4%">№</th><th>Товар</th><th>Склад</th><th>Цена с НДС</th><th>Кол-во</th><th>Ед.</th><th>Сумма, руб</th></tr>
  <tr><td class="c">1</td><td>трубы электросварные квадрат 20х2 ГОСТ дл.6000</td><td class="c">14</td><td class="r">60 890</td><td class="r">0,026</td><td class="c">теор.т</td><td class="r">1 583,14</td></tr>
  <tr><td class="c">2</td><td>лист г/к 10x1500x3000 (ММК) н/обр</td><td class="c">18</td><td class="r">63 790</td><td class="r">0,36</td><td class="c">т</td><td class="r">22 964,40</td></tr>
  </table><p style="text-align:right">Итого: 24 547,54 руб.<br>В том числе НДС: 4 426,77 руб.</p>`

describe('Распознавание скана: боевая сборка и политика содержимого', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let dir
  let server
  let browser
  let origin
  const served = []

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-ocr-build-'))
    const root = path.join(dir, 'src')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><title>стенд</title><script type="module" src="./entry.js"></script>')
    fs.writeFileSync(path.join(root, 'entry.js'), `import { readSupplierDoc } from ${JSON.stringify(path.join(REPO, 'src/utils/supplierDocRead.js'))}
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI))
window.__read = async (b64, name) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const pages = []
  const r = await readSupplierDoc(bytes, name, { onProgress: (p) => pages.push(p) })
  return { ...r, progress: pages }
}
window.__ready = true`)
    const out = path.join(dir, 'dist')
    await build({
      configFile: false, root, logLevel: 'error', publicDir: path.join(REPO, 'public'),
      build: { outDir: out, emptyOutDir: true, chunkSizeWarningLimit: 100000 },
    })
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0])
      served.push(url)
      const file = path.join(out, url === '/' ? 'index.html' : url)
      if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
      // Как у nginx портала: тип — по расширению, запрет угадывать тип. Политика — на всех ответах (хуже, чем на самом деле).
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP })
      res.end(fs.readFileSync(file))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await new Promise((r) => (server ? server.close(r) : r()))
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('скан в PDF и фото читаются; всё — со своего адреса, отказов политики нет', async () => {
    const page = await browser.newPage()
    const foreign = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin) foreign.push(r.url())
    })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${origin}/`)
    await page.waitForFunction(() => window.__ready)

    const scan = await invoiceJpeg(browser, INVOICE, { skew: 0.3 })
    const first = served.length
    const pdf = await page.evaluate(([b64, name]) => window.__read(b64, name), [jpegPdf(scan).toString('base64'), 'счёт-скан.pdf'])
    assert.equal(pdf.error, undefined, pdf.message)
    assert.equal(pdf.ocr, true)
    assert.equal(pdf.kind, 'pdf')
    assert.deepEqual(pdf.progress, [{ page: 1, pages: 1 }])
    assert.deepEqual(pdf.items.map((i) => [i.unit, i.qty, i.price, i.sum, i.unsure]), [['теор.т', 0.026, 60890, 1583.14, false], ['т', 0.36, 63790, 22964.4, false]])
    assert.equal(pdf.total.ok, true)
    assert.equal(pdf.date, '2026-11-02')
    const loaded = served.slice(first)
    assert.ok(loaded.some((u) => /worker\.min-.*\.js$/.test(u)), 'рабочий поток — файл сборки')
    assert.ok(loaded.some((u) => /tesseract-core-simd-lstm\.wasm-.*\.js$/.test(u)), 'ядро — файл сборки')
    assert.ok(loaded.includes('/ocr/rus.traineddata.gz') && loaded.includes('/ocr/eng.traineddata.gz'), 'языки — файлы сайта')

    const image = await page.evaluate(([b64, name]) => window.__read(b64, name), [scan.jpeg.toString('base64'), 'фото счёта.jpg'])
    assert.equal(image.error, undefined, image.message)
    assert.equal(image.kind, 'image')
    assert.deepEqual(image.items.map((i) => i.price), [60890, 63790])

    assert.deepEqual(foreign, [], 'чужих адресов нет')
    assert.deepEqual(await page.evaluate(() => window.__violations), [], 'отказов политики нет')
    assert.deepEqual(errors, [])
    await page.close()
  })

  it('обычный PDF с текстом распознаватель не загружает', async () => {
    const maker = await browser.newPage()
    await maker.setContent(`<!doctype html><meta charset="utf-8"><body>${INVOICE.replace(/<table>/, '<table border="1">')}</body>`)
    const pdf = await maker.pdf({ format: 'A4' })
    await maker.close()
    const page = await browser.newPage()
    await page.goto(`${origin}/`)
    await page.waitForFunction(() => window.__ready)
    const first = served.length
    const r = await page.evaluate(([b64, name]) => window.__read(b64, name), [Buffer.from(pdf).toString('base64'), 'счёт.pdf'])
    assert.equal(r.error, undefined, r.message)
    assert.equal(r.ocr, undefined)
    assert.equal(r.items.length, 2)
    assert.deepEqual(served.slice(first).filter((u) => /tesseract|traineddata|\/worker\.min/.test(u)), [])
    await page.close()
  })
})
