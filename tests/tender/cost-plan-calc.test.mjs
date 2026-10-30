// «Планы затрат» → «Документы» → «Расчёт ПЗ» (миграции 20261116_cost_plan_calc, 20261121_cost_plan_calc_objects):
// помощники (без браузера), миграции и страница в Chromium (стенд tests/tender/ui). Устройство — по схеме
// пользователя 30.10 (компенсация больше не повторяется под каждой подвкладкой):
//   • «Инструкции» — общие файлы «Прямые затраты» и «КП до перекидок» (s3_documents: owner_type 'general', owner_id =
//     строка section_templates, doc_category 'cost_plan_calc');
//   • «По объектам» — карточка на объект: слева документы объекта (owner_type 'object', doc_category — вид), справа
//     «Компенсация НДС» и под ней «Инфляция»: да / нет, процент, подтверждающий документ из «Документов» карточки
//     объекта (ссылка открывает его там подсвеченным), примечание;
//   • загружает, удаляет и вносит только администратор; без права правки — только объекты, где что-то внесено;
//   • миграций нет — подсказки про обновление базы; нет колонок 20261121 — только примечания.
// Объекты стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  COMPENSATION_NOTE_MAX, COST_PLAN_CALC_CATEGORY, COST_PLAN_CALC_SECTIONS, calcObjectCards, compensationForm,
  formatPercent, objectDocHref, objectDocLabel, objectDocOptions, objectMatches, parseCompensation, parsePercent,
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
// «Документы» карточек объектов: у Южного — договор генподряда, два ДС (порядок — order_number) и приложение к ДС.
const OBJECT_DOCS = [
  { id: 'od-2b', object_id: 'o-2', document_type: 'additional_agreement', name: 'ДС № 2', document_number: null, document_date: '2026-04-15', notes: 'Компенсация НДС 1,5 %', parent_document_id: null, order_number: 2, created_at: '2026-04-15T09:00:00Z' },
  { id: 'od-2gc', object_id: 'o-2', document_type: 'general_contract', name: 'Договор генподряда', document_number: 'ГП-7', document_date: '2025-02-01', notes: null, parent_document_id: null, order_number: 0, created_at: '2025-02-01T09:00:00Z' },
  { id: 'od-2a', object_id: 'o-2', document_type: 'additional_agreement', name: 'ДС № 1', document_number: null, document_date: '2026-03-10', notes: null, parent_document_id: null, order_number: 1, created_at: '2026-03-10T09:00:00Z' },
  { id: 'od-2a-1', object_id: 'o-2', document_type: 'attachment', name: 'Приложение 1 к ДС № 1', document_number: null, document_date: null, notes: null, parent_document_id: 'od-2a', order_number: 0, created_at: '2026-03-10T10:00:00Z' },
  { id: 'od-1a', object_id: 'o-1', document_type: 'additional_agreement', name: 'ДС № 5', document_number: null, document_date: '2026-05-01', notes: null, parent_document_id: null, order_number: 0, created_at: '2026-05-01T09:00:00Z' },
]
const file = (id, ownerType, ownerId, category, name) => ({
  id, owner_type: ownerType, owner_id: ownerId, doc_category: category, s3_key: `x/${ownerId}/${id}-${name}`,
  file_name: name, mime_type: 'application/pdf', size_bytes: 20480, uploaded_by_name: 'Администратор', created_at: '2026-10-29T08:00:00Z',
})

describe('Расчёт ПЗ: правила без базы и миграции', () => {
  it('карточки: основное строительство и объекты со сведениями или документами, по алфавиту', () => {
    const rows = [
      { object_id: 'o-2', vat_compensated: true, vat_percent: 2, vat_document_id: 'od-2b', vat_note: ' по ДС \r\n с 01.01.2026 ', inflation_compensated: false, inflation_percent: null, inflation_document_id: null, inflation_note: null },
      { object_id: 'o-5', vat_compensated: null, vat_note: null, inflation_note: 'Индексация 5 % в год' },
    ]
    const files = [
      file('f-1', 'object', 'o-4', 'cost_plan_kp_before_transfers', 'КП.pdf'),
      file('f-2', 'object', 'o-2', 'cost_plan_direct_costs', 'ПЗ.pdf'),
      file('f-3', 'object', 'o-2', 'dgp', 'ДГП.xlsx'), // другая категория объекта — не расчёт ПЗ
    ]
    const cards = calcObjectCards(OBJECTS, rows, files)
    assert.deepEqual(cards.map(c => [c.label, c.filled, c.hasFiles]), [
      ['ЖК Гарантийный', false, true],
      ['ЖК Сданный', true, false],
      ['ЖК Северный 33', false, false],
      ['ЖК Южный', true, true],
    ])
    const south = cards.at(-1)
    assert.deepEqual(south.vat, { compensated: true, percent: 2, documentId: 'od-2b', note: 'по ДС\n с 01.01.2026' })
    assert.deepEqual(south.inflation, { compensated: false, percent: null, documentId: null, note: null })
    assert.deepEqual(south.files.direct.map(f => f.id), ['f-2'])
    assert.deepEqual(south.files.kp, [])
    assert.deepEqual(calcObjectCards(OBJECTS, [], []).map(c => c.label), ['ЖК Северный 33', 'ЖК Южный'])
    assert.equal(objectMatches('ЖК «Солнечный»', 'солнеч'), true)
    assert.equal(objectMatches('ЖК Берёзовый', 'березовый'), true)
    assert.equal(objectMatches('ЖК Южный', 'север'), false)
  })

  it('форма: процент и документ — только при «да», ничего не указано — удалить, ошибки', () => {
    assert.equal(parsePercent(' 1,5 % '), 1.5)
    assert.equal(parsePercent(''), null)
    for (const bad of ['0', '150', 'два', '1,555', '-2']) assert.equal(parsePercent(bad), undefined, bad)
    assert.equal(formatPercent(2), '2\u00a0%')
    assert.equal(formatPercent('1.50'), '1,5\u00a0%')

    const form = {
      vat: { state: 'yes', percent: '1,5', documentId: 'od-2b', note: ' ДС подписан ' },
      inflation: { state: 'no', percent: '4', documentId: 'od-2a', note: '' },
    }
    assert.deepEqual(parseCompensation(form), {
      value: {
        vat_note: 'ДС подписан', vat_compensated: true, vat_percent: 1.5, vat_document_id: 'od-2b',
        inflation_note: null, inflation_compensated: false, inflation_percent: null, inflation_document_id: null,
      },
      empty: false,
    })
    const none = { state: '', percent: '', documentId: '', note: ' ' }
    assert.equal(parseCompensation({ vat: none, inflation: none }).empty, true)
    assert.match(parseCompensation({ ...form, vat: { ...form.vat, percent: '150' } }).error, /Процент по НДС — число больше 0 и не больше 100/)
    assert.match(parseCompensation({ vat: none, inflation: { ...none, note: 'x'.repeat(COMPENSATION_NOTE_MAX + 1) } }).error, /Примечание по инфляции — не больше 2000/)
    // Колонок 20261121 нет — только примечания.
    assert.deepEqual(parseCompensation(form, { detailed: false }), { value: { vat_note: 'ДС подписан', inflation_note: null }, empty: false })
    // Карточка → форма → те же значения.
    const [card] = calcObjectCards([OBJECTS[1]], [{ object_id: 'o-2', vat_compensated: true, vat_percent: 1.5, vat_document_id: 'od-2b', vat_note: null, inflation_compensated: null, inflation_note: null }])
    assert.deepEqual(compensationForm(card), {
      vat: { state: 'yes', percent: '1,5', documentId: 'od-2b', note: '' },
      inflation: { state: '', percent: '', documentId: '', note: '' },
    })
  })

  it('документы объекта: договор генподряда, затем ДС по порядку карточки; без приложений; подпись и ссылка', () => {
    const own = OBJECT_DOCS.filter(d => d.object_id === 'o-2')
    assert.deepEqual(objectDocOptions(own).map(objectDocLabel), ['Договор генподряда № ГП-7 от 01.02.2025', 'ДС № 1 от 10.03.2026', 'ДС № 2 от 15.04.2026'])
    assert.equal(objectDocLabel({ document_type: 'general_contract', name: 'ДГП № ГП-7', document_number: 'ГП-7' }), 'ДГП № ГП-7')
    assert.equal(objectDocHref('o-2', 'od-2b'), '/general/objects/o-2?tab=documents&doc=od-2b')
    assert.equal(objectDocHref('o-2'), '/general/objects/o-2?tab=documents')
  })

  it('обе базы: те же поля, ограничения и триггер; права таблицы прежние; документы объекта — только администратор', () => {
    const supa = read('supabase/migrations/20261121_cost_plan_calc_objects.sql')
    const yandex = read('migration/yandex/20261121_cost_plan_calc_objects.sql')
    const body = (sql) => sql.slice(sql.indexOf('ALTER TABLE public.cost_plan_compensation\n'), sql.lastIndexOf('$$;') + 3)
    assert.ok(body(supa).length > 500)
    assert.equal(body(yandex), body(supa))
    assert.doesNotMatch(yandex, /^\s*(BEGIN|COMMIT);|TO authenticated|\banon\b/m)
    for (const sql of [supa, yandex]) {
      assert.match(sql, /ADD COLUMN IF NOT EXISTS vat_document_id uuid REFERENCES public\.object_documents\(id\) ON DELETE SET NULL/)
      assert.match(sql, /vat_compensated IS TRUE OR \(vat_percent IS NULL AND vat_document_id IS NULL\)/)
      assert.match(sql, /d\.id = NEW\.inflation_document_id AND d\.object_id = NEW\.object_id/)
      assert.doesNotMatch(sql, /SECURITY DEFINER|CREATE POLICY|GRANT /)
    }
    for (const col of ['vat_compensated boolean', 'inflation_percent numeric(5,2)', 'inflation_document_id uuid REFERENCES public.object_documents(id) ON DELETE SET NULL']) {
      assert.ok(read('supabase/schemas/cost_plan_compensation.sql').includes(col), col)
    }
    assert.match(read('tests/db/baseline/candidate-migrations.txt'), /^20261121_cost_plan_calc_objects\.sql$/m)
    assert.ok(fs.existsSync(path.join(REPO, 'migration/yandex/20261121_cost_plan_calc_objects.check.sql')))
    assert.ok(fs.existsSync(path.join(REPO, 'migration/backup/checks/20261121.sql')))
    assert.ok(fs.existsSync(path.join(REPO, 'migration/rollback/20261121_cost_plan_calc_objects_rollback.sql')))
    // Документы объекта по расчёту: категории вкладки — те, что сервер файлов отдаёт только администратору.
    const presign = read('server/osp-api/src/routes/s3Presign.js')
    for (const s of COST_PLAN_CALC_SECTIONS) assert.match(presign, new RegExp(`${s.category}: \\[\\['admin', 'edit'\\]\\]`), s.category)
    assert.match(presign, /section_templates: \[\['admin', 'edit'\]\]/)
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

  // Данные стенда дополняются до открытия окна: вкладка читает всё при открытии.
  const openCalc = async ({ query = '', anchors = ANCHORS, rows = [], files = [], missing = [], missingColumns = null } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/cost-plans&latency=0${query}`)
    await page.locator('.cost-plans-page .cp-table').first().waitFor({ timeout: 120000 })
    await page.evaluate(([objects, anchorRows, compRows, fileRows, docs, missingTables, absentColumns]) => {
      const db = window.__fakeDb
      db.objects = [...db.objects.filter(o => !o.id.startsWith('o-')), ...objects]
      db.section_templates = anchorRows
      db.cost_plan_compensation = compRows
      db.object_documents = docs
      db.s3_documents.push(...fileRows)
      for (const t of missingTables) {
        window.__fakeErrors = { ...(window.__fakeErrors || {}), [t]: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` } }
      }
      if (absentColumns) window.__fakeMissingColumns = { cost_plan_compensation: absentColumns }
      for (const t of ['objects', 'section_templates', 'cost_plan_compensation', 'object_documents', 's3_documents']) window.__fakeTouch(t)
    }, [OBJECTS, anchors, rows, files, OBJECT_DOCS, missing, missingColumns])
    await page.getByRole('button', { name: 'Документы' }).click()
    const modal = page.getByRole('dialog', { name: 'Документы раздела' })
    await modal.getByRole('tab', { name: 'Расчёт ПЗ' }).click()
    await modal.locator('.cpc :is(.cpc-cards, .tdm-site-empty-state:not(:has-text("Загрузка")), .tdm-site-alert)').first().waitFor({ timeout: 10000 })
    return { page, modal, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const card = (modal, id) => modal.locator(`.cpc-card[data-object-id="${id}"]`)
  const fakeFiles = (page, where) => page.evaluate((w) => window.__fakeDb.s3_documents
    .filter((d) => d.doc_category === w.category || (w.objects && d.owner_type === 'object' && w.objects.includes(d.doc_category)))
    .map((d) => ({ owner_type: d.owner_type, owner_id: d.owner_id, doc_category: d.doc_category, file_name: d.file_name })), where)
  const compRow = (page, objectId) => page.evaluate((id) => {
    const r = window.__fakeDb.cost_plan_compensation.find((x) => x.object_id === id)
    return r ? {
      vat: [r.vat_compensated ?? null, r.vat_percent ?? null, r.vat_document_id ?? null, r.vat_note ?? null],
      inflation: [r.inflation_compensated ?? null, r.inflation_percent ?? null, r.inflation_document_id ?? null, r.inflation_note ?? null],
    } : null
  }, objectId)
  const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })

  it('администратор: инструкции сверху, по объекту — документы слева, НДС и инфляция справа (по разу), файлы и сведения', async () => {
    const { page, modal, errors, dialogs, close } = await openCalc({
      rows: [{ id: 'cc-1', object_id: 'o-5', vat_compensated: null, vat_percent: null, vat_document_id: null, vat_note: 'Уточнить у заказчика', inflation_compensated: null, inflation_percent: null, inflation_document_id: null, inflation_note: null }],
    })
    try {
      assert.deepEqual(await modal.locator('.tdm-tab').allTextContents(), ['Экономисты ОСП', 'Расчёт ПЗ'])
      // Подвкладок больше нет: инструкции обеих видов рядом, компенсация — только в карточках объектов.
      assert.equal(await modal.locator('.cpc-subtab, .cpc-comp, .cpc-table').count(), 0)
      assert.deepEqual(await modal.locator('.cpc-instr .cpc-cell-title').allTextContents(), ['Прямые затраты', 'КП до перекидок'])
      const labels = await modal.locator('.cpc-card-title').allTextContents()
      assert.deepEqual(labels, ['Бизнес-центр «Нурлы»', 'ЖК «Северный квартал»', 'ЖК Сданный', 'ЖК Северный 33', 'ЖК Южный'])
      assert.equal(await modal.locator('.cpc-cell-title', { hasText: /^Компенсация НДС$/ }).count(), labels.length, 'НДС — по разу на объект')
      assert.equal(await modal.locator('.cpc-cell-title', { hasText: /^Инфляция$/ }).count(), labels.length, 'инфляция — по разу на объект')
      // Схема карточки: слева «Прямые затраты» над «КП до перекидок», справа «Компенсация НДС» над «Инфляцией».
      const box = async (sel) => card(modal, 'o-2').locator(sel).boundingBox()
      const [direct, kp, vat, infl] = await Promise.all(['.cpc-area-direct', '.cpc-area-kp', '.cpc-area-vat', '.cpc-area-inflation'].map(box))
      assert.ok(direct.x < vat.x && kp.x < infl.x, 'документы слева')
      assert.ok(Math.abs(direct.y - vat.y) < 2 && Math.abs(kp.y - infl.y) < 2 && kp.y > direct.y, 'две строки')

      // Инструкция — в свой вид, общий для всех объектов.
      await modal.locator('.cpc-instr[data-section="direct"] input[type=file]').setInputFiles([pdf('Инструкция ПЗ.pdf')])
      await modal.locator('.cpc-instr[data-section="direct"] .cpc-file-name', { hasText: 'Инструкция ПЗ.pdf' }).waitFor({ timeout: 10000 })
      assert.equal(await modal.locator('.cpc-instr[data-section="kp"] .cpc-file').count(), 0)
      // Документ объекта — в ячейку своего вида и только у этого объекта.
      await card(modal, 'o-2').locator('.cpc-area-kp input[type=file]').setInputFiles([pdf('КП Южный.pdf')])
      await card(modal, 'o-2').locator('.cpc-area-kp .cpc-file-name', { hasText: 'КП Южный.pdf' }).waitFor({ timeout: 10000 })
      assert.equal(await card(modal, 'o-2').locator('.cpc-area-direct .cpc-file').count(), 0)
      assert.equal(await card(modal, 'o-1').locator('.cpc-file').count(), 0)
      assert.deepEqual(await fakeFiles(page, { category: COST_PLAN_CALC_CATEGORY, objects: COST_PLAN_CALC_SECTIONS.map(s => s.category) }), [
        { owner_type: 'general', owner_id: 'tpl-direct', doc_category: 'cost_plan_calc', file_name: 'Инструкция ПЗ.pdf' },
        { owner_type: 'object', owner_id: 'o-2', doc_category: 'cost_plan_kp_before_transfers', file_name: 'КП Южный.pdf' },
      ])

      // Компенсация НДС: да, 1,5 %, подтверждающий ДС из документов объекта; инфляция: нет.
      await modal.getByRole('button', { name: 'Изменить компенсацию НДС и инфляцию: ЖК Южный' }).click()
      assert.equal(await modal.getByRole('button', { name: 'Изменить компенсацию НДС и инфляцию: ЖК Сданный' }).isDisabled(), true)
      const vatGroup = modal.getByRole('group', { name: 'Компенсация НДС: ЖК Южный' })
      const inflGroup = modal.getByRole('group', { name: 'Инфляция: ЖК Южный' })
      await vatGroup.getByText('Да', { exact: true }).click()
      const docSelect = modal.getByRole('combobox', { name: 'Подтверждающий ДС: ЖК Южный' })
      await docSelect.locator('option', { hasText: 'ДС № 2' }).waitFor({ state: 'attached', timeout: 5000 })
      assert.deepEqual(await docSelect.locator('option').allTextContents(),
        ['не выбран', 'Договор генподряда № ГП-7 от 01.02.2025', 'ДС № 1 от 10.03.2026', 'ДС № 2 от 15.04.2026'], 'без приложений и чужих ДС')
      await modal.getByRole('textbox', { name: 'Компенсация НДС, процент: ЖК Южный' }).fill('150')
      await docSelect.selectOption('od-2b')
      await inflGroup.getByText('Нет', { exact: true }).click()
      assert.equal(await modal.getByRole('textbox', { name: 'Инфляция, процент: ЖК Южный' }).count(), 0, 'при «нет» процента нет')
      await modal.getByRole('textbox', { name: 'Инфляция, примечание: ЖК Южный' }).fill('Индексации в договоре нет')
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await card(modal, 'o-2').locator('.tdm-site-error', { hasText: 'Процент по НДС — число больше 0 и не больше 100' }).waitFor()
      assert.equal(await compRow(page, 'o-2'), null, 'с ошибкой ничего не записано')
      await modal.getByRole('textbox', { name: 'Компенсация НДС, процент: ЖК Южный' }).fill('1,5')
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await card(modal, 'o-2').locator('.cpc-area-vat .cpc-badge', { hasText: 'Да · 1,5 %' }).waitFor({ timeout: 10000 })
      assert.deepEqual(await compRow(page, 'o-2'), {
        vat: [true, 1.5, 'od-2b', null],
        inflation: [false, null, null, 'Индексации в договоре нет'],
      })
      const link = card(modal, 'o-2').locator('.cpc-area-vat a.cpc-doc-link')
      assert.equal(await link.textContent(), 'ДС № 2 от 15.04.2026')
      assert.equal(await link.getAttribute('href'), '/general/objects/o-2?tab=documents&doc=od-2b')
      assert.equal(await link.getAttribute('target'), '_blank')
      assert.equal(await card(modal, 'o-2').locator('.cpc-area-inflation .cpc-badge').textContent(), 'Нет')
      assert.equal(await card(modal, 'o-2').locator('.cpc-area-inflation .cpc-note').textContent(), 'Индексации в договоре нет')

      // Escape в поле — отмена правки, окно остаётся.
      await modal.getByRole('button', { name: 'Изменить компенсацию НДС и инфляцию: ЖК Северный 33' }).click()
      await modal.getByRole('textbox', { name: 'Компенсация НДС, примечание: ЖК Северный 33' }).fill('не сохранять')
      await page.keyboard.press('Escape')
      await modal.locator('.cpc-item-form').first().waitFor({ state: 'detached', timeout: 5000 })
      assert.equal(await modal.isVisible(), true)
      assert.equal(await compRow(page, 'o-1'), null)

      // «Да» → «Нет»: процент и документ снимаются; ничего не указано — сведения объекта удаляются.
      await modal.getByRole('button', { name: 'Изменить компенсацию НДС и инфляцию: ЖК Южный' }).click()
      await vatGroup.getByText('Нет', { exact: true }).click()
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await card(modal, 'o-2').locator('.cpc-area-vat .cpc-badge', { hasText: /^Нет$/ }).waitFor({ timeout: 10000 })
      assert.deepEqual((await compRow(page, 'o-2')).vat, [false, null, null, null])
      await modal.getByRole('button', { name: 'Изменить компенсацию НДС и инфляцию: ЖК Южный' }).click()
      await vatGroup.getByText('Не указано', { exact: true }).click()
      await inflGroup.getByText('Не указано', { exact: true }).click()
      await modal.getByRole('textbox', { name: 'Инфляция, примечание: ЖК Южный' }).fill('  ')
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await modal.locator('.cpc-item-form').first().waitFor({ state: 'detached', timeout: 5000 })
      assert.equal(await compRow(page, 'o-2'), null)

      // Удалить документ объекта — с вопросом.
      await card(modal, 'o-2').getByRole('button', { name: 'Удалить: КП Южный.pdf' }).click()
      await card(modal, 'o-2').locator('.cpc-area-kp .cpc-files-empty').waitFor({ timeout: 10000 })
      assert.deepEqual(dialogs, ['Удалить файл «КП Южный.pdf»?'])
      assert.deepEqual((await fakeFiles(page, { category: COST_PLAN_CALC_CATEGORY, objects: COST_PLAN_CALC_SECTIONS.map(s => s.category) })).map(f => f.file_name),
        ['Инструкция ПЗ.pdf'], 'осталась инструкция')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('ссылка на подтверждающий ДС открывает «Документы» карточки объекта с подсвеченным ДС', async () => {
    const { page, modal, errors, close } = await openCalc({
      rows: [{ id: 'cc-1', object_id: 'o-2', vat_compensated: true, vat_percent: 2, vat_document_id: 'od-2a', vat_note: null, inflation_compensated: null, inflation_percent: null, inflation_document_id: null, inflation_note: null }],
    })
    try {
      const link = card(modal, 'o-2').locator('.cpc-area-vat a.cpc-doc-link')
      await link.filter({ hasText: 'ДС № 1 от 10.03.2026' }).waitFor({ timeout: 10000 })
      const href = await link.getAttribute('href')
      await page.evaluate((to) => window.__navigate(to), href)
      const row = page.locator('tr.doc-row-linked[data-doc-id="od-2a"]')
      await row.waitFor({ timeout: 20000 })
      assert.match(await page.locator('.tab.active').textContent(), /Документы/)
      assert.equal(await page.locator('tr.doc-row-linked').count(), 1)
      assert.match(await row.textContent(), /ДС № 1/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права администратора: только объекты со сведениями или документами, просмотр и скачивание', async () => {
    const files = [
      file('f-1', 'general', 'tpl-kp', COST_PLAN_CALC_CATEGORY, 'Инструкция КП.pdf'),
      file('f-2', 'object', 'o-5', 'cost_plan_direct_costs', 'ПЗ Сданный.pdf'),
    ]
    const { modal, errors, close } = await openCalc({
      query: '&canEdit=0', files,
      rows: [{ id: 'cc-1', object_id: 'o-2', vat_compensated: true, vat_percent: 2, vat_document_id: 'od-2b', vat_note: null, inflation_compensated: false, inflation_percent: null, inflation_document_id: null, inflation_note: 'нет' }],
    })
    try {
      assert.deepEqual(await modal.locator('.cpc-card-title').allTextContents(), ['ЖК Сданный', 'ЖК Южный'])
      assert.equal(await modal.locator('.cpc-add, .cpc-edit, .cpc-icon.is-danger, input[type=file]').count(), 0, 'ни загрузить, ни удалить, ни изменить')
      assert.equal(await modal.locator('.cpc-instr[data-section="kp"] .cpc-file-name').textContent(), 'Инструкция КП.pdf')
      assert.equal(await card(modal, 'o-5').getByRole('button', { name: 'Скачать: ПЗ Сданный.pdf' }).count(), 1)
      await card(modal, 'o-2').locator('.cpc-doc-link', { hasText: 'ДС № 2 от 15.04.2026' }).waitFor({ timeout: 10000 })
      assert.equal(await card(modal, 'o-2').locator('.cpc-area-vat .cpc-badge').textContent(), 'Да · 2\u00a0%')
      // Просмотр файла — окно поверх, Escape закрывает его, а не «Документы».
      await card(modal, 'o-5').getByRole('button', { name: 'ПЗ Сданный.pdf', exact: true }).click()
      await modal.page().locator('.s3-doc-preview').waitFor({ timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const empty = await openCalc({ query: '&canEdit=0' })
    try {
      await empty.modal.locator('.tdm-site-empty-state', { hasText: 'Документы и сведения по объектам ещё не внесены.' }).waitFor()
      assert.equal(await empty.modal.locator('.cpc-card').count(), 0)
    } finally {
      await empty.close()
    }
  })

  it('миграций ещё нет: подсказки; без колонок 20261121 — только примечания', async () => {
    const none = await openCalc({ anchors: [], missing: ['cost_plan_compensation'] })
    try {
      const notes = await none.modal.locator('.cpc .tdm-note').allTextContents()
      assert.equal(notes.length, 2)
      for (const n of notes) assert.match(n, /после обновления базы \(миграция 20261116_cost_plan_calc\)/)
      assert.equal(await none.modal.locator('.cpc-edit').count(), 0, 'сведения не внести')
      assert.ok(await none.modal.locator('.cpc-card .cpc-add').count() > 0, 'документы объекта загружаются и без миграций')
      await none.modal.getByRole('tab', { name: 'Экономисты ОСП' }).click()
      assert.equal(await none.modal.locator('.tdm-tab.is-active').textContent(), 'Экономисты ОСП')
      assert.deepEqual(none.errors, [])
    } finally {
      await none.close()
    }

    const legacy = await openCalc({
      missingColumns: ['vat_compensated'],
      rows: [{ id: 'cc-1', object_id: 'o-2', vat_note: 'ДС № 4: 2 %', inflation_note: null }],
    })
    try {
      assert.match(await legacy.modal.locator('.cpc .tdm-note').textContent(), /миграция 20261121_cost_plan_calc_objects/)
      assert.equal(await card(legacy.modal, 'o-2').locator('.cpc-area-vat .cpc-note').textContent(), 'ДС № 4: 2 %')
      assert.equal(await legacy.modal.locator('.cpc-badge').count(), 0)
      await legacy.modal.getByRole('button', { name: 'Изменить компенсацию НДС и инфляцию: ЖК Южный' }).click()
      assert.equal(await legacy.modal.locator('.cpc-seg').count(), 0, 'без «да / нет»')
      await legacy.modal.getByRole('textbox', { name: 'Инфляция, примечание: ЖК Южный' }).fill('Есть, 4 % в год')
      await legacy.modal.getByRole('button', { name: 'Сохранить' }).click()
      await card(legacy.modal, 'o-2').locator('.cpc-area-inflation .cpc-note', { hasText: 'Есть, 4 % в год' }).waitFor({ timeout: 10000 })
      assert.deepEqual(await legacy.page.evaluate(() => Object.keys(window.__fakeDb.cost_plan_compensation.find((r) => r.object_id === 'o-2')).filter((k) => /compensated|percent|document_id/.test(k))), [])
      assert.deepEqual(legacy.errors, [])
    } finally {
      await legacy.close()
    }
  })
})
