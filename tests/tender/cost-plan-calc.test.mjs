// «Планы затрат» → «Документы» → «Расчёт ПЗ» (миграция 20261116_cost_plan_calc): помощники (без браузера), миграции и
// страница в Chromium (стенд tests/tender/ui).
//   • подвкладки «Прямые затраты» и «КП до перекидок» — у каждой свой список файлов (s3_documents: owner_type 'general',
//     owner_id = строка section_templates подвкладки, doc_category 'cost_plan_calc'); загружает и удаляет только
//     администратор, остальные смотрят и скачивают;
//   • внизу — «Компенсация НДС и инфляции по объектам» (cost_plan_compensation): по строке на объект основного
//     строительства, НДС и инфляция рядом; вносит и меняет администратор, оба поля пустые — сведения удаляются;
//   • миграции нет — подсказки про обновление базы.
// Объекты стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  COMPENSATION_NOTE_MAX, COST_PLAN_CALC_CATEGORY, COST_PLAN_CALC_SECTIONS, compensationTable, parseCompensation,
} from '../../src/utils/costPlanCalc.js'

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')
const OBJECTS = [
  { id: 'o-1', name: 'ЖК  Северный 33', status: 'main_construction' },
  { id: 'o-2', name: 'ЖК Южный', status: 'main_construction' },
  { id: 'o-4', name: 'ЖК Гарантийный', status: 'warranty_service' },
  { id: 'o-5', name: 'ЖК Сданный', status: 'warranty_service' },
]
const ANCHORS = [
  { id: 'tpl-direct', code: 'cost_plan_direct_costs', title: 'Расчёт ПЗ: прямые затраты' },
  { id: 'tpl-kp', code: 'cost_plan_kp_before_transfers', title: 'Расчёт ПЗ: КП до перекидок' },
]

describe('Расчёт ПЗ: правила без базы и миграции', () => {
  it('таблица компенсации: основное строительство и объекты со сведениями, по алфавиту', () => {
    const rows = [
      { object_id: 'o-2', vat_note: ' ДС № 4: компенсация 2 % \r\n с 01.01.2026 ', inflation_note: null },
      { object_id: 'o-5', vat_note: null, inflation_note: 'Индексация 5 % в год' },
      { object_id: 'o-1', vat_note: '  ', inflation_note: '' },
    ]
    assert.deepEqual(compensationTable(OBJECTS, rows), [
      { id: 'o-5', label: 'ЖК Сданный', vat: null, inflation: 'Индексация 5 % в год', filled: true },
      { id: 'o-1', label: 'ЖК Северный 33', vat: null, inflation: null, filled: false },
      { id: 'o-2', label: 'ЖК Южный', vat: 'ДС № 4: компенсация 2 %\n с 01.01.2026', inflation: null, filled: true },
    ])
    assert.deepEqual(compensationTable(OBJECTS, []).map(r => r.label), ['ЖК Северный 33', 'ЖК Южный'])
  })

  it('форма: пробелы обрезаются, оба пустые — удалить, длиннее предела — ошибка', () => {
    assert.deepEqual(parseCompensation({ vat: ' 2 % ', inflation: '' }),
      { value: { vat_note: '2 %', inflation_note: null }, empty: false })
    assert.deepEqual(parseCompensation({ vat: ' ', inflation: '\n' }), { value: { vat_note: null, inflation_note: null }, empty: true })
    assert.match(parseCompensation({ vat: '', inflation: 'x'.repeat(COMPENSATION_NOTE_MAX + 1) }).error, /инфляции — не больше 2000/)
  })

  it('обе базы: та же таблица и те же якоря файлов; права — сотрудник читает, администратор пишет', () => {
    const supa = read('supabase/migrations/20261116_cost_plan_calc.sql')
    const yandex = read('migration/yandex/20261116_cost_plan_calc.sql')
    const ddl = (sql) => sql.match(/CREATE TABLE IF NOT EXISTS public\.cost_plan_compensation \([\s\S]*?\n\);/)[0]
    assert.equal(ddl(yandex), ddl(supa))
    assert.match(read('supabase/schemas/cost_plan_compensation.sql'), /vat_note text CHECK \(vat_note IS NULL OR length\(vat_note\) <= 2000\)/)
    for (const sql of [supa, yandex]) {
      for (const s of COST_PLAN_CALC_SECTIONS) assert.match(sql, new RegExp(`\\('${s.code}', 'Расчёт ПЗ: `), s.code)
      assert.match(sql, /cost_plan_compensation_read[\s\S]*?osp_is_employee\(\)/)
      assert.equal((sql.match(/cost_plan_compensation_(insert|update|delete) ON[\s\S]*?is_admin\(\)/g) || []).length, 3)
    }
    assert.match(supa, /REVOKE ALL ON TABLE public\.cost_plan_compensation FROM PUBLIC, anon, authenticated;/)
    assert.match(yandex, /-- osp:allow table cost_plan_compensation authenticated=select,insert,update,delete/)
    assert.deepEqual(JSON.parse(read('server/osp-api/src/data/allow.json')).tables.cost_plan_compensation,
      { authenticated: ['delete', 'insert', 'select', 'update'] })
    // Файлы загружает только администратор: владелец — строка section_templates (osp-api: WRITE_RULES).
    const presign = read('server/osp-api/src/routes/s3Presign.js')
    assert.match(presign, /general: \['psdc', 'vor_requests', 'section_templates'\]/)
    assert.match(presign, /section_templates: \[\['admin', 'edit'\]\]/)
    assert.match(read('tests/db/baseline/candidate-migrations.txt'), /^20261116_cost_plan_calc\.sql$/m)
  })
})

const launch = browserLaunchOptions()

describe('«Планы затрат» → «Документы» → «Расчёт ПЗ»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  // Данные стенда дополняются до открытия окна: якоря и сведения читаются при открытии вкладки.
  const openCalc = async ({ query = '', anchors = ANCHORS, rows = [], files = [], missing = [] } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/cost-plans&latency=0${query}`)
    await page.locator('.cost-plans-page .cp-table').first().waitFor({ timeout: 120000 })
    await page.evaluate(([objects, anchorRows, compRows, fileRows, missingTables]) => {
      const db = window.__fakeDb
      db.objects = [...db.objects.filter(o => !o.id.startsWith('o-')), ...objects]
      db.section_templates = anchorRows
      db.cost_plan_compensation = compRows
      db.s3_documents.push(...fileRows)
      for (const t of missingTables) {
        window.__fakeErrors = { ...(window.__fakeErrors || {}), [t]: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` } }
      }
      for (const t of ['objects', 'section_templates', 'cost_plan_compensation', 's3_documents']) window.__fakeTouch(t)
    }, [OBJECTS, anchors, rows, files, missing])
    await page.getByRole('button', { name: 'Документы' }).click()
    const modal = page.getByRole('dialog', { name: 'Документы раздела' })
    await modal.getByRole('tab', { name: 'Расчёт ПЗ' }).click()
    await modal.locator('.cpc-panel :is(.s3-doc-list, .tdm-note)').first().waitFor({ timeout: 10000 })
    await modal.locator('.cpc-comp :is(.cpc-table, .tdm-note, .tdm-site-empty-state:not(:has-text("Загрузка")))').first().waitFor({ timeout: 10000 })
    return { page, modal, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const calcFiles = (page) => page.evaluate((cat) => window.__fakeDb.s3_documents
    .filter((d) => d.doc_category === cat)
    .map((d) => ({ owner_type: d.owner_type, owner_id: d.owner_id, file_name: d.file_name })), COST_PLAN_CALC_CATEGORY)
  const tableRows = (modal) => modal.locator('.cpc-table tbody tr.cpc-row').evaluateAll((trs) => trs.map((tr) =>
    [...tr.querySelectorAll('th, td.cpc-note')].map((c) => c.textContent)))
  const xlsx = (name) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') })

  it('администратор: файлы каждой подвкладки — свой список; сведения о компенсации вносит, меняет и удаляет', async () => {
    const { page, modal, errors, close } = await openCalc({
      rows: [{ id: 'cc-1', object_id: 'o-5', vat_note: 'ДС № 2: 1 % из 2 %', inflation_note: null }],
    })
    try {
      // Вкладки окна и подвкладки расчёта.
      assert.deepEqual(await modal.locator('.tdm-tab').allTextContents(), ['Экономисты ОСП', 'Расчёт ПЗ'])
      assert.deepEqual(await modal.locator('.cpc-subtab').allTextContents(), ['Прямые затраты', 'КП до перекидок'])
      assert.equal(await modal.locator('.cpc-subtab.is-active').textContent(), 'Прямые затраты')
      assert.equal(await modal.locator('.s3-doc-title').textContent(), 'Прямые затраты')
      await modal.locator('.s3-doc-empty', { hasText: 'Документы не загружены' }).waitFor()

      await modal.locator('.s3-doc-list input[type=file]').setInputFiles([xlsx('ПЗ прямые затраты.xlsx')])
      await modal.locator('.s3-doc-name', { hasText: 'ПЗ прямые затраты.xlsx' }).waitFor({ timeout: 10000 })

      await modal.getByRole('tab', { name: 'КП до перекидок' }).click()
      assert.equal(await modal.locator('.s3-doc-title').textContent(), 'КП до перекидок')
      await modal.locator('.s3-doc-empty', { hasText: 'Документы не загружены' }).waitFor({ timeout: 10000 })
      await modal.locator('.s3-doc-list input[type=file]').setInputFiles([xlsx('КП до перекидок.xlsx')])
      await modal.locator('.s3-doc-name', { hasText: 'КП до перекидок.xlsx' }).waitFor({ timeout: 10000 })
      assert.equal(await modal.locator('.s3-doc-name').count(), 1)
      assert.deepEqual(await calcFiles(page), [
        { owner_type: 'general', owner_id: 'tpl-direct', file_name: 'ПЗ прямые затраты.xlsx' },
        { owner_type: 'general', owner_id: 'tpl-kp', file_name: 'КП до перекидок.xlsx' },
      ])

      // Компенсация: основное строительство + объект на гарантии со сведениями; гарантийный без сведений — нет.
      assert.deepEqual(await tableRows(modal), [
        ['Бизнес-центр «Нурлы»', 'не указано', 'не указано'],
        ['ЖК «Северный квартал»', 'не указано', 'не указано'],
        ['ЖК Сданный', 'ДС № 2: 1 % из 2 %', 'не указано'],
        ['ЖК Северный 33', 'не указано', 'не указано'],
        ['ЖК Южный', 'не указано', 'не указано'],
      ])
      await modal.getByRole('button', { name: 'Изменить сведения о компенсации: ЖК Южный' }).click()
      const vat = modal.getByRole('textbox', { name: 'Компенсация НДС: ЖК Южный' })
      const inflation = modal.getByRole('textbox', { name: 'Инфляция: ЖК Южный' })
      assert.equal(await vat.evaluate((el) => el === document.activeElement), true)
      // Пока правится одна строка, другие не открываются.
      assert.equal(await modal.getByRole('button', { name: 'Изменить сведения о компенсации: ЖК Сданный' }).isDisabled(), true)
      await vat.fill('Компенсировано 2 %\nДС № 7 от 12.05.2026')
      await inflation.fill('Есть, 4 % в год')
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await modal.locator('.cpc-row[data-object-id="o-2"] .cpc-note', { hasText: 'Есть, 4 % в год' }).waitFor({ timeout: 10000 })
      assert.deepEqual(await page.evaluate(() => window.__fakeDb.cost_plan_compensation
        .filter((r) => r.object_id === 'o-2').map((r) => [r.vat_note, r.inflation_note])),
      [['Компенсировано 2 %\nДС № 7 от 12.05.2026', 'Есть, 4 % в год']])
      // Переносы строк видны.
      assert.equal(await modal.locator('.cpc-row[data-object-id="o-2"] .cpc-note').first().evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-line')

      // Escape в поле — отмена правки, окно остаётся.
      await modal.getByRole('button', { name: 'Изменить сведения о компенсации: ЖК Северный 33' }).click()
      await modal.getByRole('textbox', { name: 'Компенсация НДС: ЖК Северный 33' }).fill('не сохранять')
      await page.keyboard.press('Escape')
      await modal.locator('.cpc-input').first().waitFor({ state: 'detached', timeout: 5000 })
      assert.equal(await modal.isVisible(), true)
      assert.equal(await page.evaluate(() => window.__fakeDb.cost_plan_compensation.some((r) => r.object_id === 'o-1')), false)

      // Оба поля пустые — сведения объекта удаляются (одна строка на объект и не копится).
      await modal.getByRole('button', { name: 'Изменить сведения о компенсации: ЖК Южный' }).click()
      await modal.getByRole('textbox', { name: 'Компенсация НДС: ЖК Южный' }).fill('')
      await modal.getByRole('textbox', { name: 'Инфляция: ЖК Южный' }).fill('  ')
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await modal.locator('.cpc-input').first().waitFor({ state: 'detached', timeout: 5000 })
      assert.equal(await page.evaluate(() => window.__fakeDb.cost_plan_compensation.some((r) => r.object_id === 'o-2')), false)
      assert.deepEqual((await tableRows(modal)).find((r) => r[0] === 'ЖК Южный'), ['ЖК Южный', 'не указано', 'не указано'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права администратора: только просмотр и скачивание', async () => {
    const files = [{ id: 'f-1', owner_type: 'general', owner_id: 'tpl-kp', doc_category: COST_PLAN_CALC_CATEGORY,
      s3_key: 'general/tpl-kp/1-КП.xlsx', file_name: 'КП.xlsx', size_bytes: 20480, created_at: '2026-10-29T08:00:00Z' }]
    const { modal, errors, close } = await openCalc({
      query: '&canEdit=0', files,
      rows: [{ id: 'cc-1', object_id: 'o-2', vat_note: '2 %', inflation_note: 'нет' }],
    })
    try {
      assert.equal(await modal.locator('.s3-doc-btn-primary').count(), 0, 'загрузить нельзя')
      await modal.getByRole('tab', { name: 'КП до перекидок' }).click()
      await modal.locator('.s3-doc-name', { hasText: 'КП.xlsx' }).waitFor({ timeout: 10000 })
      assert.equal(await modal.getByRole('button', { name: 'Скачать' }).count(), 1)
      assert.equal(await modal.getByRole('button', { name: 'Удалить' }).count(), 0)
      assert.equal(await modal.locator('.cpc-edit').count(), 0, 'менять сведения нельзя')
      assert.deepEqual((await tableRows(modal)).find((r) => r[0] === 'ЖК Южный'), ['ЖК Южный', '2 %', 'нет'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    // Сведений нет ни у одного объекта — без пустой таблицы.
    const empty = await openCalc({ query: '&canEdit=0' })
    try {
      await empty.modal.locator('.cpc-comp .tdm-site-empty-state', { hasText: 'Сведения о компенсации ещё не внесены.' }).waitFor()
      assert.equal(await empty.modal.locator('.cpc-table').count(), 0)
    } finally {
      await empty.close()
    }
  })

  it('миграции ещё нет: подсказки про обновление базы, окно работает', async () => {
    const { modal, errors, close } = await openCalc({ anchors: [], missing: ['cost_plan_compensation'] })
    try {
      assert.match(await modal.locator('.cpc-panel .tdm-note').textContent(), /после обновления базы \(миграция 20261116_cost_plan_calc\)/)
      assert.match(await modal.locator('.cpc-comp .tdm-note').textContent(), /после обновления базы \(миграция 20261116_cost_plan_calc\)/)
      await modal.getByRole('tab', { name: 'КП до перекидок' }).click()
      await modal.locator('.cpc-panel .tdm-note').waitFor()
      await modal.getByRole('tab', { name: 'Экономисты ОСП' }).click()
      assert.equal(await modal.locator('.tdm-tab.is-active').textContent(), 'Экономисты ОСП')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
