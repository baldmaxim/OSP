// Контакт площадки (object_site_contacts, миграция 20261030): вкладка «Контакт площадки» в «Документах
// раздела» реестра «Тендеры — Основное строительство» — по объекту список подразделений ВОР (с «Отделкой»),
// контакт назначает администратор. Подразделение без контакта временно закрывает руководитель строительства
// объекта («Общая информация → Объекты», object_staff) — с пометкой «временно»; нет и его — красным.
// Письмо подрядчикам формируется всегда: строка о выезде на объект (ФИО и телефон, без Telegram) — сразу
// после «…по какому тендеру и объекту обращаетесь.», без своего контакта — предупреждение в окне письма.
// Почта в письме — общий ящик tender.osp@su10.ru; перед ссылкой на документацию — пояснение к листам.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  SITE_CONTACT_LINE, SITE_CONTACT_MISSING, TENDER_MAILBOX, ATTACHMENT_NOTE, ATTACHMENT_BLOCK,
  formatSiteContact, pickSiteContact, telegramHref, telegramLabel, phoneHref, validateSiteContact,
  upgradeLetterTemplate, fillSiteContact,
} from '../../src/utils/siteContacts.js'

const ANCHOR = 'в теле письма указать по какому тендеру и объекту обращаетесь.'
const LINE = 'Если потребуется выезд на объект, предоставляем контактные данные для связи: '

describe('Контакт площадки: правила без базы', () => {
  it('в письме — ФИО и телефон, Telegram не идёт', () => {
    assert.equal(formatSiteContact({ full_name: ' Иванов Иван ', phone: '+7 701 000-00-00', telegram: 'site_nurly' }),
      'Иванов Иван, тел. +7 701 000-00-00')
    assert.equal(formatSiteContact({ full_name: 'Иванов Иван', phone: null }), 'Иванов Иван')
    assert.equal(formatSiteContact(null), '')
  })

  it('кого ставить: свой контакт → руководитель строительства → пометка', () => {
    const own = { full_name: 'Иванов', phone: '1', telegram: '@x' }
    const managers = [{ full_name: 'Сидоров', phone: '2' }, { full_name: 'Петров', phone: null }, { full_name: ' ', phone: '3' }]
    assert.deepEqual(pickSiteContact(own, managers), { source: 'division', people: [own], text: 'Иванов, тел. 1' })
    const temp = pickSiteContact(null, managers)
    assert.equal(temp.source, 'manager')
    assert.equal(temp.text, 'Сидоров, тел. 2; Петров')
    assert.deepEqual(pickSiteContact(null, []), { source: 'none', people: [], text: SITE_CONTACT_MISSING })
  })

  it('Telegram во вкладке: имя и ссылка t.me — профиль, номер — как ввели', () => {
    assert.equal(telegramHref('@site_nurly'), 'https://t.me/site_nurly')
    assert.equal(telegramHref('https://t.me/site_nurly'), 'https://t.me/site_nurly')
    assert.equal(telegramLabel('t.me/site_nurly'), '@site_nurly')
    assert.equal(telegramHref('+7 701 000-00-00'), null)
    assert.equal(telegramLabel('+7 701 000-00-00'), '+7 701 000-00-00')
    assert.equal(phoneHref('+7 (701) 000-00-00; +7 727 300-00-00'), 'tel:+77010000000')
    assert.equal(phoneHref('доб. 12'), null)
  })

  it('форма: ФИО и телефон обязательны, Telegram — нет', () => {
    assert.equal(validateSiteContact({ full_name: ' ', phone: '1' }).error, 'Укажите ФИО')
    assert.equal(validateSiteContact({ full_name: 'Иванов', phone: '' }).error, 'Укажите номер телефона')
    assert.deepEqual(validateSiteContact({ full_name: ' Иванов ', phone: ' 123 ', telegram: ' ' }),
      { value: { full_name: 'Иванов', phone: '123', telegram: null }, error: null })
    assert.match(validateSiteContact({ full_name: 'И'.repeat(201), phone: '1' }).error, /до 200/)
  })

  it('сохранённый раньше шаблон дополняется: строка о выезде, общий ящик, пояснение к документации', () => {
    const old = `Тема: своя\n\nПишите на {employee_email} — ${ANCHOR}\n\nМы рассчитываем на сотрудничество.\n\n`
      + 'Приложение: ссылка на тендерную документацию:\n{tender_package_link}\n\nПочта: {employee_email}'
    const up = upgradeLetterTemplate(old)
    assert.equal(up, `Тема: своя\n\nПишите на ${TENDER_MAILBOX} — ${ANCHOR}\n${SITE_CONTACT_LINE}\n\n`
      + `Мы рассчитываем на сотрудничество.\n\n${ATTACHMENT_BLOCK}\n{tender_package_link}\n\nПочта: ${TENDER_MAILBOX}`)
    assert.equal(upgradeLetterTemplate(up), up, 'второй раз не меняет')
    // Строки «Приложение: …» нет — пояснение встаёт перед ссылкой.
    assert.equal(upgradeLetterTemplate(`${SITE_CONTACT_LINE}\nДокументы:\n{tender_package_link}`),
      `${SITE_CONTACT_LINE}\nДокументы:\n${ATTACHMENT_NOTE}\n{tender_package_link}`)
    assert.equal(upgradeLetterTemplate(null), '')
  })

  it('подстановка: контакт — в строку; без строки о выезде (не ОС) — и пустого абзаца нет', () => {
    const text = `А.\n${SITE_CONTACT_LINE}\n\nБ.`
    assert.equal(fillSiteContact(text, 'Иванов, тел. 1'), `А.\n${LINE}Иванов, тел. 1\n\nБ.`)
    assert.equal(fillSiteContact(text, null), 'А.\n\nБ.')
    assert.equal(fillSiteContact(`А.\n\n${SITE_CONTACT_LINE}\n\nБ.`, null), 'А.\n\nБ.')
  })
})

const launch = browserLaunchOptions()

// Руководители строительства: у «Нурлы» (obj-2) — один, у «Северного квартала» (obj-1) — нет.
const MANAGERS = [
  { id: 'os-1', object_id: 'obj-2', staff_role: 'construction_manager', sort_order: 0, contacts: { full_name: 'Сидоров Сергей Петрович', phone: '+7 702 111-22-33' } },
  { id: 'os-2', object_id: 'obj-2', staff_role: 'economist', sort_order: 0, contacts: { full_name: 'Экономистова Анна', phone: '+7 700 000-00-01' } },
]

describe('Контакт площадки в реестре «Основное строительство»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // dialogs — тексты alert / confirm (confirm принимается). Данные — до первого запроса к этим таблицам.
  const openPage = async (query, { contacts = [], managers = MANAGERS, missingTable = false } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
    await page.evaluate(([c, m, missing]) => {
      window.__fakeDb.object_site_contacts = c
      window.__fakeDb.object_staff = m
      if (missing) {
        window.__fakeErrors = { object_site_contacts: { code: 'PGRST205', message: "Could not find the table 'public.object_site_contacts' in the schema cache" } }
      }
    }, [contacts, managers, missingTable])
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr').filter({ has: page.locator('.tp-num-value', { hasText: new RegExp(`^${num}$`) }) })
  const openSiteTab = async (page) => {
    await page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
    await page.locator('.tdm-tab', { hasText: 'Контакт площадки' }).click()
    await page.locator('.tdm-site-list, .tdm-site .tdm-note').first().waitFor({ timeout: 10000 })
  }
  const siteRow = (page, division) => page.locator(`.tdm-site-row[data-division="${division}"]`)
  const letterModal = (page) => page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' })
  const letterText = (page) => letterModal(page).locator('div[style*="pre-wrap"]').innerText()
  const letterNotice = (page) => letterModal(page).locator('.letter-site-notice')
  const openLetter = async (page, num) => {
    await registryRow(page, num).locator('button[aria-label="Шаблон письма подрядчикам"]').click()
    await letterModal(page).waitFor({ timeout: 10000 })
    return letterText(page)
  }
  const closeLetter = (page) => letterModal(page).locator('.modal-close').click()

  it('без контакта подразделения — руководитель строительства «временно»; назначенный — в письме ФИО и телефон', async () => {
    const { page, errors, dialogs, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0')
    try {
      // tender-2 (№ 199): «Нурлы», «Монолит», контакта нет — письмо есть, в нём руководитель строительства.
      let text = await openLetter(page, 199)
      assert.ok(text.includes(`${ANCHOR}\n${LINE}Сидоров Сергей Петрович, тел. +7 702 111-22-33\n`), text)
      assert.ok(!text.includes('Экономистова'), 'экономист объекта — не контакт площадки')
      assert.equal(await letterNotice(page).getAttribute('class'), 'letter-site-notice is-warn')
      assert.match(await letterNotice(page).textContent(),
        /^Временное решение: подразделению «Монолит» на объекте «Бизнес-центр «Нурлы»» не назначен контакт площадки, поэтому в письме — руководитель строительства объекта\. Требуется назначить ответственного подразделения\./)
      // Почта — общий ящик (и в тексте, и внизу), телефон — ответственного; пояснение к документации — перед ссылкой.
      assert.ok(text.includes(`отправить запрос на электронную почту ${TENDER_MAILBOX}, в теле письма`))
      assert.ok(text.includes(`\nПочта: ${TENDER_MAILBOX}`))
      assert.match(text, /\nТелефон для связи: /)
      assert.ok(text.includes(`\n\n${ATTACHMENT_BLOCK}\n[Ссылка не указана]\n`), text)
      assert.equal(dialogs.length, 0, 'без окон с вопросами')

      // Администратору — переход в «Контакт площадки» на объект тендера.
      await letterNotice(page).getByRole('button', { name: 'Назначить в «Контакт площадки»' }).click()
      await page.locator('.tdm-site-list').waitFor({ timeout: 10000 })
      assert.equal(await letterModal(page).count(), 0)
      assert.equal(await page.locator('.tdm-tab.is-active').textContent(), 'Контакт площадки')
      assert.match(await page.locator('.tdm-site-object select option:checked').textContent(), /^Бизнес-центр «Нурлы» — назначено 0 из 6$/)
      assert.deepEqual(await page.locator('.tdm-site-row .tdm-site-div').allTextContents(),
        ['Монолит', 'НВФ/СПК', 'Общестроительные работы', 'ОВиВК', 'ЭОМ/СС', 'Отделка'])
      // Все шесть — временно руководитель строительства, это видно и написано.
      assert.equal(await page.locator('.tdm-site-row.is-temp').count(), 6)
      assert.equal(await siteRow(page, 'finishing').locator('.tdm-site-badge').textContent(), 'Временно')
      assert.match(await siteRow(page, 'finishing').textContent(),
        /Сидоров Сергей Петрович\+7 702 111-22-33Руководитель строительства объекта — требуется назначить ответственного подразделения/)
      assert.match(await page.locator('.tdm-site-alert.is-temp').textContent(), /^Временное решение\. Подразделений без ответственного: 6 из 6/)

      // Назначить «Монолит»: ФИО и телефон обязательны.
      await siteRow(page, 'monolith').getByRole('button', { name: 'Назначить контакт: Монолит' }).click()
      const form = siteRow(page, 'monolith').locator('form')
      await form.getByLabel('ФИО').fill('  Иванов Иван Иванович ')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      assert.ok(await form.getByLabel('Телефон').evaluate((el) => el.validity.valueMissing), 'без телефона форма не уходит')
      await form.getByLabel('Телефон').fill('+7 701 000-00-00')
      await form.getByLabel('Telegram').fill('site_nurly')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await siteRow(page, 'monolith').locator('.tdm-site-person').waitFor({ timeout: 10000 })
      const saved = await page.evaluate(() => window.__fakeDb.object_site_contacts)
      assert.equal(saved.length, 1)
      assert.deepEqual([saved[0].object_id, saved[0].division, saved[0].full_name, saved[0].telegram],
        ['obj-2', 'monolith', 'Иванов Иван Иванович', 'site_nurly'])
      assert.equal(await siteRow(page, 'monolith').getAttribute('class'), 'tdm-site-row')
      assert.match(await siteRow(page, 'monolith').textContent(), /Иванов Иван Иванович\+7 701 000-00-00 · Telegram: @site_nurly/)
      assert.equal(await siteRow(page, 'monolith').locator('a[href="https://t.me/site_nurly"]').count(), 1)
      assert.equal(await siteRow(page, 'monolith').locator('a[href="tel:+77010000000"]').count(), 1)
      assert.match(await page.locator('.tdm-site-object select option:checked').textContent(), /назначено 1 из 6$/)
      assert.match(await page.locator('.tdm-site-alert.is-temp').textContent(), /Подразделений без ответственного: 5 из 6/)

      // «Северный квартал»: руководителя строительства нет — красным, «требуется заполнение».
      await page.locator('.tdm-site-object select').selectOption('obj-1')
      assert.match(await page.locator('.tdm-site-object select option:checked').textContent(), /назначено 0 из 6 · нет руководителя строительства$/)
      assert.equal(await page.locator('.tdm-site-row.is-missing').count(), 6)
      assert.equal(await siteRow(page, 'general').locator('.tdm-site-badge').textContent(), 'Требуется заполнение')
      const alert = page.locator('.tdm-site-alert.is-error')
      assert.match(await alert.textContent(), /^Требуется заполнение\. .*не указан руководитель строительства — в письмо по этим подразделениям контакт не подставится/)
      assert.equal(await alert.locator('a').getAttribute('href'), '/general/objects/obj-1')
      assert.equal(await alert.evaluate((el) => getComputedStyle(el).color), await page.evaluate(() => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--danger-color)'
        document.body.append(probe)
        const c = getComputedStyle(probe).color
        probe.remove()
        return c
      }), 'предупреждение — красным')
      await page.locator('.tdm-modal .modal-close').click()

      // Теперь у № 199 свой контакт: ФИО и телефон, без Telegram и без предупреждения.
      text = await openLetter(page, 199)
      assert.ok(text.includes(`${ANCHOR}\n${LINE}Иванов Иван Иванович, тел. +7 701 000-00-00\n`), text)
      assert.ok(!/Telegram|site_nurly/.test(text))
      assert.equal(await letterNotice(page).count(), 0)
      await closeLetter(page)

      // № 200: «Северный квартал», подразделение не указано, руководителя нет — письмо всё равно есть,
      // на месте контакта — пометка, предупреждение красным.
      text = await openLetter(page, 200)
      assert.ok(text.includes(`${LINE}${SITE_CONTACT_MISSING}\n`), text)
      assert.equal(await letterNotice(page).getAttribute('class'), 'letter-site-notice is-error')
      assert.match(await letterNotice(page).textContent(),
        /^Контакт площадки не подставлен: у тендера не указано подразделение ВОР \(плашка под описанием работ\), а в карточке объекта не указан руководитель строительства/)
      await closeLetter(page)

      // «Отделка» в плашке подразделения под описанием — сохраняется в тендер.
      await registryRow(page, 200).locator('.vdiv-fdrop .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: /^Отделка/ }).click()
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-1').vor_division === 'finishing', null, { timeout: 10000 })
      assert.equal(dialogs.length, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('правка и снятие контакта; снятый — снова руководитель строительства', async () => {
    const contacts = [{ id: 'sc-1', object_id: 'obj-2', division: 'monolith', full_name: 'Петров Пётр', phone: '8 727 111-11-11', telegram: null }]
    const { page, errors, dialogs, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0', { contacts })
    try {
      await openSiteTab(page)
      await page.locator('.tdm-site-object select').selectOption('obj-2')
      await siteRow(page, 'monolith').getByRole('button', { name: 'Изменить контакт: Монолит' }).click()
      const form = siteRow(page, 'monolith').locator('form')
      assert.equal(await form.getByLabel('ФИО').inputValue(), 'Петров Пётр')
      // Escape закрывает форму, а не окно «Документы раздела».
      await form.getByLabel('ФИО').press('Escape')
      assert.equal(await siteRow(page, 'monolith').locator('form').count(), 0)
      assert.equal(await page.locator('.tdm-modal').count(), 1)

      await siteRow(page, 'monolith').getByRole('button', { name: 'Изменить контакт: Монолит' }).click()
      await form.getByLabel('Телефон').fill('+7 727 222-22-22')
      await form.getByLabel('Телефон').press('Enter')
      await page.waitForFunction(() => window.__fakeDb.object_site_contacts[0]?.phone === '+7 727 222-22-22', null, { timeout: 10000 })
      assert.equal(await page.evaluate(() => window.__fakeDb.object_site_contacts.length), 1, 'одна строка на объект и подразделение')

      await siteRow(page, 'monolith').getByRole('button', { name: 'Убрать контакт: Монолит' }).click()
      await page.waitForFunction(() => window.__fakeDb.object_site_contacts.length === 0, null, { timeout: 10000 })
      assert.match(dialogs.at(-1), /Убрать контакт площадки «Монолит» на объекте «Бизнес-центр «Нурлы»»\?/)
      assert.match(dialogs.at(-1), /пойдёт руководитель строительства объекта/)
      assert.equal(await siteRow(page, 'monolith').getAttribute('class'), 'tdm-site-row is-temp')
      await page.locator('.tdm-modal .modal-close').click()

      const text = await openLetter(page, 199)
      assert.ok(text.includes(`${LINE}Сидоров Сергей Петрович, тел. +7 702 111-22-33\n`))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без прав администратора: контакты видны, назначить нельзя; в письме — предупреждение без перехода', async () => {
    const contacts = [{ id: 'sc-1', object_id: 'obj-2', division: 'monolith', full_name: 'Иванов Иван', phone: '+7 701 000-00-00', telegram: '@site_nurly' }]
    const { page, errors, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0&canEdit=0', { contacts })
    try {
      await openSiteTab(page)
      await page.locator('.tdm-site-object select').selectOption('obj-2')
      assert.match(await siteRow(page, 'monolith').textContent(), /Иванов Иван/)
      assert.equal(await page.locator('.tdm-site-actions').count(), 0, 'кнопок назначения нет')
      assert.match(await page.locator('.tdm-site .tdm-lead').textContent(), /Назначает администратор\./)
      await page.locator('.tdm-modal .modal-close').click()

      // № 198 («Северный квартал», «Общестроительные работы»): ни контакта, ни руководителя.
      const text = await openLetter(page, 198)
      assert.ok(text.includes(`${LINE}${SITE_CONTACT_MISSING}\n`))
      assert.match(await letterNotice(page).textContent(), /подразделению «Общестроительные работы» на объекте «ЖК «Северный квартал»» не назначен контакт площадки/)
      assert.equal(await letterNotice(page).getByRole('button').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('база без миграции 20261030: вкладка — подсказка и руководитель строительства; письмо — с ним', async () => {
    const { page, errors, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0', { missingTable: true })
    try {
      await openSiteTab(page)
      assert.match(await page.locator('.tdm-site .tdm-note').first().textContent(), /после обновления базы \(миграция 20261030_site_contacts\)/)
      await page.locator('.tdm-site-object select').selectOption('obj-2')
      assert.equal(await page.locator('.tdm-site-row.is-temp').count(), 6)
      assert.equal(await page.locator('.tdm-site-actions').count(), 0, 'назначать некуда')
      await page.locator('.tdm-modal .modal-close').click()

      const text = await openLetter(page, 199)
      assert.ok(text.includes(`${ANCHOR}\n${LINE}Сидоров Сергей Петрович, тел. +7 702 111-22-33\n`), text)
      assert.equal(await letterNotice(page).getAttribute('class'), 'letter-site-notice is-warn')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
