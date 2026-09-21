// Регрессии после правки плотности: масштабы/ширины, раскрытие адреса,
// «Показать полностью», компактный вид, раскрытый список контрагентов, фокус.
import { openStand } from './lib.mjs'
const variant = process.argv[2] || 'new'
let fails = 0
const ok = (cond, text) => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${text}`) }

// 1) матрица окон и масштабов
for (const v of [[1920, 1], [1720, 1], [1366, 1], [1536, 1.25], [960, 2]]) {
  const s = await openStand({ variant, width: v[0], height: 1000, deviceScaleFactor: v[1] })
  const r = await s.page.evaluate(() => {
    const px = (n) => Math.round(n * 10) / 10
    const t = document.querySelector('table.tenders-registry')
    const c = t.closest('.table-container')
    const doc = document.documentElement
    const spill = []
    for (const td of t.querySelectorAll(':scope > tbody > tr > td')) {
      const cs = getComputedStyle(td); const box = td.getBoundingClientRect()
      const right = box.right - parseFloat(cs.paddingRight) + 1.5
      for (const ch of td.querySelectorAll('*')) {
        const rr = ch.getBoundingClientRect()
        if (!rr.width || ch.closest('.ui-sr-only')) continue
        if (rr.right > right && rr.width <= box.width) { spill.push(`${td.cellIndex}:${String(ch.className).split(' ')[0]}`); break }
      }
    }
    return {
      table: px(t.getBoundingClientRect().width), cont: px(c.clientWidth),
      hscroll: px(c.scrollWidth - c.clientWidth), page: doc.scrollWidth > doc.clientWidth,
      desc: px(t.querySelector(':scope > thead > tr > th:nth-child(3)').getBoundingClientRect().width),
      spill: [...new Set(spill)],
    }
  })
  ok(!r.page && r.spill.length === 0, `${v[0]}@${v[1]}: таблица ${r.table}/${r.cont}, прокрутка ${r.hscroll}px, описание ${r.desc}px, выходов ${r.spill.length}${r.spill.length ? ' ' + r.spill.join(',') : ''}, страница не едет=${!r.page}`)
  await s.close()
}

// 2) адрес, «Показать полностью», фокус, контрагенты, компактный вид
const s = await openStand({ variant, width: 1720, height: 1000 })
const page = s.page
const rowOf = (num) => page.locator('table.tenders-registry > tbody > tr', { hasText: new RegExp(`^\\s*${num}`) }).first()

const addrBtn = rowOf('782').locator('.tp-addr-toggle')
const h0 = await rowOf('782').evaluate(el => Math.round(el.getBoundingClientRect().height))
await addrBtn.click()
const h1 = await rowOf('782').evaluate(el => Math.round(el.getBoundingClientRect().height))
const addrText = await rowOf('782').locator('.tp-addr-block .tp-obj-address').innerText()
ok(h1 > h0 && addrText.length > 20, `адрес раскрывается: строка ${h0} → ${h1}px, текст «${addrText.slice(0, 32)}…»`)
const othersOpen = await page.locator('.tp-addr-toggle[aria-expanded="true"]').count()
ok(othersOpen === 1, `раскрыт только один адрес: ${othersOpen}`)
const colsAfter = await page.evaluate(() => [...document.querySelectorAll('table.tenders-registry > thead > tr > th')].map(th => Math.round(th.getBoundingClientRect().width)).join('/'))
await addrBtn.click()
const colsBefore = await page.evaluate(() => [...document.querySelectorAll('table.tenders-registry > thead > tr > th')].map(th => Math.round(th.getBoundingClientRect().width)).join('/'))
ok(colsAfter === colsBefore, `ширины колонок при раскрытии адреса не пересчитываются: ${colsAfter === colsBefore}`)

const toggle = rowOf('778').locator('.ui-clamp-toggle')
const hasToggle = await toggle.count()
const clampH0 = await rowOf('778').evaluate(el => Math.round(el.getBoundingClientRect().height))
if (hasToggle) { await toggle.click() }
const clampH1 = await rowOf('778').evaluate(el => Math.round(el.getBoundingClientRect().height))
ok(hasToggle === 1 && clampH1 > clampH0, `«Показать полностью» у 778 раскрывает текст: ${clampH0} → ${clampH1}px`)
if (hasToggle) await toggle.click()
const toggle780 = await rowOf('780').locator('.ui-clamp-toggle').count()
ok(toggle780 === 0, `у короткого описания (780) кнопки раскрытия нет: ${toggle780}`)

// путь и ТГ в одной строке
const sameLine = await rowOf('782').evaluate(tr => {
  const cell = tr.querySelector('td.tender-desc-cell')
  const path = cell.querySelector('.fpath, .fpath-add'); const flags = cell.querySelector('.tender-flags')
  if (!path || !flags) return false
  return Math.abs(path.getBoundingClientRect().top - flags.getBoundingClientRect().top) < 4
})
ok(sameLine, `путь к папке и «ТГ» в одной строке: ${sameLine}`)

// фокус с клавиатуры виден и не обрезан
const focus = await page.evaluate(() => {
  const btn = document.querySelector('.tp-addr-toggle')
  btn.focus()
  const cs = getComputedStyle(btn)
  return { tag: document.activeElement.className, outline: cs.outlineStyle, width: cs.outlineWidth }
})
ok(focus.tag.includes('tp-addr-toggle'), `фокус на кнопке адреса: ${focus.tag.slice(0, 24)} (${focus.outline} ${focus.width})`)

// раскрытый список контрагентов
await rowOf('769').locator('.expand-toggle').click()
await page.waitForSelector('.expanded-cp-row', { timeout: 5000 })
const cp = await page.evaluate(() => {
  const row = document.querySelector('.expanded-cp-row')
  const t = row.querySelector('.data-table')
  const th = t && getComputedStyle(t.querySelector('thead th'))
  const td = t && getComputedStyle(t.querySelector('tbody td'))
  return { rows: t ? t.querySelectorAll('tbody tr').length : 0, th: th && `${th.fontSize}/${th.lineHeight} ${th.fontWeight}`, td: td && `${td.fontSize}/${td.lineHeight}`, cols: row.closest('tr').querySelector('td').colSpan }
})
ok(cp.rows > 0, `раскрытый список контрагентов: строк ${cp.rows}, заголовок ${cp.th}, данные ${cp.td}, colspan ${cp.cols}`)
await rowOf('769').locator('.expand-toggle').click()

// компактный вид
await page.getByRole('button', { name: /Компактный вид|Полный вид/ }).click()
await page.waitForTimeout(400)
const compact = await page.evaluate(() => {
  const t = document.querySelector('table.tenders-registry')
  const c = t.closest('.table-container')
  return { compact: t.classList.contains('data-table--compact'), cols: t.querySelectorAll('thead th').length, table: Math.round(t.getBoundingClientRect().width), cont: c.clientWidth, err: 0 }
})
ok(compact.compact && compact.cols < 12, `компактный вид: колонок ${compact.cols}, таблица ${compact.table}/${compact.cont}`)
ok(s.errors.length === 0, `ошибок страницы: ${s.errors.length}${s.errors.length ? ' ' + s.errors[0] : ''}`)
await s.close()
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВсе проверки пройдены')
process.exitCode = fails ? 1 : 0
