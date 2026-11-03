// Завершение тендера основного строительства (решения пользователя 03.11.2026): при выборе «Завершен» шаблон понятийного
// соглашения сам попадает в «Документы» тендера, окно спрашивает о подписанном соглашении и без него и без победителя тендер
// не завершает. Победитель — из участников, из базы контрагентов или добавленный вручную. Остальные направления — как раньше.
// Правила — без браузера, окно — стенд route=/tenders/construction; «Google» подменён page.route, как в letter-dp-download.
// Запрет в базе — tender-concept-agreement-db.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  CONCEPT_SIGNED_CATEGORY, CONCEPT_TEMPLATE_CATEGORY, completionBlockers, completionNeedsConcept, conceptAgreementRequired,
  findConceptCard, innProblem, isConceptCard, signedFileProblem,
} from '../../src/utils/tenderConceptAgreement.js'

const launch = browserLaunchOptions()

const DOC_ID = '1Te5tConceptTemplate_0123456789abcdef'
const TEMPLATE_LINK = `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`
const TEMPLATE_KEY = 'concept_agreement_template_link'
const TEMPLATE_NAME = 'Понятийное_соглашение_шаблон.docx'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('Правила понятийного соглашения', () => {
  it('нужно только основному строительству; пустое направление — старые записи ОС; материалы — нет', () => {
    assert.equal(conceptAgreementRequired({ department: 'construction', tender_type: 'main' }), true)
    assert.equal(conceptAgreementRequired({ department: null, tender_type: 'main' }), true)
    for (const department of ['warranty', 'joint', 'other']) {
      assert.equal(conceptAgreementRequired({ department, tender_type: 'main' }), false, department)
    }
    assert.equal(conceptAgreementRequired({ department: 'construction', tender_type: 'materials' }), false)
    assert.equal(conceptAgreementRequired(null), false)
  })

  it('уже завершённый тендер не спрашиваем: старые завершены без соглашения', () => {
    assert.equal(completionNeedsConcept({ department: 'construction', status: 'Подведение итогов' }), true)
    assert.equal(completionNeedsConcept({ department: 'construction', status: 'Завершен' }), false)
  })

  it('карточка находится по файлам соглашения, даже переименованная, затем по названию', () => {
    const plain = { id: 'a', title: 'Техническое задание', files: [{ doc_category: 'general' }] }
    const byTitle = { id: 'b', title: ' понятийное соглашение ', files: [] }
    const renamed = { id: 'c', title: 'Соглашение с подрядчиком', files: [{ doc_category: CONCEPT_SIGNED_CATEGORY }] }
    const template = { id: 'd', title: 'Шаблон', files: [{ doc_category: CONCEPT_TEMPLATE_CATEGORY }] }
    assert.equal(findConceptCard([plain, byTitle, renamed])?.id, 'c')
    assert.equal(findConceptCard([plain, byTitle])?.id, 'b')
    assert.equal(findConceptCard([plain, template])?.id, 'd')
    assert.equal(findConceptCard([plain]), null)
    assert.equal(findConceptCard(undefined), null)
    assert.equal(isConceptCard(plain), false)
    assert.equal(isConceptCard(byTitle), true)
    assert.equal(isConceptCard(renamed), true)
  })

  it('что мешает завершить', () => {
    assert.deepEqual(completionBlockers({ winnersCount: 1, signedCount: 1 }), [])
    assert.deepEqual(completionBlockers({ winnersCount: 0, signedCount: 1 }), ['выберите победителя'])
    assert.deepEqual(completionBlockers({ winnersCount: 2, signedCount: 0 }), ['загрузите подписанное понятийное соглашение'])
    assert.equal(completionBlockers({ winnersCount: 0, signedCount: 0 }).length, 2)
  })

  it('подписанный файл — документ или скан, не пустой, не больше 50 МБ; ИНН — 10 или 12 цифр', () => {
    assert.equal(signedFileProblem({ name: 'Соглашение.PDF', size: 10 }), null)
    assert.equal(signedFileProblem({ name: 'скан.jpg', size: 10 }), null)
    assert.match(signedFileProblem({ name: 'вирус.exe', size: 10 }), /PDF/)
    assert.match(signedFileProblem({ name: 'без расширения', size: 10 }), /PDF/)
    assert.match(signedFileProblem({ name: 'пустой.pdf', size: 0 }), /пустой/)
    assert.match(signedFileProblem({ name: 'большой.pdf', size: 51 * 1024 * 1024 }), /50/)
    assert.equal(innProblem(''), null)
    assert.equal(innProblem('7700000011'), null)
    assert.equal(innProblem('770000001122'), null)
    assert.ok(innProblem('77000'))
    assert.ok(innProblem('77000000ab'))
  })
})

describe('Окно завершения тендера', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  const OS = 'route=/tenders/construction&tenders=10&items=20&cps=3&latency=0'
  // tender-2 — «Подготовка ВОР», участник cp-1 (стенд, seed.js).
  const TENDER = 'tender-2'

  // google: 'ok' | 'closed' (страница входа вместо файла) | 'blocked' (ответ не читается со страницы).
  async function open(query = OS, { link = TEMPLATE_LINK, google = 'ok' } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    const googleRequests = []
    let confirmAnswer = true
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      if (d.type() === 'confirm' && !confirmAnswer) d.dismiss().catch(() => {})
      else d.accept().catch(() => {})
    })
    await context.route('https://docs.google.com/**', async (route) => {
      googleRequests.push(route.request().url())
      const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Disposition,Content-Length,Content-Type' }
      if (google === 'blocked') return route.abort('failed')
      if (google === 'closed') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/html; charset=utf-8' }, body: '<html>Вход</html>' })
      return route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': DOCX, 'content-disposition': `attachment; filename="____.docx"; filename*=UTF-8''${encodeURIComponent(TEMPLATE_NAME)}` },
        body: 'PK\u0003\u0004 шаблон',
      })
    })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
    await page.evaluate(([key, value]) => {
      window.__fakeDb.tender_docs ||= []
      window.__fakeDb.tender_doc_links ||= []
      // Стенд не собирает встраивания: у участников — контрагент, у карточки — ссылки, как в настоящей выборке.
      for (const tc of window.__fakeDb.tender_counterparties) {
        tc.counterparties ||= { ...window.__fakeDb.counterparties.find((c) => c.id === tc.counterparty_id), counterparty_contacts: [] }
      }
      window.__fakeAfter = {
        ...(window.__fakeAfter || {}),
        tender_doc_links: (op, row) => {
          if (op !== 'insert') return
          const card = window.__fakeDb.tender_docs.find((c) => c.id === row.tender_doc_id)
          if (card) card.tender_doc_links = [...(card.tender_doc_links || []), row]
        },
      }
      if (value != null) window.__fakeDb.app_settings.push({ key, value })
    }, [TEMPLATE_KEY, link])
    return {
      page, errors, dialogs, googleRequests,
      answerConfirm: (v) => { confirmAnswer = v },
      close: () => context.close().catch(() => {}),
    }
  }

  const modal = (page) => page.locator('.modal', { hasText: 'Понятийное соглашение подписано?' })
  const finishBtn = (page) => modal(page).getByRole('button', { name: 'Завершить тендер', exact: true })
  const fake = (page, table) => page.evaluate((t) => window.__fakeDb[t] || [], table)
  const tenderRow = async (page, id) => (await fake(page, 'tenders')).find((t) => t.id === id)

  // Выбор «Завершен» в строке реестра: статус-выпадашка строки с нужным номером тендера.
  async function chooseCompleted(page, id = TENDER) {
    const number = await page.evaluate((tid) => window.__fakeDb.tenders.find((t) => t.id === tid).public_tender_number, id)
    const row = page.locator('table.tenders-registry > tbody > tr', { hasText: String(number) }).first()
    await row.locator('.status-dropdown-trigger').first().click()
    await page.locator('.status-dropdown-menu-portal').getByRole('option', { name: 'Завершен', exact: true }).click()
  }

  const chooseParticipant = (page, name = 'Подрядчик 01') => modal(page).locator('div[style*="cursor: pointer"]', { hasText: name }).click()
  const templateReady = (page) => modal(page).locator('.cas-step[data-state="ready"]').waitFor({ timeout: 20000 })
  // Вкладка «Документы» есть только в карточке (у реестра свои button.tender-tab). Стенд на MemoryRouter: адрес страницы не меняется.
  const cardDocsTab = (page) => page.locator('button.tender-tab', { hasText: 'Документы' })
  const onTenderCard = (page) => cardDocsTab(page).waitFor({ timeout: 10000 })
  const until = async (check, what) => {
    const deadline = Date.now() + 10000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`не дождались: ${what}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const uploadSigned = async (page, name = 'Соглашение подписанное.pdf') => {
    await modal(page).locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 подпись') })
    await modal(page).locator('.cas-signed', { hasText: name }).waitFor({ timeout: 10000 })
  }

  it('шаблон сам в «Документах», без победителя и подписанного тендер не завершить; с ними — завершён', async () => {
    const { page, errors, googleRequests, close } = await open()
    try {
      await chooseCompleted(page)
      await modal(page).waitFor({ timeout: 10000 })
      assert.match(await modal(page).locator('h3').innerText(), /Завершение тендера/)
      await templateReady(page)

      // Шаблон — копия файла в карточке «Понятийное соглашение» этого тендера.
      const cards = await fake(page, 'tender_docs')
      assert.equal(cards.length, 1)
      assert.equal(cards[0].tender_id, TENDER)
      assert.equal(cards[0].title, 'Понятийное соглашение')
      const files = await fake(page, 's3_documents')
      const template = files.filter((f) => f.owner_id === cards[0].id)
      assert.deepEqual(template.map((f) => [f.owner_type, f.doc_category, f.file_name]), [['tender', CONCEPT_TEMPLATE_CATEGORY, TEMPLATE_NAME]])
      assert.deepEqual(googleRequests, [`https://docs.google.com/document/d/${DOC_ID}/export?format=docx`])
      assert.match(await modal(page).locator('.cas-step').innerText(), new RegExp(TEMPLATE_NAME))

      // Ничего не выбрано — нельзя, и окно говорит почему.
      assert.equal(await finishBtn(page).isDisabled(), true)
      const blockers = await modal(page).locator('.cas-blockers').innerText()
      assert.match(blockers, /выберите победителя/)
      assert.match(blockers, /подписанное понятийное соглашение/)
      assert.equal(await modal(page).getByRole('button', { name: /без победителя/ }).count(), 0, 'завершить без победителя нельзя')

      // Победитель есть, соглашения нет — всё ещё нельзя.
      await chooseParticipant(page)
      assert.equal(await finishBtn(page).isDisabled(), true)
      assert.doesNotMatch(await modal(page).locator('.cas-blockers').innerText(), /победителя/)

      await uploadSigned(page)
      assert.equal(await finishBtn(page).isDisabled(), false)
      assert.equal(await modal(page).locator('.cas-blockers').count(), 0)
      const signed = (await fake(page, 's3_documents')).filter((f) => f.doc_category === CONCEPT_SIGNED_CATEGORY)
      assert.equal(signed.length, 1)
      assert.equal(signed[0].owner_id, cards[0].id, 'подписанное — в той же карточке')

      await finishBtn(page).click()
      await modal(page).waitFor({ state: 'detached', timeout: 10000 })
      const done = await tenderRow(page, TENDER)
      assert.equal(done.status, 'Завершен')
      assert.equal(done.winner_counterparty_id, 'cp-1')
      assert.deepEqual((await fake(page, 'tender_winners')).filter((w) => w.tender_id === TENDER).map((w) => w.counterparty_id), ['cp-1'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('отмена: тендер в прежнем статусе, шаблон остался; повторно — без второй карточки и второй копии', async () => {
    const { page, googleRequests, close } = await open()
    try {
      const statusBefore = (await tenderRow(page, TENDER)).status
      await chooseCompleted(page)
      await templateReady(page)
      await modal(page).getByRole('button', { name: 'Отмена', exact: true }).click()
      await modal(page).waitFor({ state: 'detached' })
      assert.equal((await tenderRow(page, TENDER)).status, statusBefore)
      assert.equal((await fake(page, 'tender_docs')).length, 1, 'шаблон остался в «Документах» для подписания')

      await chooseCompleted(page)
      await templateReady(page)
      assert.equal((await fake(page, 'tender_docs')).length, 1, 'вторая карточка не появилась')
      assert.equal((await fake(page, 's3_documents')).filter((f) => f.doc_category === CONCEPT_TEMPLATE_CATEGORY).length, 1)
      assert.equal(googleRequests.length, 1, 'шаблон не скачивался второй раз')
    } finally {
      await close()
    }
  })

  for (const google of ['closed', 'blocked']) {
    it(`файл шаблона не отдаётся (${google}): в «Документах» — ссылка, причина видна, подписанное загружается`, async () => {
      const { page, close } = await open(OS, { google })
      try {
        await chooseCompleted(page)
        await templateReady(page)
        const links = await fake(page, 'tender_doc_links')
        assert.deepEqual(links.map((l) => [l.title, l.url]), [['Шаблон понятийного соглашения', TEMPLATE_LINK]])
        assert.equal((await fake(page, 's3_documents')).filter((f) => f.doc_category === CONCEPT_TEMPLATE_CATEGORY).length, 0)
        const step = modal(page).locator('.cas-step')
        assert.equal(await step.getByRole('link', { name: 'Открыть шаблон' }).getAttribute('href'), TEMPLATE_LINK)
        assert.match(await step.innerText(), /не скопировался/)
        await uploadSigned(page)
      } finally {
        await close()
      }
    })
  }

  it('шаблон не указан или указан сетевым путём: окно говорит об этом, подписанное всё равно загружается', async () => {
    const none = await open(OS, { link: null })
    try {
      await chooseCompleted(none.page)
      await templateReady(none.page)
      assert.match(await modal(none.page).locator('.cas-step').innerText(), /Шаблон не указан/)
      await uploadSigned(none.page)
    } finally {
      await none.close()
    }
    const path = '\\\\192.168.5.55\\SharA_Tender\\Понятийное.docx'
    const net = await open(OS, { link: path })
    try {
      await chooseCompleted(net.page)
      await templateReady(net.page)
      assert.match(await modal(net.page).locator('.cas-path').innerText(), /SharA_Tender/)
      assert.equal(net.googleRequests.length, 0)
    } finally {
      await net.close()
    }
  })

  it('файл не того вида не загружается; удалили подписанное — завершить снова нельзя', async () => {
    const { page, close } = await open()
    try {
      await chooseCompleted(page)
      await templateReady(page)
      await chooseParticipant(page)
      await modal(page).locator('input[type="file"]').setInputFiles({ name: 'вирус.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') })
      await modal(page).locator('.cas-error').waitFor()
      assert.match(await modal(page).locator('.cas-error').innerText(), /вирус\.exe: нужен PDF/)
      assert.equal(await finishBtn(page).isDisabled(), true)

      await uploadSigned(page)
      assert.equal(await finishBtn(page).isDisabled(), false)
      await modal(page).getByRole('button', { name: /Удалить файл Соглашение/ }).click()
      await modal(page).locator('.cas-signed').waitFor({ state: 'detached' })
      assert.equal(await finishBtn(page).isDisabled(), true)
    } finally {
      await close()
    }
  })

  it('коллега удалил файл, пока окно открыто, или база отказала: тендер не завершён, окно на месте, причина показана', async () => {
    const { page, dialogs, close } = await open()
    try {
      await chooseCompleted(page)
      await templateReady(page)
      await chooseParticipant(page)
      await uploadSigned(page)
      const statusBefore = (await tenderRow(page, TENDER)).status

      await page.evaluate((category) => {
        window.__fakeDb.s3_documents = window.__fakeDb.s3_documents.filter((f) => f.doc_category !== category)
        window.__fakeTouch('s3_documents')
      }, CONCEPT_SIGNED_CATEGORY)
      await finishBtn(page).click()
      await until(() => dialogs.some((d) => /Тендер не завершён: загрузите подписанное/.test(d)), 'отказ окна')
      assert.equal((await tenderRow(page, TENDER)).status, statusBefore)

      // Файл снова есть, но отказала база: запрет триггера показывается как есть.
      await uploadSigned(page, 'Второй раз.pdf')
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'tenders' && op === 'update'
          ? { error: { code: 'P0001', message: 'Тендер нельзя завершить без подписанного понятийного соглашения', hint: 'concept_agreement_required' } }
          : {})
      })
      await finishBtn(page).click()
      await until(() => dialogs.some((d) => /Ошибка завершения тендера: Тендер нельзя завершить/.test(d)), 'отказ базы')
      assert.equal(await modal(page).count(), 1, 'окно не закрылось')
      assert.equal((await tenderRow(page, TENDER)).status, statusBefore)
    } finally {
      await close()
    }
  })

  it('победитель не участвовал: из базы контрагентов, в участники не добавляется; виден в журнале по имени', async () => {
    const { page, errors, close } = await open()
    try {
      await chooseCompleted(page)
      await templateReady(page)
      const participantsBefore = (await fake(page, 'tender_counterparties')).filter((t) => t.tender_id === TENDER).length
      const search = modal(page).getByRole('searchbox', { name: 'Найти победителя в базе контрагентов' })
      await search.fill('Подрядчик 02')
      const result = modal(page).locator('.wfb-result', { hasText: 'Подрядчик 02' })
      await result.waitFor({ timeout: 10000 })
      await result.click()
      await modal(page).locator('.wfb-chosen', { hasText: 'Подрядчик 02' }).waitFor()
      assert.equal(await search.inputValue(), '', 'поиск очистился')
      await modal(page).getByRole('textbox', { name: 'Корпус или система: Подрядчик 02' }).fill('Корпус 3')

      // Участника из поиска можно выбрать, он отмечается в списке участников, а не строкой «не участвовал».
      await search.fill('Подрядчик 01')
      await modal(page).locator('.wfb-result', { hasText: 'Подрядчик 01' }).click()
      assert.equal(await modal(page).locator('.wfb-chosen', { hasText: 'Подрядчик 01' }).count(), 0)
      await uploadSigned(page)
      await finishBtn(page).click()
      await modal(page).waitFor({ state: 'detached', timeout: 10000 })

      const winners = (await fake(page, 'tender_winners')).filter((w) => w.tender_id === TENDER)
      assert.deepEqual(winners.map((w) => [w.counterparty_id, w.scope_note]), [['cp-2', 'Корпус 3'], ['cp-1', null]])
      assert.equal((await tenderRow(page, TENDER)).winner_counterparty_id, 'cp-2')
      assert.equal(winners.every((w) => !('name' in w)), true, 'имя не пишется в таблицу')
      assert.equal((await fake(page, 'tender_counterparties')).filter((t) => t.tender_id === TENDER).length, participantsBefore)
      const log = (await fake(page, 'tender_audit_log')).find((l) => l.event_type === 'winner_assigned')
      assert.match(log.description, /Подрядчик 02 \(Корпус 3\)/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('победителя нет в базе: добавляется вручную; название и ИНН проверяются до записи', async () => {
    const { page, dialogs, answerConfirm, close } = await open()
    try {
      await chooseCompleted(page)
      await templateReady(page)
      await modal(page).getByRole('searchbox', { name: 'Найти победителя в базе контрагентов' }).fill('ООО Новый Подрядчик')
      await modal(page).locator('.wfb-hint', { hasText: 'В базе контрагентов не нашлось' }).waitFor({ timeout: 10000 })
      await modal(page).getByRole('button', { name: /добавить вручную/ }).click()
      const form = modal(page).locator('.wfb-form')
      const name = form.getByLabel('Название')
      const inn = form.getByLabel('ИНН')
      const save = form.getByRole('button', { name: 'Добавить в базу и выбрать' })
      assert.equal(await name.inputValue(), 'ООО Новый Подрядчик', 'название подставлено из поиска')

      const cpsBefore = (await fake(page, 'counterparties')).length
      await inn.fill('123')
      await save.click()
      assert.match(await form.locator('.cas-error').innerText(), /10 или 12 цифр/)

      await inn.fill('')
      await name.fill('  подрядчик   01 ')
      await save.click()
      assert.match(await form.locator('.cas-error').innerText(), /уже есть в базе/)
      assert.equal((await fake(page, 'counterparties')).length, cpsBefore, 'дубль не записан')

      // Тот же ИНН — по вопросу, как в реестре контрагентов (на стенде ИНН 123456789012 у всех): отказались — записи нет.
      await name.fill('ООО Новый Подрядчик')
      await inn.fill('123456789012')
      answerConfirm(false)
      await save.click()
      await until(() => dialogs.some((d) => /ИНН 123456789012 уже указан/.test(d)), 'вопрос про ИНН')
      assert.equal((await fake(page, 'counterparties')).length, cpsBefore, 'отказались — запись не добавлена')

      await inn.fill('7700000099')
      answerConfirm(true)
      await save.click()
      await modal(page).locator('.wfb-chosen', { hasText: 'ООО Новый Подрядчик' }).waitFor({ timeout: 10000 })
      const created = (await fake(page, 'counterparties')).find((c) => c.name === 'ООО Новый Подрядчик')
      assert.equal(created.inn, '7700000099')
      assert.equal(created.status, 'active')
      const audit = (await fake(page, 'counterparty_audit_log')).find((l) => l.counterparty_id === created.id)
      assert.match(audit.description, /при завершении тендера/)

      await uploadSigned(page)
      await finishBtn(page).click()
      await modal(page).waitFor({ state: 'detached', timeout: 10000 })
      assert.equal((await tenderRow(page, TENDER)).winner_counterparty_id, created.id)
      assert.deepEqual(dialogs.filter((d) => /Ошибка/.test(d)), [])
    } finally {
      await close()
    }
  })

  it('в форме тендера «Завершен» открывает то же окно, а статус не пишется; остальная правка сохраняется', async () => {
    const { page, close } = await open()
    try {
      const statusBefore = (await tenderRow(page, TENDER)).status
      await page.evaluate((id) => window.__navigate(`/tenders/construction?edit=${id}`), TENDER)
      const form = page.locator('.modal form')
      await form.waitFor({ timeout: 10000 })
      await form.locator('select[name="status"]').selectOption('Завершен')
      await form.locator('textarea[name="work_description"]').fill('Новое описание работ')
      await form.locator('button[type="submit"]').click()
      await modal(page).waitFor({ timeout: 10000 })
      await templateReady(page)
      const row = await tenderRow(page, TENDER)
      assert.equal(row.status, statusBefore, 'статус ждёт окна')
      assert.equal(row.work_description, 'Новое описание работ')
      assert.equal((await fake(page, 'tender_audit_log')).filter((l) => l.event_type === 'status_changed').length, 0)
      assert.equal(await cardDocsTab(page).count(), 0, 'пока окно открыто, в карточку не уходим')

      // Форма была открыта из карточки: закрыли окно — возвращаемся в карточку.
      await modal(page).getByRole('button', { name: 'Отмена', exact: true }).click()
      await onTenderCard(page)
      assert.equal((await tenderRow(page, TENDER)).status, statusBefore)
    } finally {
      await close()
    }
  })

  it('уже завершённый тендер правится в форме без окна: старые завершены без соглашения', async () => {
    const { page, close } = await open()
    try {
      const done = (await fake(page, 'tenders')).find((t) => t.status === 'Завершен' && t.tender_type === 'main')
      await page.evaluate((id) => window.__navigate(`/tenders/construction?edit=${id}`), done.id)
      const form = page.locator('.modal form')
      await form.waitFor({ timeout: 10000 })
      await form.locator('textarea[name="work_description"]').fill('Правка завершённого')
      await form.locator('button[type="submit"]').click()
      await onTenderCard(page)
      const row = await tenderRow(page, done.id)
      assert.equal(row.status, 'Завершен')
      assert.equal(row.work_description, 'Правка завершённого')
      assert.equal((await fake(page, 'tender_docs')).length, 0, 'карточка не появилась')
    } finally {
      await close()
    }
  })

  it('«Прочее»: окно как раньше, без соглашения и шаблона, завершить можно без победителя', async () => {
    const query = 'route=/tenders/other&tendersDept=other&tenders=10&items=20&cps=3&latency=0'
    const { page, googleRequests, close } = await open(query)
    try {
      const target = (await fake(page, 'tenders')).find((t) => t.department === 'other' && t.status === 'Подведение итогов')
      await chooseCompleted(page, target.id)
      const old = page.locator('.modal', { hasText: 'Выбор победителей тендера' })
      await old.waitFor({ timeout: 10000 })
      assert.equal(await old.locator('.cas-step').count(), 0)
      assert.equal(await old.locator('.wfb').count(), 0)
      const finish = old.getByRole('button', { name: 'Завершить без победителя' })
      assert.equal(await finish.isDisabled(), false)
      await finish.click()
      await old.waitFor({ state: 'detached', timeout: 10000 })
      assert.equal((await tenderRow(page, target.id)).status, 'Завершен')
      assert.equal((await fake(page, 'tender_docs')).length, 0)
      assert.equal(googleRequests.length, 0)
    } finally {
      await close()
    }
  })

  it('вкладка «Документы»: отметки шаблона и подписанного; файл в карточке соглашения считается подписанным, в другой — нет', async () => {
    const { page, errors, close } = await open()
    try {
      await page.evaluate(() => {
        window.__fakeDb.tender_docs.push({ id: 'card-1', tender_id: 'tender-1', title: 'Понятийное соглашение', is_final: false, created_at: '2026-11-03T08:00:00Z' })
        window.__fakeDb.s3_documents.push({ id: 's3-1', owner_type: 'tender', owner_id: 'card-1', s3_key: 'tenders/card-1/a.docx', file_name: 'Шаблон.docx', size_bytes: 10, doc_category: 'concept_agreement_template', created_at: '2026-11-03T08:00:00Z' })
        window.__navigate('/tenders/tender-1')
      })
      await onTenderCard(page)
      await cardDocsTab(page).click()
      const row = page.locator('.tender-docs-tab tbody tr', { hasText: 'Понятийное соглашение' })
      await row.waitFor({ timeout: 10000 })
      assert.match(await row.locator('.gd-material-file', { hasText: 'Шаблон.docx' }).innerText(), /шаблон/)

      await row.getByRole('button', { name: 'Редактировать документ' }).click()
      const dialog = page.locator('.gd-modal')
      await dialog.locator('input[type="file"]').setInputFiles({ name: 'Подписано.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') })
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10000 })
      assert.match(await row.locator('.gd-material-file', { hasText: 'Подписано.pdf' }).innerText(), /подписанное/)
      const signed = (await fake(page, 's3_documents')).find((f) => f.file_name === 'Подписано.pdf')
      assert.equal(signed.doc_category, CONCEPT_SIGNED_CATEGORY)

      // Другая карточка — обычный файл.
      await page.getByRole('button', { name: '+ Добавить документ' }).first().click()
      await dialog.locator('#tdoc-title').fill('Техническое задание')
      await dialog.locator('input[type="file"]').setInputFiles({ name: 'ТЗ.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') })
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10000 })
      const other = (await fake(page, 's3_documents')).find((f) => f.file_name === 'ТЗ.pdf')
      assert.equal(other.doc_category, undefined)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
