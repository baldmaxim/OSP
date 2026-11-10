// «Реестр по договорам»: номер договора по схеме объекта КОД-ДП-ГГ-NNN (миграция 20270110). Форма нового договора сама ставит
// следующий номер выбранного объекта, меняет его при смене объекта, пока человек не набрал свой; «Подставить» возвращает его;
// ручной номер не по порядку — подтверждение; подставленный номер, который успел взять коллега, — следующий по свежему
// счётчику; занятый ручной номер — понятный отказ. «Документы» → «Нумерация договоров»: коды, последний и следующий номер,
// код меняет только администратор. Стенд: contracts=24&contractNumbering=1 (у obj-1 код СЕВ, выдано 004; у obj-2 кода нет),
// contractNumbering=legacy — миграции нет. Правила — tests/contracts/contract-numbering.test.mjs, база — contract-numbering-db.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=24&latency=0'
const NUMBERING = `${BASE}&contractNumbering=1`
const YY = String(Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric' }).format(new Date())) % 100).padStart(2, '0')
const NO = (seq, code = 'СЕВ') => `${code}-ДП-${YY}-${String(seq).padStart(3, '0')}`
const NUMBER = '#contract-form-number'

describe('Договоры: номер по схеме объекта', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (query) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource|счётчики номеров/.test(msg.text())) errors.push(msg.text()) })
    // Окна подтверждения: ответ задаёт тест (page.__answer), по умолчанию — «да».
    page.on('dialog', async (d) => { dialogs.push({ type: d.type(), text: d.message() }); await (page.__answer === false ? d.dismiss() : d.accept()) })
    await page.addInitScript(() => { try { localStorage.clear() } catch { /* нет */ } })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const openForm = async (page) => {
    await page.locator('.cr-header-actions button', { hasText: '+ Добавить договор' }).click()
    await page.locator(NUMBER).waitFor()
  }
  const pickObject = async (page, name) => {
    await page.locator('.contract-object-picker .fdrop-trigger').click()
    // Список — в <body> (портал FilterDropdown).
    await page.locator('.fdrop-panel .fdrop-option', { hasText: name }).first().click()
  }
  const pickCounterparty = async (page) => {
    await page.locator('.cp-search-input').click()
    await page.locator('.cp-search-item').first().dispatchEvent('mousedown')
  }
  const submit = (page) => page.locator('.modal form button[type="submit"]').click()
  // Окно alert/confirm приходит событием страницы — ждём его в тесте.
  const until = async (ok, ms = 5000) => {
    for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error('не дождались окна')
    }
  }
  const hint = (page) => page.locator('.cnum-hint').innerText()
  const counter = (page) => page.evaluate((y) => window.__fakeDb.contract_number_counters
    .find((c) => c.code_key === 'СЕВ' && c.year === 2000 + Number(y))?.last_number, YY)
  const savedWith = (page, number) => page.waitForFunction((n) => window.__fakeDb.contracts.some((c) => c.contract_number === n), number)

  it('новый договор: номер появляется по выбранному объекту, меняется вместе с объектом; у объекта без кода — пусто', async () => {
    const { page, errors, close } = await open(NUMBERING)
    try {
      await openForm(page)
      assert.equal(await page.locator(NUMBER).inputValue(), '', 'объект не выбран — номера нет')
      assert.match(await hint(page), /Выберите объект — номер подставится по схеме КОД-ДП-ГГ-NNN/)

      await pickObject(page, 'Северный квартал')
      await page.waitForFunction((n) => document.querySelector('#contract-form-number').value === n, NO(5))
      assert.match(await hint(page), new RegExp(`Следующий номер объекта по счётчику 20${YY} года \\(код СЕВ\\)\\. Можно заменить своим`))
      assert.equal(await page.locator('.cnum-apply').count(), 0, 'номер уже подставлен — кнопки нет')

      await pickObject(page, 'Нурлы')
      await page.waitForFunction(() => document.querySelector('#contract-form-number').value === '')
      assert.match(await hint(page), /У объекта нет кода для номера по схеме/)

      await pickObject(page, 'Северный квартал')
      await page.waitForFunction((n) => document.querySelector('#contract-form-number').value === n, NO(5))

      // Сохранение: номер в базе, счётчик объекта — 5.
      await pickCounterparty(page)
      await submit(page)
      await savedWith(page, NO(5))
      assert.equal(await counter(page), 5)

      // Следующая форма — уже 006.
      await openForm(page)
      await pickObject(page, 'Северный квартал')
      await page.waitForFunction((n) => document.querySelector('#contract-form-number').value === n, NO(6))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('свой номер: смена объекта его не трогает, «Подставить» возвращает номер по схеме; можно оставить пустым', async () => {
    const { page, errors, close } = await open(NUMBERING)
    try {
      await openForm(page)
      await pickObject(page, 'Северный квартал')
      await page.waitForFunction((n) => document.querySelector('#contract-form-number').value === n, NO(5))
      await page.locator(NUMBER).fill('ДП-45/2026')
      assert.match(await hint(page), /Свой номер — не по схеме объекта/)
      const apply = page.locator('.cnum-apply')
      assert.equal((await apply.innerText()).trim(), `Подставить ${NO(5)}`)

      await pickObject(page, 'Нурлы')
      await pickObject(page, 'Северный квартал')
      assert.equal(await page.locator(NUMBER).inputValue(), 'ДП-45/2026', 'набранный номер остался')

      await apply.click()
      assert.equal(await page.locator(NUMBER).inputValue(), NO(5))
      assert.match(await hint(page), /Следующий номер объекта/)

      // Стёр — так и остаётся без номера (договор без номера, как раньше).
      await page.locator(NUMBER).fill('')
      await pickObject(page, 'Нурлы')
      await pickObject(page, 'Северный квартал')
      assert.equal(await page.locator(NUMBER).inputValue(), '')
      assert.match(await hint(page), /Без номера/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('ручной номер не по порядку — подтверждение; «нет» — форма открыта, «да» — сохранено, счётчик продолжится после него', async () => {
    const { page, errors, dialogs, close } = await open(NUMBERING)
    try {
      await openForm(page)
      await pickObject(page, 'Северный квартал')
      await pickCounterparty(page)
      await page.locator(NUMBER).fill(NO(9).toLowerCase())

      page.__answer = false
      await submit(page)
      await until(() => dialogs.length === 1)
      assert.equal(dialogs[0].type, 'confirm')
      assert.match(dialogs[0].text, /следующий по счётчику — 005/)
      assert.match(dialogs[0].text, /005–008 останутся невыданными/)
      assert.equal(await page.locator(NUMBER).count(), 1, 'форма открыта')

      page.__answer = true
      await submit(page)
      await savedWith(page, NO(9).toLowerCase())
      assert.equal(await counter(page), 9)

      // Чужой код в номере — тоже вопрос.
      await openForm(page)
      await pickObject(page, 'Северный квартал')
      await pickCounterparty(page)
      await page.locator(NUMBER).fill(NO(1, 'НУР'))
      await submit(page)
      await savedWith(page, NO(1, 'НУР'))
      assert.match(dialogs.at(-1).text, /не совпадает с кодом объекта «ЖК «Северный квартал»» — СЕВ/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подставленный номер успел взять коллега — договор получает следующий, человеку сказано; занятый ручной номер — отказ', async () => {
    const { page, errors, dialogs, close } = await open(NUMBERING)
    try {
      await openForm(page)
      await pickObject(page, 'Северный квартал')
      await page.waitForFunction((n) => document.querySelector('#contract-form-number').value === n, NO(5))
      await pickCounterparty(page)
      // Коллега сохранил договор с тем же номером, пока форма была открыта.
      await page.evaluate((n) => {
        const fdb = window.__fakeDb
        fdb.contracts.push({ ...fdb.contracts[0], id: 'ctr-colleague', display_id: 777, contract_number: n, record_type: 'dp' })
        window.__fakeAfter.contracts('insert', fdb.contracts.at(-1), null)
        window.__fakeTouch('contracts')
      }, NO(5))
      await submit(page)
      await savedWith(page, NO(6))
      assert.match(dialogs.at(-1).text, new RegExp(`Номер ${NO(5)} успел получить другой договор — этому договору присвоен ${NO(6)}`))
      assert.equal(await page.evaluate((n) => window.__fakeDb.contracts.filter((c) => c.contract_number === n).length, NO(5)), 1)

      // Свой номер, уже занятый (в другой записи) — отказ с номером договора, форма открыта, второй записи нет.
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor()
      await openForm(page)
      await pickObject(page, 'Северный квартал')
      await pickCounterparty(page)
      await page.locator(NUMBER).fill(`сев-дп-${YY}-5`)
      const shown = dialogs.length
      await submit(page)
      await until(() => dialogs.length > shown)
      const refusal = dialogs.at(-1).text
      assert.match(refusal, new RegExp(`Номер сев-дп-${YY}-5 уже есть у договора ID 777`))
      assert.match(refusal, new RegExp(`подставьте следующий: ${NO(7)}`))
      assert.equal(await page.locator(NUMBER).count(), 1, 'форма открыта')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Документы» → «Нумерация договоров»: коды и номера; администратор задаёт код, повтор — отказ', async () => {
    const { page, errors, close } = await open(NUMBERING)
    try {
      await page.locator('.cr-header-actions button', { hasText: 'Документы' }).click()
      await page.locator('.tdm-card', { hasText: 'Нумерация договоров' }).click()
      const modal = page.locator('.cnum-modal')
      await modal.waitFor()
      const row = (name) => modal.locator('.cnum-table tbody tr', { hasText: name })
      await page.waitForFunction((n) => document.querySelector('.cnum-modal')?.innerText.includes(n), NO(5))
      assert.match(await row('Северный квартал').innerText(), new RegExp(`СЕВ\\s+${NO(4)}\\s+${NO(5)}`))
      assert.match(await row('Нурлы').innerText(), /нет кода/)
      assert.match(await modal.locator('.cnum-summary').innerText(), /Код задан у 1 из 2 объектов/)

      // Повтор кода другого объекта (другим регистром) — отказ в строке.
      await row('Нурлы').locator('.cnum-icon-btn').click()
      await row('Нурлы').locator('input').fill('сев')
      await row('Нурлы').locator('button[type="submit"]').click()
      assert.match(await row('Нурлы').locator('.cnum-error').innerText(), /уже у объекта «ЖК «Северный квартал»»/)
      // Пробел — отказ.
      await row('Нурлы').locator('input').fill('НУР 1')
      await row('Нурлы').locator('button[type="submit"]').click()
      assert.match(await row('Нурлы').locator('.cnum-error').innerText(), /без пробелов/)

      await row('Нурлы').locator('input').fill(' НУР ')
      await row('Нурлы').locator('button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.objects.find((o) => o.id === 'obj-2')?.contract_code === 'НУР')
      await modal.locator('.cnum-table tbody tr', { hasText: NO(1, 'НУР') }).waitFor()
      assert.match(await modal.locator('.cnum-summary').innerText(), /Код задан у 2 из 2 объектов/)

      // Escape в поле — отмена правки, окно остаётся; второй Escape — закрыть.
      await row('Нурлы').locator('.cnum-icon-btn').click()
      await row('Нурлы').locator('input').press('Escape')
      assert.equal(await modal.count(), 1)
      assert.equal(await row('Нурлы').locator('input').count(), 0)
      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached' })

      // Новый договор по объекту с новым кодом — НУР-ДП-ГГ-001.
      await openForm(page)
      await pickObject(page, 'Нурлы')
      await page.waitForFunction((n) => document.querySelector('#contract-form-number').value === n, NO(1, 'НУР'))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('не администратор видит коды без карандаша; сотруднику объекта плитки нет', async () => {
    const { page, errors, close } = await open(`${NUMBERING}&asRole=lawyer`)
    try {
      await page.locator('.cr-header-actions button', { hasText: 'Документы' }).click()
      await page.locator('.tdm-card', { hasText: 'Нумерация договоров' }).click()
      await page.locator('.cnum-modal .cnum-table').waitFor()
      assert.equal(await page.locator('.cnum-modal .cnum-icon-btn').count(), 0)
      assert.match(await page.locator('.cnum-modal .cnum-summary').innerText(), /Коды задаёт администратор/)
      assert.deepEqual(errors, [])
    } finally { await close() }
    const staff = await open(`${NUMBERING}&canEdit=0&scope=obj-1`)
    try {
      await staff.page.locator('.cr-header-actions button', { hasText: 'Документы' }).click()
      await staff.page.locator('.tdm-cards').waitFor()
      assert.equal(await staff.page.locator('.tdm-card', { hasText: 'Нумерация договоров' }).count(), 0)
    } finally { await staff.close() }
  })

  it('миграции нет: форма как раньше (прежний «следующий номер»), окно говорит, что нумерация не включена', async () => {
    const { page, errors, close } = await open(`${BASE}&contractNumbering=legacy`)
    try {
      await openForm(page)
      await page.waitForFunction(() => document.querySelector('#contract-form-number').value !== '')
      assert.equal(await page.locator(NUMBER).inputValue(), '25')
      assert.equal(await page.locator('.cnum-hint').count(), 0)
      await pickObject(page, 'Северный квартал')
      assert.equal(await page.locator(NUMBER).inputValue(), '25')
      await page.locator('.modal-close').first().click()

      await page.locator('.cr-header-actions button', { hasText: 'Документы' }).click()
      await page.locator('.tdm-card', { hasText: 'Нумерация договоров' }).click()
      assert.match(await page.locator('.cnum-modal .cnum-note').innerText(), /ещё не включена: в базе нет кодов объектов и счётчика \(миграция 20270110\)/)
      assert.equal(await page.locator('.cnum-modal .cnum-table').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
