// Инструкция по совместным тендерам: кнопка, вкладка, содержимое, снимки.
//   node .tmp-preview/joint-guide.mjs
import path from 'node:path'
import { openStand, elementShot, startServer } from './lib.mjs'

const SHOTS = process.env.SHOTS || 'C:/Users/Usrr/AppData/Local/Temp/claude/c--Users-Usrr-VSCode-Sadovnikov-OSP/403f0b54-2c90-44be-ab20-2503592fcba2/scratchpad'
let fails = 0
const ok = (cond, text) => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${text}`) }

const server = await startServer()

// ── Совместные тендеры: кнопка есть, окно открывается на своей вкладке ──────
const s = await openStand({ variant: 'new', view: 'joint', width: 1720, height: 1000, server })
const page = s.page

const btn = page.getByRole('button', { name: 'Инструкция' })
ok(await btn.count() === 1, `кнопка «Инструкция» в шапке совместных тендеров: ${await btn.count()}`)
await btn.click()
await page.waitForSelector('.tdm-modal', { timeout: 10000 })

const view = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.tdm-tab')].map(t => t.textContent.trim())
  const active = document.querySelector('.tdm-tab.is-active')?.textContent.trim()
  const sections = [...document.querySelectorAll('.tdm-body--guide .tdm-section h4')].map(h => h.textContent.trim())
  const steps = document.querySelectorAll('.tdm-table--steps tbody tr').length
  const warn = document.querySelectorAll('.tdm-body--guide .tdm-note, .tdm-unclear').length
  const body = document.querySelector('.tdm-body--guide')
  const overflow = [...document.querySelectorAll('.tdm-body--guide *')].some(el => el.scrollWidth > el.clientWidth + 2)
  return {
    tabs, active, sections, steps, warn,
    scrollH: body.scrollHeight, clientH: body.clientHeight, overflow,
    text: document.querySelector('.tdm-body--guide').innerText,
  }
})
ok(view.active === 'Совместные тендеры' && view.tabs[0] === 'Совместные тендеры',
  `по кнопке «Инструкция» открыта вкладка «${view.active}», она же первая; вкладки: ${view.tabs.join(' · ')}`)
ok(view.steps === 12, `в «Порядке работы» шагов: ${view.steps}`)
ok(view.sections.length === 7, `разделов: ${view.sections.length} — ${view.sections.join(' / ')}`)
ok(view.warn >= 9, `оговорок «не установлено / уточнить»: ${view.warn}`)
ok(!view.overflow, `ничего не вылезает за края окна: ${!view.overflow}`)

// Ключевые числа и формулировки — дословно из источника.
const must = [
  '0–10 млн', '11–50 млн', 'Более 51 млн',
  '5 рабочих дней после получения КП',
  '2 рабочих дня после направления сравнительной таблицы',
  '10 рабочих дней после протокола выбора победителя',
  '30 рабочих дней после заключения договора субподряда',
  'цена субподряда × 1,12',
  'Председатель — представитель Застройщика',
  'Приложению № 25 к ДГП',
  'Минимум фактических КП прямо не установлен',
  'Лимита «только одна переторжка» в источнике нет',
  'Порядок учёта НДС в этой формуле источник не раскрывает',
]
const missing = must.filter(m => !view.text.includes(m))
ok(missing.length === 0, `ключевые формулировки на месте${missing.length ? ': нет — ' + missing.join(' | ') : ''}`)

// Придуманного быть не должно.
const forbidden = ['одна переторжка допускается', 'не менее трёх КП', 'минимум 3 КП']
const invented = forbidden.filter(f => view.text.includes(f))
ok(invented.length === 0, `выдуманных правил нет${invented.length ? ': ' + invented.join(', ') : ''}`)

await elementShot(page, '.tdm-modal', path.join(SHOTS, 'joint-guide.png'))
// Второй экран инструкции — прокрутить вниз.
await page.evaluate(() => { document.querySelector('.tdm-body--guide').scrollTop = 1e6 })
await page.waitForTimeout(300)
await elementShot(page, '.tdm-modal', path.join(SHOTS, 'joint-guide-2.png'))

// Другие вкладки в этом же окне остались.
await page.getByRole('tab', { name: 'Инструкция' }).click()
await page.waitForTimeout(200)
const other = await page.evaluate(() => document.querySelector('.tdm-body--guide')?.innerText.slice(0, 40))
ok(/Запуск тендера/.test(other || ''), `общая инструкция на месте: «${(other || '').replace(/\s+/g, ' ').trim()}…»`)
await page.getByRole('button', { name: 'Закрыть' }).last().click()
await page.getByRole('button', { name: 'Документы' }).first().click()
await page.waitForSelector('.tdm-modal', { timeout: 10000 })
const docsTab = await page.evaluate(() => document.querySelector('.tdm-tab.is-active')?.textContent.trim())
ok(docsTab === 'Материалы', `кнопка «Документы» открывает окно как везде — на вкладке «${docsTab}»`)

ok(s.errors.length === 0, `ошибок страницы (совместные): ${s.errors.length}${s.errors.length ? ' — ' + s.errors[0] : ''}`)
await s.close()

// ── Обычные тендеры: ни кнопки, ни вкладки ────────────────────────────────
for (const view2 of ['construction', 'warranty', 'other']) {
  const c = await openStand({ variant: 'new', view: view2, width: 1720, height: 1000, server })
  const hasBtn = await c.page.getByRole('button', { name: 'Инструкция' }).count()
  await c.page.getByRole('button', { name: 'Документы' }).first().click()
  await c.page.waitForSelector('.tdm-modal', { timeout: 10000 })
  const t = await c.page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tdm-tab')].map(x => x.textContent.trim()),
    active: document.querySelector('.tdm-tab.is-active')?.textContent.trim(),
  }))
  ok(hasBtn === 0 && !t.tabs.includes('Совместные тендеры'),
    `${view2}: кнопки «Инструкция» нет (${hasBtn}), вкладки: ${t.tabs.join(' · ')}, открыта «${t.active}»`)
  ok(c.errors.length === 0, `${view2}: ошибок страницы ${c.errors.length}`)
  await c.close()
}

await server.close()
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : `\nВсе проверки пройдены. Снимки: ${SHOTS}`)
process.exitCode = fails ? 1 : 0
