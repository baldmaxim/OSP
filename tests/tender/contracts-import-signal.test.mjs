// «Договоры и ДС» → «Документы» → «Импорт из Excel» × SIGNAL (23.11.2026, Ф5; В-9): после вставки сервер сверяет созданные документы по
// снимку (порциями по 200, не дольше 5 с на порцию), в окне результата — строка «Signal: найдено N · требуют внимания M · без папки
// или ожидают K» (три непересекающиеся группы: найдено = сверено + принята + предложена папка; внимание = противоречие + не видна +
// удалён; прочее — нет ссылки, не сверена, ожидает), разбивка по состояниям — в title.
//   • сумма групп = число УНИКАЛЬНЫХ успешно созданных id; повторный ответ сервера её не увеличивает; неудавшиеся вставки в сверку
//     не уходят;
//   • обе ветви вставки: пакетная (порция принята целиком) и построчная (порция отклонена — документы вставляются по одному);
//   • сбой или медленный ответ сервера сверки окно итога не задерживает: «без папки или ожидают», итог не выдумывается;
//   • сверка выключена или нет права правки — строки нет, импорт как раньше.
// Стенд: contracts=24&signal=1 (signal-fake.js). Состояние нового договора сервер решает по номеру: СВЕР — сверено, ПРЕД — предложена
// папка, ПРИН — ссылка принята без номера, ПРОТ — противоречие, ВНИМ — папка не видна, ОЖИД — ждёт обработки, иначе — нет ссылки.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import * as esbuild from 'esbuild'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=24&signal=1&latency=0'
const FILE = 'Импорт Signal.xlsx'

// Шаблон импорта — из самого модуля (колонки узнаются по заголовкам).
async function template() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-import-signal-')), 'contractsImport.mjs')
  await esbuild.build({
    entryPoints: [path.join(REPO, 'src', 'utils', 'contractsImport.js')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', external: ['xlsx'], absWorkingDir: REPO,
  })
  fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replaceAll('from "xlsx"', `from ${JSON.stringify(pathToFileURL(path.join(REPO, 'node_modules', 'xlsx', 'xlsx.mjs')).href)}`))
  const { IMPORT_COLUMNS, TEMPLATE_HEADERS } = await import(pathToFileURL(out).href)
  return { keys: IMPORT_COLUMNS.map((c) => c.key), headers: TEMPLATE_HEADERS }
}

// numbers — номера договоров по строкам; bad — номера строк с ошибкой данных (объект не найден): в базу не попадают.
function workbook({ keys, headers }, numbers, { bad = [] } = {}) {
  const line = (values) => keys.map((k) => values[k] ?? '')
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    ...numbers.map((n) => line({
      record_type: 'Договор', contract_number: n, contract_date: '01.11.2026', counterparty_name: 'Подрядчик 02',
      object_name: bad.includes(n) ? 'Нет такого объекта' : 'ЖК «Северный квартал»', handled_by_us: 'Нет',
    })),
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Договоры')
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

describe('Импорт договоров из Excel × SIGNAL: итог сверки в окне результата', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser
  let tpl

  before(async () => {
    tpl = await template()
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  // Импорт файла с номерами; before — что сделать со страницей до «Завершить импорт» (например, подставить отказ базы).
  const run = async (query, numbers, { bad, before: prepare, resultText = null } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource|счётчики номеров/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.addInitScript(() => { try { localStorage.clear() } catch { /* нет */ } })
    await page.goto(`${stand.url}?${query}`)
    // Сервер разработки перезагружает страницу, когда рядом правят исходники: одна повторная загрузка — не ошибка теста.
    try { await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 40000 }) } catch {
      await page.reload()
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 80000 })
    }
    await page.locator('.contracts-docs-btn').click()
    await page.locator('.tdm-card', { hasText: 'Импорт из Excel' }).click()
    await page.waitForFunction(() => document.querySelector('.cim-modal input[type="file"]') && !document.querySelector('.cim-modal input[type="file"]').disabled,
      null, { timeout: 60000 })
    await page.locator('.cim-modal input[type="file"]').setInputFiles({
      name: FILE, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook(tpl, numbers, { bad }),
    })
    const confirm = page.locator('.cim-footer .btn-primary', { hasText: 'Завершить импорт' })
    await confirm.waitFor({ timeout: 60000 })
    if (prepare) await page.evaluate(prepare)
    await confirm.click()
    await page.locator('.cim-result-big', { hasText: resultText || 'Создано договоров' }).waitFor({ timeout: 60000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const line = async (page, text = /Signal: найдено/) => {
    const el = page.locator('.cim-signal', { hasText: text })
    await el.waitFor({ timeout: 30000 })
    return { text: (await el.innerText()).trim(), title: await el.getAttribute('title') }
  }
  const matchBodies = (page) => page.evaluate(() => window.__signal.calls.filter((c) => c.path === '/api/signal/match').map((c) => c.body.contractIds))
  const createdIds = (page, numbers) => page.evaluate((nums) => window.__fakeDb.contracts.filter((c) => nums.includes(c.contract_number)).map((c) => c.id), numbers)

  const MIX = ['СВЕР-1', 'ПРЕД-2', 'ПРОТ-3', 'ВНИМ-4', 'ОЖИД-5', 'ПРОСТО-6', 'ПРИН-7']

  it('пакетная вставка: три группы — найдено, требуют внимания, ожидают; сумма = число созданных; разбивка — в title; ошибочная строка не сверяется', async () => {
    const { page, errors, close } = await run(BASE, [...MIX, 'ОШИБ-8'], { bad: ['ОШИБ-8'] })
    try {
      await page.locator('.cim-result-big', { hasText: 'Создано договоров: 7' }).waitFor()
      const got = await line(page)
      assert.equal(got.text, 'Signal: найдено 3 · требуют внимания 2 · без папки или ожидают 2', 'найдено = сверено + принята + предложена; внимание = противоречие + не видна')
      assert.equal(got.title, 'Всего документов: 7 · сверено: 1 · ссылка принята: 1 · предложена папка: 1 · противоречие: 1 · не видна: 1 · ссылка не сверена: 1 · нет ссылки: 1')
      const [only, ...rest] = await matchBodies(page)
      assert.deepEqual(rest, [], 'семь документов — одна порция')
      assert.deepEqual([...only].sort(), (await createdIds(page, MIX)).sort(), 'ушли ровно созданные id')
      assert.equal(only.length, new Set(only).size)
      assert.match(await page.locator('.cim-result').innerText(), /Не загружено строк: 1/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('построчная вставка (порцию база отклонила): сверяются документы, вставленные по одному; отклонённая строка — нет; сумма та же', async () => {
    const numbers = ['СВЕР-1', 'ПРЕД-2', 'ПРОТ-3', 'ОШИБ-9']
    const { page, errors, close } = await run(BASE, numbers, {
      // Порция из нескольких строк отклоняется целиком, поштучно проходят все, кроме ОШИБ-9.
      before: () => {
        window.__fakeHold = (q) => {
          if (q.table !== 'contracts' || q.op !== 'insert') return {}
          if (q.payload.length > 1) return { error: { code: '23514', message: 'порция отклонена' } }
          if (q.payload[0].contract_number === 'ОШИБ-9') return { error: { code: '23514', message: 'строка отклонена' } }
          return {}
        }
      },
    })
    try {
      await page.locator('.cim-result-big', { hasText: 'Создано договоров: 3' }).waitFor()
      const got = await line(page)
      assert.equal(got.text, 'Signal: найдено 2 · требуют внимания 1 · без папки или ожидают 0')
      assert.match(got.title, /^Всего документов: 3 · /)
      const [only] = await matchBodies(page)
      assert.deepEqual([...only].sort(), (await createdIds(page, numbers)).sort())
      assert.equal(only.length, 3)
      assert.equal(await page.evaluate(() => window.__fakeDb.contracts.some((c) => c.contract_number === 'ОШИБ-9')), false, 'отклонённого в базе нет')
      assert.match(await page.locator('.cim-result').innerText(), /Не загружено строк: 1/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('повторный ответ сервера сумму не удваивает', async () => {
    const { page, errors, close } = await run(`${BASE}&signalDupe=1`, MIX)
    try {
      const got = await line(page)
      assert.equal(got.text, 'Signal: найдено 3 · требуют внимания 2 · без папки или ожидают 2')
      assert.match(got.title, /^Всего документов: 7 · /)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('больше 200 документов — порции по 200 без повторов, итог по всем', async () => {
    const numbers = Array.from({ length: 450 }, (_, i) => `СВЕР-${i + 1}`)
    const { page, errors, close } = await run(BASE, numbers)
    try {
      await page.locator('.cim-result-big', { hasText: 'Создано договоров: 450' }).waitFor()
      const got = await line(page)
      assert.equal(got.text, 'Signal: найдено 450 · требуют внимания 0 · без папки или ожидают 0')
      const bodies = await matchBodies(page)
      assert.deepEqual(bodies.map((b) => b.length), [200, 200, 50])
      const all = bodies.flat()
      assert.equal(new Set(all).size, 450, 'ни один id не отправлен дважды')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сервер сверки недоступен: итог создания сразу, «без папки или ожидают» — все созданные; без выдуманных чисел', async () => {
    const { page, errors, close } = await run(BASE.replace('signal=1', 'signal=down'), MIX)
    try {
      const got = await line(page)
      assert.equal(got.text, 'Signal: найдено 0 · требуют внимания 0 · без папки или ожидают 7')
      assert.match(got.title, /нет ответа сервера: 7$/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сервер сверки медленный: окно итога не ждёт («сверяем…»), через 5 с — «без папки или ожидают»', async () => {
    const { page, errors, close } = await run(`${BASE.replace('signal=1', 'signal=slow')}&signalDelay=9000`, MIX)
    try {
      const t0 = Date.now()
      await page.locator('.cim-signal', { hasText: 'Signal: сверяем созданные документы…' }).waitFor({ timeout: 4000 })
      const got = await line(page)
      const waited = Date.now() - t0
      assert.equal(got.text, 'Signal: найдено 0 · требуют внимания 0 · без папки или ожидают 7')
      assert.ok(waited >= 3000 && waited < 9000, `порция ждала ${waited} мс — бюджет 5 с`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сверка выключена, нет права правки или метка не включена в стенде: строки Signal нет, импорт как раньше', async () => {
    for (const query of [BASE.replace('signal=1&', ''), BASE.replace('signal=1', 'signal=off'), `${BASE}&signalEdit=0`]) {
      const { page, errors, close } = await run(query, ['СВЕР-1', 'ПРЕД-2'])
      try {
        await page.locator('.cim-result-big', { hasText: 'Создано договоров: 2' }).waitFor()
        await page.waitForTimeout(400)
        assert.equal(await page.locator('.cim-signal').count(), 0, query)
        assert.equal(await page.evaluate(() => (window.__signal?.calls || []).filter((c) => c.path === '/api/signal/match').length), 0, query)
        assert.deepEqual(errors, [], query)
      } finally { await close() }
    }
  })
})
