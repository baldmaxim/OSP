// Контакт площадки (object_site_contacts, миграция 20261030): вкладка «Контакт площадки» в «Документах
// раздела» реестра «Тендеры — Основное строительство» — по объекту список подразделений ВОР (с «Отделкой»),
// контакт назначает администратор. Письмо подрядчикам по тендеру формируется только с контактом площадки
// его объекта и подразделения: строка о выезде на объект — сразу после «…по какому тендеру и объекту
// обращаетесь.».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  SITE_CONTACT_LINE, formatSiteContact, telegramHref, telegramLabel, phoneHref, validateSiteContact,
  upgradeLetterTemplate, fillSiteContact,
} from '../../src/utils/siteContacts.js'

const ANCHOR = 'в теле письма указать по какому тендеру и объекту обращаетесь.'

describe('Контакт площадки: правила без базы', () => {
  it('вид в письме: ФИО, телефон, Telegram', () => {
    assert.equal(formatSiteContact({ full_name: ' Иванов Иван ', phone: '+7 701 000-00-00', telegram: 'site_nurly' }),
      'Иванов Иван, тел. +7 701 000-00-00, Telegram: @site_nurly')
    assert.equal(formatSiteContact({ full_name: 'Иванов Иван', phone: '+7 701 000-00-00', telegram: null }),
      'Иванов Иван, тел. +7 701 000-00-00')
    assert.equal(formatSiteContact(null), '')
  })

  it('Telegram: имя и ссылка t.me — профиль, номер — как ввели', () => {
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

  it('сохранённый раньше шаблон получает строку о выезде после «…обращаетесь.», правки остаются', () => {
    const old = `Тема: своя\n\nСвязь — ${ANCHOR}\n\nМы рассчитываем на сотрудничество.`
    const up = upgradeLetterTemplate(old)
    assert.equal(up, `Тема: своя\n\nСвязь — ${ANCHOR}\n${SITE_CONTACT_LINE}\n\nМы рассчитываем на сотрудничество.`)
    assert.equal(upgradeLetterTemplate(up), up, 'второй раз не добавляет')
    assert.equal(upgradeLetterTemplate('Текст.\n\nМы рассчитываем…'), `Текст.\n\n${SITE_CONTACT_LINE}\n\nМы рассчитываем…`)
    assert.equal(upgradeLetterTemplate(null), '')
  })

  it('подстановка: контакт — в строку; без контакта строки нет и пустого абзаца тоже', () => {
    const text = `А.\n${SITE_CONTACT_LINE}\n\nБ.`
    assert.equal(fillSiteContact(text, 'Иванов, тел. 1'),
      'А.\nЕсли потребуется выезд на объект, предоставляем контактные данные для связи: Иванов, тел. 1\n\nБ.')
    assert.equal(fillSiteContact(text, null), 'А.\n\nБ.')
    assert.equal(fillSiteContact(`А.\n\n${SITE_CONTACT_LINE}\n\nБ.`, null), 'А.\n\nБ.')
  })
})

const launch = browserLaunchOptions()

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

  // dialogs — тексты alert / confirm; confirm принимается, если answer() не вернул false.
  const openPage = async (query, { answer = () => true } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      if (d.type() === 'confirm' && answer(d.message()) === false) d.dismiss()
      else d.accept()
    })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  // Ждать, пока страница покажет ещё одно окно alert / confirm.
  const waitDialog = async (dialogs, count) => {
    const start = Date.now()
    while (dialogs.length < count) {
      if (Date.now() - start > 10000) throw new Error('окно сообщения не появилось')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr').filter({ has: page.locator('.tp-num-value', { hasText: new RegExp(`^${num}$`) }) })
  const openSiteTab = async (page) => {
    await page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
    await page.locator('.tdm-tab', { hasText: 'Контакт площадки' }).click()
    await page.locator('.tdm-site-list, .tdm-site .tdm-note').first().waitFor({ timeout: 10000 })
  }
  const siteRow = (page, division) => page.locator(`.tdm-site-row[data-division="${division}"]`)
  const letterText = (page) => page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' }).locator('div[style*="pre-wrap"]').innerText()
  const clickLetter = (page, num) => registryRow(page, num).locator('button[aria-label="Шаблон письма подрядчикам"]').click()
  const closeLetter = (page) => page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' }).locator('.modal-close').click()

  it('администратор назначает контакт; письмо — со строкой о выезде после «…обращаетесь.»', async () => {
    const { page, errors, dialogs, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0')
    try {
      // tender-2 (№ 199): объект «Нурлы», подразделение «Монолит», контакта нет — письма нет.
      await clickLetter(page, 199)
      await page.waitForFunction(() => document.querySelector('.tdm-site-list') !== null, null, { timeout: 10000 })
      assert.match(dialogs.at(-1), /На объекте «Бизнес-центр «Нурлы»» не назначен контакт площадки для подразделения «Монолит»/)
      assert.match(dialogs.at(-1), /Открыть «Контакт площадки» и назначить\?/)
      assert.equal(await page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' }).count(), 0, 'письмо не сформировано')

      // Предложение открыло вкладку на объекте тендера: шесть подразделений, с «Отделкой», все свободны.
      assert.equal(await page.locator('.tdm-tab.is-active').textContent(), 'Контакт площадки')
      assert.match(await page.locator('.tdm-site-object select option:checked').textContent(), /^Бизнес-центр «Нурлы» — назначено 0 из 6$/)
      assert.deepEqual(await page.locator('.tdm-site-row .tdm-site-div').allTextContents(),
        ['Монолит', 'НВФ/СПК', 'Общестроительные работы', 'ОВиВК', 'ЭОМ/СС', 'Отделка'])
      assert.equal(await page.locator('.tdm-site-row.is-empty').count(), 6)

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
      assert.equal(saved[0].object_id, 'obj-2')
      assert.equal(saved[0].division, 'monolith')
      assert.equal(saved[0].full_name, 'Иванов Иван Иванович')
      assert.equal(saved[0].telegram, 'site_nurly')
      assert.match(await siteRow(page, 'monolith').textContent(), /Иванов Иван Иванович\+7 701 000-00-00 · Telegram: @site_nurly/)
      assert.equal(await siteRow(page, 'monolith').locator('a[href="https://t.me/site_nurly"]').count(), 1)
      assert.equal(await siteRow(page, 'monolith').locator('a[href="tel:+77010000000"]').count(), 1)
      assert.match(await page.locator('.tdm-site-object select option:checked').textContent(), /назначено 1 из 6$/)
      // Другой объект — свои контакты.
      await page.locator('.tdm-site-object select').selectOption('obj-1')
      assert.equal(await page.locator('.tdm-site-row.is-empty').count(), 6)
      await page.locator('.tdm-modal .modal-close').click()

      // Теперь письмо по № 199 формируется: строка о выезде — с новой строки после «…обращаетесь.».
      await clickLetter(page, 199)
      const text = await letterText(page)
      assert.ok(text.includes(`${ANCHOR}\nЕсли потребуется выезд на объект, предоставляем контактные данные для связи: `
        + 'Иванов Иван Иванович, тел. +7 701 000-00-00, Telegram: @site_nurly\n'), text)
      assert.ok(!text.includes('{site_contact}'))
      await closeLetter(page)

      // № 200: подразделение не указано — письма нет, просьба указать подразделение.
      const before = dialogs.length
      await clickLetter(page, 200)
      await waitDialog(dialogs, before + 1)
      assert.match(dialogs.at(-1), /Укажите подразделение ВОР у тендера/)
      assert.equal(await page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' }).count(), 0)

      // «Отделка» в плашке подразделения под описанием — сохраняется в тендер.
      await registryRow(page, 200).locator('.vdiv-fdrop .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: /^Отделка/ }).click()
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-1').vor_division === 'finishing', null, { timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('правка и снятие контакта; снятый — письмо снова не формируется', async () => {
    // Снятие подтверждаем, а предложение открыть вкладку из письма — отклоняем.
    const { page, errors, dialogs, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0',
      { answer: (msg) => !/Открыть «Контакт площадки»/.test(msg) })
    try {
      await page.evaluate(() => {
        window.__fakeDb.object_site_contacts = [{ id: 'sc-1', object_id: 'obj-1', division: 'general', full_name: 'Петров Пётр', phone: '8 727 111-11-11', telegram: null }]
      })
      // № 198: объект «Северный квартал», «Общестроительные работы» — контакт есть, без Telegram.
      await clickLetter(page, 198)
      assert.ok((await letterText(page)).includes('предоставляем контактные данные для связи: Петров Пётр, тел. 8 727 111-11-11\n'))
      await closeLetter(page)

      await openSiteTab(page)
      await page.locator('.tdm-site-object select').selectOption('obj-1')
      await siteRow(page, 'general').getByRole('button', { name: 'Изменить контакт: Общестроительные работы' }).click()
      const form = siteRow(page, 'general').locator('form')
      assert.equal(await form.getByLabel('ФИО').inputValue(), 'Петров Пётр')
      // Escape закрывает форму, а не окно «Документы раздела».
      await form.getByLabel('ФИО').press('Escape')
      assert.equal(await siteRow(page, 'general').locator('form').count(), 0)
      assert.equal(await page.locator('.tdm-modal').count(), 1)

      await siteRow(page, 'general').getByRole('button', { name: 'Изменить контакт: Общестроительные работы' }).click()
      await form.getByLabel('Телефон').fill('+7 727 222-22-22')
      await form.getByLabel('Телефон').press('Enter')
      await page.waitForFunction(() => window.__fakeDb.object_site_contacts[0]?.phone === '+7 727 222-22-22', null, { timeout: 10000 })
      assert.equal(await page.evaluate(() => window.__fakeDb.object_site_contacts.length), 1, 'одна строка на объект и подразделение')

      await siteRow(page, 'general').getByRole('button', { name: 'Убрать контакт: Общестроительные работы' }).click()
      await page.waitForFunction(() => window.__fakeDb.object_site_contacts.length === 0, null, { timeout: 10000 })
      assert.match(dialogs.at(-1), /Убрать контакт площадки «Общестроительные работы» на объекте «ЖК «Северный квартал»»\?/)
      assert.equal(await siteRow(page, 'general').locator('.tdm-site-none').textContent(), 'Не назначен')
      await page.locator('.tdm-modal .modal-close').click()

      // Контакт снят: письма нет; отказ от предложения открыть вкладку — окно не открывается.
      const before = dialogs.length
      await clickLetter(page, 198)
      await waitDialog(dialogs, before + 1)
      assert.match(dialogs.at(-1), /не назначен контакт площадки для подразделения «Общестроительные работы»/)
      await page.waitForTimeout(200)
      assert.equal(await page.locator('.tdm-modal').count(), 0)
      assert.equal(await page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без прав администратора: контакты видны, назначить нельзя; без контакта — подсказка, кто назначает', async () => {
    const { page, errors, dialogs, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0&canEdit=0')
    try {
      await page.evaluate(() => {
        window.__fakeDb.object_site_contacts = [{ id: 'sc-1', object_id: 'obj-2', division: 'monolith', full_name: 'Иванов Иван', phone: '+7 701 000-00-00', telegram: '@site_nurly' }]
      })
      await openSiteTab(page)
      await page.locator('.tdm-site-object select').selectOption('obj-2')
      assert.match(await siteRow(page, 'monolith').textContent(), /Иванов Иван/)
      assert.equal(await page.locator('.tdm-site-actions').count(), 0, 'кнопок назначения нет')
      assert.match(await page.locator('.tdm-site .tdm-lead').textContent(), /Назначает администратор\./)
      await page.locator('.tdm-modal .modal-close').click()

      // № 198 («Северный квартал», «Общестроительные работы») — контакта нет: только сообщение.
      await clickLetter(page, 198)
      await waitDialog(dialogs, 1)
      assert.match(dialogs.at(-1), /Назначает администратор: «Документы» → «Контакт площадки»\./)
      assert.equal(await page.locator('.tdm-modal').count(), 0, 'вкладка не открывается')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('база без миграции 20261030: вкладка подсказывает, письмо — как раньше, без строки о выезде', async () => {
    const { page, errors, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0')
    try {
      await page.evaluate(() => {
        window.__fakeErrors = { object_site_contacts: { code: 'PGRST205', message: "Could not find the table 'public.object_site_contacts' in the schema cache" } }
      })
      await openSiteTab(page)
      assert.match(await page.locator('.tdm-site .tdm-note').textContent(), /после обновления базы \(миграция 20261030_site_contacts\)/)
      await page.locator('.tdm-modal .modal-close').click()

      await clickLetter(page, 199)
      const text = await letterText(page)
      assert.ok(text.includes(`${ANCHOR}\n\nМы рассчитываем`), text)
      assert.ok(!text.includes('выезд на объект'))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
