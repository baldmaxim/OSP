// «Заявки на ДС»: суммы — один блок из двух частей у каждой заявки (решения пользователя 06.11.2026, образец — картинка):
// «Было ПСДЦ / ДС подрядчика / Согласовано ДС ОСП» и под двойной чертой «Было ВОР подрядчик / Стало ВОР ОСП». Тип ДС
// суммы между частями не переносит; миграция 20270104 добавила колонки и разово перенесла суммы «ДС по тендеру» вниз.
// Там же — прокрутка реестра: у блока таблицы непрозрачный фон, иначе Chrome растеризует таблицу на каждом кадре.
// Стенд tests/tender/ui (route=/dc-requests&dcStats=1&shell=1; колонки 20270104 — строкам стенда добавляет тест).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  AMOUNT_EXPORT_COLUMNS, amountDelta, amountExportCells, amountSections, deltaText, hasAmountColumns, requestTotals,
} from '../../src/utils/dcRequestAmounts.js'
import { computeDcStats } from '../../src/utils/dcRequestStats.js'
import { chromium } from 'playwright'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const SUPABASE = path.join(ROOT, 'supabase/migrations/20270104_dc_request_amounts_vor.sql')
const YANDEX = path.join(ROOT, 'migration/yandex/20270104_dc_request_amounts_vor.sql')
const YANDEX_CHECK = path.join(ROOT, 'migration/yandex/20270104_dc_request_amounts_vor.check.sql')
const PROD_CHECK = path.join(ROOT, 'migration/backup/checks/20270104.sql')
const ROLLBACK = path.join(ROOT, 'migration/rollback/20270104_dc_request_amounts_vor_rollback.sql')

// Разряды Intl — неразрывные пробелы; в проверках — обычные.
const plain = (s) => (s == null ? s : String(s).replace(/[\u00a0\u202f]/g, ' '))
const text = (delta) => {
  const t = deltaText(delta)
  return t && { dir: t.dir, abs: plain(t.abs), pct: t.pct }
}
const shape = (sections) => sections.map(s => [s.key, s.rows.map(r => [r.kind, r.label, r.field ?? null, r.tone ?? null])])

describe('Суммы заявки на ДС: правила', () => {
  it('числа образца: дельты «стало − было», процент от «было», два знака', () => {
    const psdc = 28177624
    const contractor = 32793854.75
    const osp = 31958042.66
    assert.deepEqual(text(amountDelta(psdc, contractor)), { dir: 'up', abs: '↑ +4 616 230,75 ₽', pct: '+16,38%' })
    assert.deepEqual(text(amountDelta(contractor, osp)), { dir: 'down', abs: '↓ −835 812,09 ₽', pct: '−2,55%' })
    assert.deepEqual(text(amountDelta(psdc, osp)), { dir: 'up', abs: '↑ +3 780 418,66 ₽', pct: '+13,42%' })
    assert.deepEqual(text(amountDelta(500000, 450000)), { dir: 'down', abs: '↓ −50 000,00 ₽', pct: '−10,00%' })
  })

  it('без изменений, «было» 0, отрицательные суммы, нет одной из сумм', () => {
    assert.deepEqual(text(amountDelta(100, 100)), { dir: 'zero', abs: 'без изменений', pct: null })
    assert.deepEqual(text(amountDelta(0, 100)), { dir: 'up', abs: '↑ +100,00 ₽', pct: null })
    // ДС на уменьшение: −1 000 000 → −1 200 000 — стоимость снизилась ещё на 200 000, это −20 %.
    assert.deepEqual(text(amountDelta(-1000000, -1200000)), { dir: 'down', abs: '↓ −200 000,00 ₽', pct: '−20,00%' })
    assert.equal(amountDelta(null, 100), null)
    assert.equal(amountDelta(100, null), null)
    assert.equal(deltaText(null), null)
  })

  it('две части у каждой заявки, как на образце; тип ДС ничего не переносит', () => {
    const full = {
      amount_before: 28177624, amount_contractor: 32793854.75, amount_after: 31958042.66,
      vor_amount_before: 500000, vor_amount_after: 450000,
    }
    const picture = [
      ['psdc', [
        ['head', 'Было ПСДЦ', 'amount_before', null],
        ['value', 'ДС подрядчика', 'amount_contractor', null],
        ['delta', 'Дельта к ПСДЦ', null, 'contractor'],
        ['value', 'Согласовано ДС ОСП', 'amount_after', null],
        ['delta', 'Дельта ОСП', null, 'osp'],
        ['total', 'Дельта к ПСДЦ', null, null],
      ]],
      ['vor', [
        ['head', 'Было ВОР подрядчик', 'vor_amount_before', null],
        ['value', 'Стало ВОР ОСП', 'vor_amount_after', null],
        ['delta', 'Дельта ОСП', null, 'osp'],
      ]],
    ]
    for (const dsType of ['psdc_change', 'tender_ds', null]) {
      assert.deepEqual(shape(amountSections({ ...full, ds_type: dsType })), picture, String(dsType))
    }
    // «ДС по тендеру» с суммами в верхней части (внесли руками) — они там и остаются.
    const tender = amountSections({ ds_type: 'tender_ds', amount_before: 7, vor_amount_before: null })
    assert.equal(tender[0].rows[0].value, 7)
    assert.equal(tender[1].rows[0].value, null)
  })

  it('пустой «ДС подрядчика» — без своих дельт; пустая часть — только суммы', () => {
    assert.deepEqual(shape(amountSections({ amount_before: 1, amount_after: 2 })), [
      ['psdc', [
        ['head', 'Было ПСДЦ', 'amount_before', null],
        ['value', 'ДС подрядчика', 'amount_contractor', null],
        ['value', 'Согласовано ДС ОСП', 'amount_after', null],
        ['total', 'Дельта к ПСДЦ', null, null],
      ]],
      ['vor', [
        ['head', 'Было ВОР подрядчик', 'vor_amount_before', null],
        ['value', 'Стало ВОР ОСП', 'vor_amount_after', null],
      ]],
    ])
  })

  it('до миграции 20270104: только верхняя часть, «ДС подрядчика» не вводится', () => {
    assert.equal(hasAmountColumns([{ id: 'a', amount_before: 1 }]), false)
    assert.equal(hasAmountColumns([{ id: 'a', vor_amount_before: null }]), true)
    assert.equal(hasAmountColumns([]), false)
    assert.deepEqual(shape(amountSections({ amount_before: 1, amount_contractor: 5 }, { columns: false })), [
      ['psdc', [['head', 'Было ПСДЦ', 'amount_before', null], ['value', 'ДС подрядчика', null, null], ['value', 'Согласовано ДС ОСП', 'amount_after', null]]],
    ])
  })

  it('отчёт и карточка контрагента: «было» = ПСДЦ + ВОР подрядчика, «утверждено» = ДС ОСП + ВОР ОСП', () => {
    assert.deepEqual(requestTotals({ amount_before: 100, vor_amount_before: 50.005, amount_after: null, vor_amount_after: 40 }),
      { before: 150.01, after: 40 })
    assert.deepEqual(requestTotals({ amount_before: null }), { before: null, after: null })
    const stats = computeDcStats([
      { id: '1', status: 'in_work', ds_type: 'tender_ds', vor_amount_before: 500000, vor_amount_after: 450000 },
      { id: '2', status: 'in_work', amount_before: 1000, amount_after: 900 },
    ])
    assert.equal(stats.amounts.submitted, 501000)
    assert.equal(stats.amounts.approved, 450900)
  })

  it('выгрузка: суммы обеих частей и их дельты', () => {
    const cells = amountExportCells({
      ds_type: 'tender_ds', amount_before: 1000, amount_contractor: 1100, amount_after: 900,
      vor_amount_before: 500000, vor_amount_after: 450000,
    })
    assert.deepEqual(Object.keys(cells), AMOUNT_EXPORT_COLUMNS)
    assert.deepEqual(Object.values(cells), [1000, 1100, 900, -100, -10, 500000, 450000, -50000, -10])
    assert.deepEqual(Object.values(amountExportCells({ amount_before: 7 })), [7, '', '', '', '', '', '', '', ''])
  })

  it('миграции обеих баз делают одно и то же', () => {
    const body = (file) => fs.readFileSync(file, 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '10s');\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    assert.equal(body(YANDEX), body(SUPABASE))
  })
})

const BOOTSTRAP = `
CREATE TABLE public.dc_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ds_number text, ds_type text,
  amount_before numeric(14, 2), amount_after numeric(14, 2));
ALTER TABLE public.dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dc_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dc_requests_all ON public.dc_requests FOR ALL USING (true) WITH CHECK (true);
CREATE TABLE public.dc_request_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dc_request_id uuid NOT NULL REFERENCES public.dc_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL, field_name text, old_value jsonb, new_value jsonb, description text,
  changed_at timestamptz NOT NULL DEFAULT now(), changed_by_role text, changed_by_name text);
INSERT INTO public.dc_requests (ds_number, ds_type, amount_before, amount_after) VALUES
  ('tender-1', 'tender_ds', 500000, 450000),
  ('tender-2', 'tender_ds', NULL, 300),
  ('tender-empty', 'tender_ds', NULL, NULL),
  ('psdc-1', 'psdc_change', 28177624, 31958042.66),
  ('none-1', NULL, 10, NULL);
`

describe('Суммы заявки на ДС в базе (20270104)', { skip: pgAvailable() ? false : 'Нет PostgreSQL' }, () => {
  let db
  const lines = (out) => out.split('\n').filter(Boolean)
  const isAllOk = (out) => out.length >= 4 && out.every(l => l.startsWith('OK '))
  // Колонки ВОР — через to_jsonb: после отката их нет.
  const rows = () => db.exec(`SELECT r.ds_number || '|' || coalesce(r.amount_before::text, '-') || '|' || coalesce(r.amount_after::text, '-')
      || '|' || coalesce(to_jsonb(r) ->> 'vor_amount_before', '-') || '|' || coalesce(to_jsonb(r) ->> 'vor_amount_after', '-')
    FROM public.dc_requests r ORDER BY r.ds_number;`).trim().split('\n')
  const moved = () => Number(db.exec(`SELECT count(*) FROM public.dc_request_audit_log WHERE description LIKE '%(миграция 20270104)';`).trim())

  before(() => {
    db = new TestDatabase()
    db.start()
    db.exec(BOOTSTRAP)
  })
  after(() => db?.stop())

  it('до миграции — FAIL, а не ошибка; перенос «ДС по тендеру» вниз — один раз, с записью в истории; откат возвращает', () => {
    const early = lines(db.exec(fs.readFileSync(PROD_CHECK, 'utf8')))
    assert.ok(early.every(l => /^(OK|FAIL) /.test(l)) && early.some(l => l.startsWith('FAIL ')), early.join('\n'))

    db.applyFile(SUPABASE)
    assert.deepEqual(rows(), [
      'none-1|10.00|-|-|-',
      'psdc-1|28177624.00|31958042.66|-|-',
      'tender-1|-|-|500000.00|450000.00',
      'tender-2|-|-|-|300.00',
      'tender-empty|-|-|-|-',
    ])
    assert.equal(moved(), 2, 'запись в истории — у каждой перенесённой, у пустой — нет')
    const note = db.exec(`SELECT changed_by_name || '|' || field_name || '|' || (new_value ->> 'vor_amount_before')
      FROM public.dc_request_audit_log l JOIN public.dc_requests r ON r.id = l.dc_request_id WHERE r.ds_number = 'tender-1';`).trim()
    assert.equal(note, 'Перенос данных|vor_amount_before|500000.00')
    for (const file of [PROD_CHECK, YANDEX_CHECK]) {
      const out = lines(db.exec(fs.readFileSync(file, 'utf8')))
      assert.ok(isAllOk(out), `${path.basename(file)}:\n${out.join('\n')}`)
    }

    // После миграции в верхнюю часть «ДС по тендеру» внесли сумму — повтор миграции её не трогает.
    db.exec(`UPDATE public.dc_requests SET amount_before = 1, amount_contractor = 2 WHERE ds_number = 'tender-empty';`)
    db.applyFile(SUPABASE)
    assert.equal(rows()[4], 'tender-empty|1.00|-|-|-')
    assert.equal(moved(), 2)

    db.applyFile(ROLLBACK)
    assert.deepEqual(rows().map(r => r.split('|').slice(0, 3).join('|')), [
      'none-1|10.00|-', 'psdc-1|28177624.00|31958042.66', 'tender-1|500000.00|450000.00', 'tender-2|-|300.00', 'tender-empty|1.00|-',
    ])
    assert.equal(db.exec(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'dc_requests'
      AND column_name IN ('amount_contractor', 'vor_amount_before', 'vor_amount_after');`).trim(), '0')
    db.applyFile(ROLLBACK)
  })
})

describe('Реестр заявок на ДС: суммы и прокрутка', { skip: !launch && 'Нет Chromium/Chrome/Edge (PSDC_BROWSER)' }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(ROOT)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  // columns — колонки 20270104 в базе стенда (суммы образца у d4, у «ДС по тендеру» d3 — только ВОР); затем реестр
  // открывается заново (данные в памяти сохраняются).
  async function open(extra = '', { width = 1920, columns = true } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width, height: 1000 }, hasTouch: width < 700 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=10&shell=1${extra}`)
    const rowSel = width < 700 ? '.mcard' : '.dcr-table td.ui-rownum'
    await page.locator(rowSel).first().waitFor({ timeout: 120000 })
    await page.evaluate((withColumns) => {
      const rows = window.__fakeDb.dc_requests
      const set = (id, over) => Object.assign(rows.find(r => r.id === id), over)
      if (withColumns) {
        for (const r of rows) Object.assign(r, { amount_contractor: null, vor_amount_before: null, vor_amount_after: null })
        set('d4', { amount_before: 28177624, amount_contractor: 32793854.75, amount_after: 31958042.66,
          vor_amount_before: 500000, vor_amount_after: 450000 })
        set('d3', { ds_type: 'tender_ds', amount_before: null, amount_after: null, vor_amount_before: 500000, vor_amount_after: 450000 })
      } else {
        set('d4', { amount_before: 28177624, amount_after: 31958042.66 })
      }
      window.__navigate('/general')
    }, columns)
    await page.waitForFunction(() => !document.querySelector('.dc-requests-page'))
    await page.evaluate(() => window.__navigate('/dc-requests'))
    await page.locator(rowSel).first().waitFor({ timeout: 60000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  // Блок как текст: части через «‖», в части — «подпись = сумма» и дельты строками; сумма — из поля или надписи.
  const blockOf = (scope) => scope.locator('.dca').evaluate((el) => {
    const val = (row) => {
      const v = row.querySelector('input, .dca-value, .dca-head-value')
      return (v?.tagName === 'INPUT' ? (v.value || '—') : v?.textContent || '').trim()
    }
    return [...el.querySelectorAll('.dca-part')].map((part) => {
      const lines = [`${part.querySelector('.dca-head-label').textContent} = ${val(part.querySelector('.dca-head'))}`]
      for (const row of part.querySelectorAll('.dca-body > *')) {
        if (row.classList.contains('dca-row')) lines.push(`${row.querySelector('.dca-label').textContent} = ${val(row)}`)
        else lines.push(`${row.querySelector('.dca-label').textContent}: ${row.querySelector('.dca-delta-val').textContent}`)
      }
      return lines.join('\n')
    }).join('\n‖\n').replace(/[\u00a0\u202f]/g, ' ')
  })
  const row = (page, ds) => page.locator('.dcr-table tbody tr', { hasText: `ДС-${ds}` }).first()
  const PICTURE = [
    'Было ПСДЦ = 28 177 624,00',
    'ДС подрядчика = 32 793 854,75',
    'Дельта к ПСДЦ: ↑ +4 616 230,75 ₽+16,38%',
    'Согласовано ДС ОСП = 31 958 042,66',
    'Дельта ОСП: ↓ −835 812,09 ₽−2,55%',
    'Дельта к ПСДЦ: ↑ +3 780 418,66 ₽+13,42%',
    '‖',
    'Было ВОР подрядчик = 500 000,00',
    'Стало ВОР ОСП = 450 000,00',
    'Дельта ОСП: ↓ −50 000,00 ₽−10,00%',
  ].join('\n')

  it('у каждой заявки — обе части, как на образце; «ДС по тендеру» — суммы в нижней части', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await blockOf(row(page, 'd4')), PICTURE)
      assert.equal(await blockOf(row(page, 'd3')), [
        'Было ПСДЦ = —', 'ДС подрядчика = —', 'Согласовано ДС ОСП = —', '‖',
        'Было ВОР подрядчик = 500 000,00', 'Стало ВОР ОСП = 450 000,00', 'Дельта ОСП: ↓ −50 000,00 ₽−10,00%',
      ].join('\n'))
      // Части разделены двойной чертой; рост — оранжевым, снижение — зелёным.
      const split = await row(page, 'd4').locator('.dca-part--vor').evaluate((el) => getComputedStyle(el).borderTopStyle)
      assert.equal(split, 'double')
      const colors = await page.evaluate(() => ['.is-up', '.is-down'].map(s => getComputedStyle(document.querySelector(`.dca-delta${s} .dca-delta-val`)).color))
      assert.notEqual(colors[0], colors[1])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('суммы правятся в блоке, «ДС подрядчика» тоже; смена типа ДС ничего не переносит', async () => {
    const { page, errors, close } = await open()
    try {
      // Как человек: щелчок, выделить всё, набрать (fill выделяет текст до того, как поле в фокусе сменит вид суммы).
      const type = async (locator, value) => {
        await locator.click()
        await locator.press('Control+a')
        await locator.pressSequentially(value)
        await locator.press('Enter') // Enter снимает фокус; Tab увёл бы его в соседнее поле суммы
      }
      const db = (id, field) => page.evaluate(([rid, f]) => window.__fakeDb.dc_requests.find(r => r.id === rid)[f], [id, field])
      // История пишется следом за записью суммы — ждём её, а не читаем сразу.
      const audit = async (id) => {
        await page.waitForFunction((rid) => window.__fakeDb.dc_request_audit_log
          .some(e => e.dc_request_id === rid && e.event_type === 'field_updated'), id)
        return page.evaluate((rid) => window.__fakeDb.dc_request_audit_log
          .filter(e => e.dc_request_id === rid && e.event_type === 'field_updated').map(e => e.description.replace(/[\u00a0\u202f]/g, ' ')), id)
      }

      await type(row(page, 'd1').getByLabel('ДС подрядчика'), '1200000')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd1').amount_contractor === 1200000)
      assert.deepEqual(await audit('d1'), ['ДС подрядчика: — → 1 200 000,00 ₽'])
      // У d1 «Было ПСДЦ» 1 000 000 — появилась дельта подрядчика к ПСДЦ.
      assert.match(await blockOf(row(page, 'd1')), /ДС подрядчика = 1 200 000,00\nДельта к ПСДЦ: ↑ \+200 000,00 ₽\+20,00%/)

      await type(row(page, 'd3').getByLabel('Было ВОР подрядчик'), '600000')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd3').vor_amount_before === 600000)
      assert.deepEqual(await audit('d3'), ['Было ВОР подрядчик: 500 000,00 ₽ → 600 000,00 ₽'])

      await row(page, 'd3').getByLabel('Тип ДС').selectOption('psdc_change')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd3').ds_type === 'psdc_change')
      assert.match(await blockOf(row(page, 'd3')), /^Было ПСДЦ = —\n.*‖\nБыло ВОР подрядчик = 600 000,00\nСтало ВОР ОСП = 450 000,00\n/s)
      assert.equal(await db('d3', 'amount_before'), null)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма заявки: пять сумм с подписями блока; запись — в свои колонки', async () => {
    const { page, errors, close } = await open()
    try {
      await row(page, 'd3').getByRole('button', { name: 'Редактировать' }).click()
      const labels = await page.locator('.modal label[for^="dcr-form-"][for*="amount"]').allInnerTexts()
      assert.deepEqual(labels, ['Было ПСДЦ, ₽ (с НДС 22%)', 'ДС подрядчика, ₽ (с НДС 22%)', 'Согласовано ДС ОСП, ₽ (с НДС 22%)',
        'Было ВОР подрядчик, ₽ (с НДС 22%)', 'Стало ВОР ОСП, ₽ (с НДС 22%)'])
      assert.equal(await page.locator('#dcr-form-vor_amount_after').inputValue(), '450000')
      await page.locator('#dcr-form-amount_contractor').fill('700')
      await page.locator('.modal button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(r => r.id === 'd3').amount_contractor === 700)
      assert.equal(await page.evaluate(() => window.__fakeDb.dc_requests.find(r => r.id === 'd3').vor_amount_after), 450000)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без колонок 20270104 — только верхняя часть, «ДС подрядчика» не вводится, в форме две суммы', async () => {
    const { page, errors, close } = await open('', { columns: false })
    try {
      assert.equal(await blockOf(row(page, 'd4')), [
        'Было ПСДЦ = 28 177 624,00', 'ДС подрядчика = —', 'Согласовано ДС ОСП = 31 958 042,66',
        'Дельта к ПСДЦ: ↑ +3 780 418,66 ₽+13,42%',
      ].join('\n'))
      assert.equal(await row(page, 'd4').getByLabel('ДС подрядчика').count(), 0)
      await row(page, 'd4').getByRole('button', { name: 'Редактировать' }).click()
      assert.deepEqual(await page.locator('.modal label[for^="dcr-form-"][for*="amount"]').allInnerTexts(),
        ['Было ПСДЦ, ₽ (с НДС 22%)', 'Согласовано ДС ОСП, ₽ (с НДС 22%)'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки — суммы надписью, без полей', async () => {
    const { page, close } = await open('&noEdit=dc_requests')
    try {
      assert.equal(await row(page, 'd4').locator('.dca input').count(), 0)
      assert.equal(await blockOf(row(page, 'd4')), PICTURE)
    } finally { await close() }
  })

  it('телефон: тот же блок в карточке', async () => {
    const { page, close } = await open('', { width: 390 })
    try {
      assert.equal(await blockOf(page.locator('.mcard', { hasText: 'ДС-d4' })), PICTURE)
    } finally { await close() }
  })

  // 06.11.2026: «очень сильно лагает окно прокрутки». Прозрачный прокручиваемый блок Chrome на мониторе с масштабом 100 %
  // прокручивает без своего слоя — растеризует всю видимую таблицу на каждом кадре (стенд, 400 заявок: 95 мс на кадр, с
  // фоном — 17–21 мс). Время кадра в тесте нестабильно, поэтому сторожим причину: фон блока непрозрачный.
  it('блок таблицы прокручивается сам и непрозрачен', async () => {
    const { page, close } = await open('&dcMany=40')
    try {
      const box = await page.locator('.table-container').evaluate((el) => {
        const cs = getComputedStyle(el)
        return { scrolls: el.scrollHeight > el.clientHeight, overflowY: cs.overflowY, bg: cs.backgroundColor }
      })
      assert.ok(box.scrolls && box.overflowY === 'auto', `таблица должна прокручиваться в своём блоке: ${JSON.stringify(box)}`)
      const alpha = /^rgba\(/.test(box.bg) ? Number(box.bg.split(',')[3].replace(')', '')) : 1
      assert.equal(alpha, 1, `фон блока таблицы прозрачен (${box.bg}) — прокрутка снова будет перерисовывать таблицу`)
    } finally { await close() }
  })
})
