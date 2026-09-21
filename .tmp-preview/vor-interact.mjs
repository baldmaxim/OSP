// Порционная отрисовка не должна «терять» строки: после любого действия
// количество строк в таблице обязано сойтись со счётчиком «Показано».
//   node .tmp-preview/vor-interact.mjs [bulk]
import { openStand, startServer } from './lib.mjs'

const BULK = Number(process.argv[2]) || 340
let fails = 0
const ok = (cond, text) => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${text}`) }

const settle = async (page) => {
  await page.waitForFunction(() => {
    const shown = Number((document.querySelector('.cp-shown b')?.textContent || '0').replace(/\s/g, ''))
    return document.querySelectorAll('.vors-table tbody tr').length >= shown
  }, null, { timeout: 15000 }).catch(() => {})
  return page.evaluate(() => ({
    rows: document.querySelectorAll('.vors-table tbody tr').length,
    shown: Number((document.querySelector('.cp-shown b')?.textContent || '0').replace(/\s/g, '')),
  }))
}

const server = await startServer()
const s = await openStand({ variant: 'new', page: 'vors', width: 1720, height: 900, bulk: BULK, server })
const page = s.page

let r = await settle(page)
ok(r.rows === r.shown, `первая загрузка: строк ${r.rows}, «Показано» ${r.shown}`)

await page.getByRole('tab', { name: 'Совместные тендеры' }).click()
r = await settle(page)
ok(r.rows === r.shown, `совместные: строк ${r.rows}, «Показано» ${r.shown}`)

await page.getByRole('tab', { name: 'Основное строительство' }).click()
r = await settle(page)
ok(r.rows === r.shown, `обратно на основное: строк ${r.rows}, «Показано» ${r.shown}`)

// Поиск сужает список, очистка — возвращает.
await page.locator('.cost-plans-search').fill('ЖК ЗИЛ')
await page.waitForTimeout(400)
r = await settle(page)
ok(r.rows === r.shown && r.rows > 0, `поиск «ЖК ЗИЛ»: строк ${r.rows}, «Показано» ${r.shown}`)
await page.locator('.cost-plans-search').fill('')
await page.waitForTimeout(400)
r = await settle(page)
ok(r.rows === r.shown, `поиск очищен: строк ${r.rows}, «Показано» ${r.shown}`)

// Статус-вкладки.
await page.getByRole('button', { name: /ВОРы и РД по статусам/ }).click()
for (const tab of ['Не начат', 'В работе', 'Завершено']) {
  await page.getByRole('button', { name: new RegExp('^' + tab) }).click()
  r = await settle(page)
  ok(r.rows === r.shown, `вкладка «${tab}»: строк ${r.rows}, «Показано» ${r.shown}`)
}
await page.getByRole('button', { name: /^Все ВОРы и РД/ }).click()
r = await settle(page)
ok(r.rows === r.shown, `назад на «Все»: строк ${r.rows}, «Показано» ${r.shown}`)

// Сортировка по номеру тендера: порядок меняется, строки не теряются.
await page.locator('.vors-table th.sortable-th').first().click()
r = await settle(page)
const firstNums = await page.evaluate(() => [...document.querySelectorAll('.vors-table tbody tr')].slice(0, 3)
  .map(tr => tr.querySelector('td')?.innerText.replace(/\s+/g, ' ').trim()))
ok(r.rows === r.shown, `сортировка по № : строк ${r.rows}, «Показано» ${r.shown}, первые ${firstNums.join(', ')}`)

// Вкладка «Удалённые».
await page.getByRole('button', { name: /^Удалённые/ }).click()
r = await settle(page)
ok(r.rows === r.shown || r.shown === 0, `«Удалённые»: строк ${r.rows}, «Показано» ${r.shown}`)

// Описания с «Показать полностью» считаются после общего замера.
const clamp = await page.evaluate(() => ({
  toggles: document.querySelectorAll('.vr-desc-toggle').length,
  texts: document.querySelectorAll('.vr-desc-text').length,
}))
await page.getByRole('button', { name: /^Все ВОРы и РД/ }).click()
await settle(page)
const clampAll = await page.evaluate(() => ({
  toggles: document.querySelectorAll('.vr-desc-toggle').length,
  texts: document.querySelectorAll('.vr-desc-text').length,
}))
ok(clampAll.toggles > 0, `кнопки «Показать полностью» на месте: ${clampAll.toggles} из ${clampAll.texts} описаний (на «Удалённых» было ${clamp.toggles}/${clamp.texts})`)

ok(s.errors.length === 0, `ошибок страницы: ${s.errors.length}${s.errors.length ? ' — ' + s.errors[0] : ''}`)
await s.close()
await server.close()
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВсе проверки пройдены')
process.exitCode = fails ? 1 : 0
