// «Заключение ДП» (решение пользователя 19.11.2026: «/dp-requests убрать; созданные заявки — в /doc-check-requests светло-фиолетовым,
// с пометкой «Заключение ДП»; существующие перенести в новые заявки»). Правила без браузера и страницы в Chromium (стенд
// tests/tender/ui: доска ?docCheck=1&dcDpc=1, кнопка реестра и большое окно — dp-stand.jsx):
//   • раздела «Заявка на заключение ДП» нет: ни блока в «Договорах и ДС», ни галочек в «Правах доступа»; прежний адрес ведёт на доску;
//   • заявка на заключение ДП — третий тип документа доски (doc_type 'dp_conclusion'), карточка и строка реестра — светло-фиолетовые,
//     тип — в заголовке; фильтр «Тип» его знает;
//   • «+ Заявка на заключение ДП» в «Реестре по договорам» — форма доски с заданным типом: понятийное соглашение обязательно,
//     контрагент и примечание — нет; заявка встаёт в «Новые заявки», файлы — по частям доски;
//   • большое окно о новой заявке — получателю, «Открыть заявку» ведёт к карточке на доске; получателей ведёт администратор на доске.
// Перенос прежних заявок и уведомления в базе — doc-check-dp-conclusion-db.test.mjs. Люди и объекты вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { DOC_TYPES, DP_CONCLUSION, cardTitle, isDpConclusion } from '../../src/utils/docCheckHelpers.js'
import { docCheckNotifications } from '../../src/utils/siteNotifications.js'
import { CONTRACT_SECTIONS } from '../../src/utils/contractsHub.js'
import { RETIRED_SECTIONS, SECTIONS } from '../../src/contexts/roleConstants.js'
import { newRequestsLabel } from '../../src/utils/dpRequests.js'
import { computeDocCheckStats, filterDocCheckRequests } from '../../src/utils/docCheckStats.js'

const launch = browserLaunchOptions()
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')
const PDF = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })

describe('Заключение ДП: правила без браузера', () => {
  it('третий тип документа доски: «Заключение ДП», в заголовке карточки — он', () => {
    assert.deepEqual(DOC_TYPES.map((t) => t.value), ['dp', 'ds', DP_CONCLUSION])
    assert.equal(DOC_TYPES.find((t) => t.value === DP_CONCLUSION).option, 'Заключение ДП')
    const r = { doc_type: DP_CONCLUSION, counterparties: { name: 'ООО «Монолит»' } }
    assert.equal(isDpConclusion(r), true)
    assert.equal(isDpConclusion({ doc_type: 'dp' }), false)
    assert.equal(cardTitle(r), 'ООО «Монолит» / Заключение ДП')
    assert.equal(cardTitle({ doc_type: DP_CONCLUSION }), 'Заключение ДП')
  })

  it('уведомление рукстрою о заявке своего объекта: тип словами', () => {
    const [n] = docCheckNotifications([{ id: 'x', doc_type: DP_CONCLUSION, status: 'new', objects: { name: 'ЖК' }, updated_at: '2026-11-19T09:00:00Z' }],
      { since: 0 })
    assert.equal(n.subtitle, 'Заключение ДП')
    assert.equal(n.to, '/doc-check-requests?request=x')
  })

  it('отчёт доски: «Заключение ДП» — отдельным счётом и отбором, в столбцах «ДП / ДС» — вместе с ДП', () => {
    const rows = [
      { id: 'a', doc_type: 'dp', status: 'new', created_at: '2026-11-01T09:00:00Z' },
      { id: 'b', doc_type: 'ds', status: 'new', created_at: '2026-11-01T09:00:00Z' },
      { id: 'c', doc_type: DP_CONCLUSION, status: 'new', created_at: '2026-11-01T09:00:00Z' },
    ]
    const s = computeDocCheckStats(rows, new Map(), new Map())
    assert.deepEqual(s.byType, { dp: 1, ds: 1, dp_conclusion: 1 })
    assert.deepEqual(filterDocCheckRequests(rows, { docType: DP_CONCLUSION }).map((r) => r.id), ['c'])
  })

  it('раздела /dp-requests нет: блока в «Договорах и ДС» нет, прежний адрес ведёт на доску с тем же параметром', () => {
    assert.ok(!CONTRACT_SECTIONS.some((s) => s.section === 'dp_requests' || s.to === '/dp-requests'))
    const app = read('src/App.jsx')
    assert.match(app, /<Route path="\/dp-requests" element={<DpRequestsRedirect \/>} \/>/)
    assert.match(app, /Navigate to={`\/doc-check-requests\${search}\${hash}`} replace/)
    assert.doesNotMatch(app, /pages\/DpRequestsPage/)
    assert.equal(fs.existsSync(path.join(REPO, 'src/pages/DpRequestsPage.jsx')), false)
  })

  it('права «Заявка на заключение ДП» в «Правах доступа» не показываются, ключи остаются (их знают шлюз и база)', () => {
    for (const key of ['dp_requests', 'dp_requests_create']) {
      assert.ok(key in SECTIONS)
      assert.ok(RETIRED_SECTIONS.has(key))
    }
    assert.match(read('src/components/admin/AccessRightsTab.jsx'), /filter\(\(s\) => !RETIRED_SECTIONS\.has\(s\)\)/)
  })

  it('склонение количества заявок в окне', () => {
    assert.equal(newRequestsLabel(1), '1 новая заявка')
    assert.equal(newRequestsLabel(3), '3 новые заявки')
    assert.equal(newRequestsLabel(5), '5 новых заявок')
  })
})

describe('Заключение ДП: страницы', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // Рукстрой с одним объектом: право только создавать заявки доски.
  const AS_BOSS = '&asRole=construction_manager&asUser=boss-1&asName=Строев%20Борис%20Иванович&scope=obj-1'
  const CREATOR = `&noEdit=doc_check_requests,admin${AS_BOSS}`
  const open = async (route, extra = '', { ready, state = 'visible', viewport = { width: 1600, height: 950 } } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const dialogs = []
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=${route}&docCheck=1&dcDpc=1&latency=0${extra}`)
    await page.locator(ready).first().waitFor({ state, timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const form = (page) => page.locator('.dc-form-modal')
  const fresh = (page) => page.evaluate(() => window.__fakeDb.doc_check_requests.filter((r) => !/^dcr-(\d+|dpc-\d+)$/.test(r.id)))

  it('доска: «Заключение ДП» — светло-фиолетовая карточка с типом в заголовке, обычная — нет; фильтр «Тип» и реестр', async () => {
    const { page, errors, close } = await open('/doc-check-requests', '', { ready: '.dc-board' })
    try {
      const dpc = page.locator('.dc-card[data-id="dcr-dpc-2"]')
      await dpc.waitFor()
      assert.match(await dpc.getAttribute('class'), /\bis-dp-conclusion\b/)
      assert.match(await dpc.locator('.dc-card-name').innerText(), /Заключение ДП/)
      const bg = (sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor)
      const [plainBg, dpcBg] = [await bg('.dc-card[data-id="dcr-1"]'), await bg('.dc-card[data-id="dcr-dpc-2"]')]
      assert.notEqual(dpcBg, plainBg, 'фон карточки отличается от обычной')
      const [r, g, b] = dpcBg.match(/\d+(\.\d+)?/g).map(Number)
      assert.ok(b > g && r > g, `фиолетовый оттенок: ${dpcBg}`)
      assert.doesNotMatch(await page.locator('.dc-card[data-id="dcr-1"]').getAttribute('class'), /is-dp-conclusion/)
      // Перенесённые — в «Новых заявках».
      const column = page.locator('.dc-column', { has: page.locator('.dc-column-title', { hasText: 'Новые заявки' }) })
      await column.locator('.dc-card[data-id="dcr-dpc-1"]').waitFor()

      await page.getByRole('tab', { name: 'Реестр' }).click()
      const row = page.locator('tr.dc-row', { hasText: 'Бизнес-центр «Нурлы»' }).filter({ hasText: 'Заключение ДП' })
      await row.waitFor()
      assert.match(await row.getAttribute('class'), /\bis-dp-conclusion\b/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма доски: три типа; подающий выбрал «Заключение ДП» — без понятийного соглашения не создать, контрагент не нужен', async () => {
    const { page, errors, dialogs, close } = await open('/doc-check-requests', CREATOR, { ready: '.dc-board' })
    try {
      await page.getByRole('button', { name: '+ Новая заявка' }).click()
      const types = form(page).locator('.dc-type-opt')
      assert.deepEqual(await types.allInnerTexts(), ['ДП — Договор подряда', 'ДС — Дополнительное соглашение', 'Заключение ДП'])
      await types.filter({ hasText: 'Заключение ДП' }).click()
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await form(page).getByRole('alert').getByText(/Приложите понятийное соглашение/).waitFor()
      assert.equal((await fresh(page)).length, 0)
      await page.locator('[data-testid="dc-concept-files"] input[type=file]').setInputFiles(PDF('Понятийное соглашение.pdf'))
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await form(page).waitFor({ state: 'detached' })
      const [row] = await fresh(page)
      assert.equal(row.doc_type, DP_CONCLUSION)
      assert.equal(row.status, 'new')
      assert.equal(row.object_id, 'obj-1')
      assert.equal(row.counterparty_id, null)
      await page.locator(`.dc-card.is-dp-conclusion[data-id="${row.id}"]`).waitFor()
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«+ Заявка на заключение ДП» реестра: тип задан, понятийное соглашение обязательно; заявка — в «Новых», файлы по частям, ссылка на доску', async () => {
    const { page, errors, dialogs, close } = await open('/stand/dp-create', `${CREATOR}&dpRecipient=0`, { ready: '.cr-dp-add' })
    try {
      await page.locator('.cr-dp-add').click()
      await form(page).waitFor()
      assert.match(await form(page).locator('h3').innerText(), /^Заявка на заключение ДП$/)
      assert.equal(await form(page).locator('.dc-type-opt').count(), 0, 'тип не выбирают')
      const object = form(page).getByLabel('Объект')
      assert.equal(await object.isDisabled(), true, 'свой единственный объект стоит сам')
      assert.match(await form(page).locator('#dc-concept-files-label').innerText(), /Понятийное соглашение\s*\*/)

      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await form(page).getByRole('alert').getByText(/Приложите понятийное соглашение/).waitFor()
      assert.equal((await fresh(page)).length, 0, 'без соглашения заявки нет')

      await form(page).getByLabel('Примечание').fill('Новый подрядчик по кровле')
      await page.locator('[data-testid="dc-concept-files"] input[type=file]').setInputFiles(PDF('Понятийка.pdf'))
      await page.locator('[data-testid="dc-files"] input[type=file]').setInputFiles(PDF('Проект договора.pdf'))
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await form(page).waitFor({ state: 'detached' })

      const [row] = await fresh(page)
      assert.equal(row.doc_type, DP_CONCLUSION)
      assert.equal(row.status, 'new')
      assert.equal(row.object_id, 'obj-1')
      assert.equal(row.notes, 'Новый подрядчик по кровле')
      const files = await page.evaluate((id) => window.__fakeDb.s3_documents.filter((d) => d.owner_id === id)
        .map((d) => [d.owner_type, d.file_name, d.doc_category ?? null]).sort((a, b) => a[1].localeCompare(b[1])), row.id)
      assert.deepEqual(files, [
        ['doc_check_request', 'Понятийка.pdf', 'doc_check_concept_agreement'],
        ['doc_check_request', 'Проект договора.pdf', null],
      ])
      const note = page.locator('.cr-dp-created')
      assert.match(await note.innerText(), /Заявка на заключение ДП подана: «Заявки на проверку ДП\/ДС», колонка «Новые заявки»/)
      assert.equal(await note.getByRole('link', { name: 'Открыть заявку' }).getAttribute('href'), `/doc-check-requests?request=${row.id}`)
      assert.equal(await page.locator('.dpa-dialog').count(), 0, 'не получатель — окна нет')
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('кнопка реестра — только у права создания заявок доски', async () => {
    const { page, close } = await open('/stand/dp-create', `&noEdit=doc_check_requests,doc_check_requests_create,admin${AS_BOSS}`,
      { ready: '[data-testid="registry-button"]', state: 'attached' })
    try {
      await page.locator('.dpa-dialog, [data-testid="registry-button"]').first().waitFor({ state: 'attached' })
      assert.equal(await page.locator('.cr-dp-add').count(), 0)
    } finally { await close() }
  })

  it('сбой загрузки соглашения: заявка остаётся, сказано, где добавить файл', async () => {
    const { page, dialogs, close } = await open('/stand/dp-create', `${CREATOR}&dpRecipient=0&dpFailUpload=1`, { ready: '.cr-dp-add' })
    try {
      await page.locator('.cr-dp-add').click()
      await page.locator('[data-testid="dc-concept-files"] input[type=file]').setInputFiles(PDF('Понятийка.pdf'))
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await page.locator('.cr-dp-created').waitFor()
      assert.equal((await fresh(page)).length, 1)
      assert.equal(dialogs.length, 1)
      assert.match(dialogs[0], /Понятийка\.pdf: Хранилище не ответило[\s\S]*Понятийное соглашение добавьте в окне заявки/)
    } finally { await close() }
  })

  it('большое окно: новая заявка получателя — окно сразу; «Открыть заявку» ведёт к карточке на доске и гасит уведомление', async () => {
    const { page, errors, close } = await open('/stand/dp-create', CREATOR, { ready: '.cr-dp-add' })
    try {
      await page.locator('.cr-dp-add').click()
      await page.locator('[data-testid="dc-concept-files"] input[type=file]').setInputFiles(PDF('Понятийка.pdf'))
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      const alert = page.locator('.dpa-dialog')
      await alert.waitFor()
      const [row] = await fresh(page)
      const text = await alert.innerText()
      assert.match(text, /Новая заявка на заключение ДП/)
      assert.match(text, new RegExp(`ID ${row.request_number}`))
      assert.match(text, /ЖК|Объект/)
      assert.doesNotMatch(text, /Сумма|0,00|Ответственный/, 'полей прежнего раздела нет')
      await alert.getByRole('button', { name: 'Открыть заявку' }).click()
      await page.locator('.dc-detail-modal').waitFor()
      assert.match(await page.locator('.dc-detail-modal').innerText(), /Заключение ДП/)
      await page.waitForFunction(() => window.__dpAcks.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__dpAcks), [[row.id]])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('большое окно на любой странице: только кнопкой; перенесённая заявка — с её ID и примечанием', async () => {
    const { page, errors, close } = await open('/stand/dp-alert', '&dpAlerts=1', { ready: '.dpa-dialog' })
    try {
      const alert = page.locator('.dpa-dialog')
      const text = await alert.innerText()
      assert.match(text, /ID \d+/)
      assert.match(text, /Перенесена из «Заявки на заключение ДП» № 2/)
      await page.keyboard.press('Escape')
      await page.mouse.click(5, 5)
      assert.equal(await alert.isVisible(), true, 'Escape и щелчок мимо не закрывают')
      await alert.getByRole('button', { name: 'Понятно' }).click()
      await alert.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__dpAcks.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__dpAcks), [['dcr-dpc-1']])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('получатели окна — у администратора на доске: добавить и убрать; у остальных кнопки нет', async () => {
    const { page, errors, close } = await open('/doc-check-requests', '', { ready: '.dc-board' })
    try {
      await page.getByRole('button', { name: 'Окно «Заключение ДП»' }).click()
      const d = page.locator('.dpr-dialog')
      await d.getByRole('list', { name: 'Получатели' }).getByText('Стендов Стенд Стендович').waitFor()
      assert.equal(await d.evaluate((el) => getComputedStyle(el.parentElement).position), 'fixed', 'окно на своих стилях')
      await d.getByPlaceholder('ФИО или почта').fill('юристова')
      await d.getByRole('button', { name: 'Добавить' }).click()
      await d.getByRole('list', { name: 'Получатели' }).getByText('Юристова Мария Андреевна').waitFor()
      assert.deepEqual(await page.evaluate(() => window.__fakeDb.dp_request_alert_recipients.map((r) => r.user_id).sort()), ['user-1', 'user-3'])
      await d.getByRole('button', { name: 'Убрать: Юристова Мария Андреевна' }).click()
      await d.getByRole('list', { name: 'Получатели' }).getByText('Юристова Мария Андреевна').waitFor({ state: 'detached' })
      await d.getByRole('button', { name: 'Готово' }).click()
      await d.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
    const other = await open('/doc-check-requests', CREATOR, { ready: '.dc-board' })
    try {
      assert.equal(await other.page.getByRole('button', { name: 'Окно «Заключение ДП»' }).count(), 0)
    } finally { await other.close() }
  })

  it('телефон: форма реестра помещается без прокрутки вбок', async () => {
    const { page, close } = await open('/stand/dp-create', `${CREATOR}&dpRecipient=0`, { ready: '.cr-dp-add', viewport: { width: 390, height: 780 } })
    try {
      await page.locator('.cr-dp-add').click()
      const box = await form(page).boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 390, `форма в ширину экрана: ${JSON.stringify(box)}`)
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(scroll <= 390, `без прокрутки вбок: ${scroll}`)
    } finally { await close() }
  })
})
