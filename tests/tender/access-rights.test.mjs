// «Администрирование» → «Права доступа»: одна вкладка вместо трёх («Роли», «Права доступа», «Просмотр от имени роли»), 03.11.
// Правила ключа — без браузера; вкладка — стенд route=/stand/access-rights.
//   • добавить роль — рядом с выбором роли, только название, ключ выдаётся сам; системные роли не меняются;
//   • «Подрядчик» — в списке ролей: вместо галочек выбор организации и просмотр кабинета;
//   • права сохраняются сразу; просмотр от имени любой роли — отсюда же.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { roleKeyFromLabel, sameRoleLabel } from '../../src/utils/roleKey.js'

describe('Ключ новой роли', () => {
  it('из названия: латиница, цифры, «_», начинается с буквы', () => {
    assert.equal(roleKeyFromLabel('Прораб'), 'prorab')
    assert.equal(roleKeyFromLabel('Отдел по удорожанию'), 'otdel_po_udorozhaniyu')
    assert.equal(roleKeyFromLabel('  Юрист ОСП № 2 '), 'yurist_osp_2')
    assert.equal(roleKeyFromLabel('Гл. инженер (ГО)'), 'gl_inzhener_go')
    assert.equal(roleKeyFromLabel('Съёмщик'), 'semschik')
    assert.equal(roleKeyFromLabel('Site Manager'), 'site_manager')
    for (const label of ['Прораб', 'Отдел № 7', '123', '!!!', '', 'я'.repeat(200), 'Hello Мир']) {
      assert.match(roleKeyFromLabel(label), /^[a-z][a-z0-9_]*$/, label)
    }
    assert.equal(roleKeyFromLabel('123'), 'role_123')
    assert.equal(roleKeyFromLabel('!!!'), 'role')
    assert.ok(roleKeyFromLabel('я'.repeat(200)).length <= 45)
  })
  it('занятый ключ не выдаётся', () => {
    assert.equal(roleKeyFromLabel('Прораб', ['prorab']), 'prorab_2')
    assert.equal(roleKeyFromLabel('Прораб', ['prorab', 'prorab_2', 'prorab_3']), 'prorab_4')
  })
  it('те же названия — без регистра и лишних пробелов', () => {
    assert.equal(sameRoleLabel(' Прораб  участка', 'прораб участка'), true)
    assert.equal(sameRoleLabel('Прораб', 'Прорабы'), false)
  })
})

const launch = browserLaunchOptions()

describe('Вкладка «Права доступа»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const dialogs = []
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/stand/access-rights&latency=0`)
    const role = page.getByLabel('Роль', { exact: true })
    await role.waitFor({ timeout: 120000 })
    return { page, role, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const dbRows = (page, table) => page.evaluate((t) => window.__fakeDb[t], table)

  it('добавить роль: только название, ключ сам, роль сразу выбрана; повтор названия — отказ', async () => {
    const { page, role, errors, close } = await open()
    try {
      await page.getByRole('button', { name: '+ Добавить роль' }).click()
      await page.getByLabel('Название новой роли').fill('Прораб участка')
      await page.getByRole('button', { name: 'Добавить', exact: true }).click()
      await page.locator('.perm-feedback.ok').waitFor()
      const row = (await dbRows(page, 'roles')).find((r) => r.label === 'Прораб участка')
      assert.equal(row.key, 'prorab_uchastka')
      assert.equal(row.is_system, false)
      assert.equal(await role.inputValue(), 'prorab_uchastka', 'новая роль сразу выбрана — можно отмечать права')
      assert.equal(await page.locator('.perm-editor').count(), 0)
      assert.ok(await page.locator('.permissions-list-table').isVisible())

      await page.getByRole('button', { name: '+ Добавить роль' }).click()
      await page.getByLabel('Название новой роли').fill('  прораб   УЧАСТКА ')
      await page.getByRole('button', { name: 'Добавить', exact: true }).click()
      await page.locator('.perm-feedback.err', { hasText: 'уже есть' }).waitFor()
      assert.equal((await dbRows(page, 'roles')).filter((r) => /прораб/i.test(r.label)).length, 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('переименовать и удалить — только заведённые администратором', async () => {
    const { page, role, errors, dialogs, close } = await open()
    try {
      assert.equal(await role.inputValue(), 'engineer')
      assert.equal(await page.getByRole('button', { name: /^Переименовать роль/ }).count(), 0, 'системную — нельзя')
      assert.equal(await page.getByRole('button', { name: /^Удалить роль/ }).count(), 0)

      await role.selectOption('smetno')
      await page.getByRole('button', { name: /^Переименовать роль/ }).click()
      await page.getByLabel(/^Новое название роли/).fill('Сметчики')
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
      await page.locator('.perm-feedback.ok').waitFor()
      const row = (await dbRows(page, 'roles')).find((r) => r.key === 'smetno')
      assert.equal(row.label, 'Сметчики', 'ключ прежний — меняется только название')

      await page.getByRole('button', { name: /^Удалить роль/ }).click()
      await page.waitForFunction(() => !window.__fakeDb.roles.some((r) => r.key === 'smetno'))
      assert.match(dialogs[0], /Удалить роль «Сметчики»/)
      assert.equal(await role.inputValue(), 'engineer', 'после удаления — другая роль')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('права: галочки сохраняются сразу; редактирование включает просмотр', async () => {
    const { page, errors, close } = await open()
    try {
      const view = page.getByLabel('Реестр по договорам: просмотр')
      const edit = page.getByLabel('Реестр по договорам: редактирование')
      await view.waitFor()
      assert.equal(await page.getByLabel('Тендеры: просмотр').isChecked(), true, 'прежние права на месте')
      assert.equal(await edit.isChecked(), false)
      await edit.click()
      await page.waitForFunction(() => window.__fakeDb.role_permissions.some((p) => p.section === 'contracts'))
      await page.locator('.perm-feedback.ok').waitFor()
      assert.equal(await edit.isChecked(), true)
      assert.equal(await view.isChecked(), true)
      const row = (await dbRows(page, 'role_permissions')).find((p) => p.section === 'contracts')
      assert.deepEqual([row.role, row.can_view, row.can_edit], ['engineer', true, true])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Подрядчик» — в списке ролей: выбор организации вместо галочек, просмотр кабинета', async () => {
    const { page, role, errors, close } = await open()
    try {
      assert.equal(await page.evaluate(() => window.__counterpartiesRequested || 0), 0, 'контрагенты — только когда нужны')
      assert.deepEqual(await role.locator('optgroup').evaluateAll((g) => g.map((x) => x.label)), ['Сотрудники', 'Внешние пользователи'])
      assert.equal(await role.locator('optgroup[label="Сотрудники"] option[value="contractor"]').count(), 0)
      await role.selectOption('contractor')
      assert.equal(await page.locator('.permissions-list-table').count(), 0, 'разделов с галочками у подрядчика нет')
      assert.match(await page.locator('.perm-admin-notice').innerText(), /только в своём кабинете/)
      assert.equal(await page.getByRole('button', { name: /^Переименовать роль/ }).count(), 0)

      const go = page.getByRole('button', { name: 'Посмотреть как подрядчик' })
      await go.click()
      assert.match(await page.locator('.perm-preview-error').innerText(), /Выберите организацию/)
      assert.equal(await page.evaluate(() => window.__rolePreview || null), null, 'без организации режим не включается')

      await page.locator('.perm-preview .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'ООО Подрядчик Два' }).click()
      await go.click()
      await page.waitForFunction(() => window.__rolePreview)
      assert.deepEqual(await page.evaluate(() => window.__rolePreview), {
        role: 'contractor', objectIds: [], counterparty: { id: 'cp-2', name: 'ООО Подрядчик Два' },
      })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('просмотр от имени сотрудника: кнопка рядом с ролью, объекты — по желанию; у администратора галочек нет', async () => {
    const { page, role, errors, close } = await open()
    try {
      assert.equal(await page.locator('.perm-preview').count(), 0, 'панель открывается по кнопке')
      await page.getByRole('button', { name: 'Посмотреть от имени роли' }).click()
      assert.match(await page.locator('.perm-preview-note').innerText(), /под вашей учётной записью/)
      await page.getByRole('button', { name: 'Посмотреть как «Инженер ОСП»' }).click()
      await page.waitForFunction(() => window.__rolePreview)
      assert.deepEqual(await page.evaluate(() => window.__rolePreview), { role: 'engineer', objectIds: [], counterparty: null })

      await page.goto(`${stand.url}?route=/stand/access-rights&latency=0`)
      await role.waitFor()
      await role.selectOption('admin')
      assert.equal(await page.locator('.permissions-list-table').count(), 0)
      assert.match(await page.locator('.perm-admin-notice').innerText(), /полный доступ/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
