// Проверки после правок: высота шапки, переносы в узких колонках, выход за ячейку.
// node .tmp-preview/tp-check.mjs [variants] [width]
import { openStand } from './lib.mjs'
const variants = (process.argv[2] || 'cur,new').split(',')
const width = Number(process.argv[3] || 1720)
for (const variant of variants) {
  const s = await openStand({ variant, width, height: 1000 })
  const r = await s.page.evaluate(() => {
    const px = (n) => Math.round(n * 10) / 10
    const lines = (el) => {
      const rg = document.createRange(); rg.selectNodeContents(el)
      return new Set([...rg.getClientRects()].filter(q => q.width > 0.5).map(q => Math.round(q.top))).size
    }
    const table = document.querySelector('table.tenders-registry')
    const header = document.querySelector('.page-header')
    const tabs = document.querySelector('.tender-tabs')
    const filters = document.querySelector('.tp-filters')
    // выход содержимого за ячейку
    const spill = []
    for (const td of table.querySelectorAll(':scope > tbody > tr > td')) {
      const cs = getComputedStyle(td); const box = td.getBoundingClientRect()
      const right = box.right - parseFloat(cs.paddingRight) + 1.5
      for (const ch of td.querySelectorAll('*')) {
        if (ch.closest('.ui-sr-only') || !ch.getBoundingClientRect().width) continue
        const r = ch.getBoundingClientRect()
        if (r.right > right && r.width <= box.width) { spill.push(`${td.cellIndex}:${String(ch.className).split(' ')[0]}+${px(r.right - right)}«${ch.textContent.trim().slice(0, 18)}»`); break }
      }
    }
    // переносы в коротких значениях
    const wraps = []
    for (const sel of ['.responsible-empty', '.responsible-display', '.tp-status-badge', '.status-dropdown-label', '.tender-period-cell', '.phase-done', '.phase-warn', '.phase-pending']) {
      for (const el of table.querySelectorAll(`tbody ${sel}`)) {
        const t = el.textContent.trim()
        if (t && lines(el) > 1 && t.length < 26) wraps.push(`${sel}«${t.slice(0, 24)}»×${lines(el)}`)
      }
    }
    // мелкий текст
    const small = new Set()
    const walk = document.createTreeWalker(document.querySelector('.main-content'), NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement
      if (!n.textContent.trim() || el.closest('.ui-sr-only') || !el.getBoundingClientRect().width) continue
      const fs = parseFloat(getComputedStyle(el).fontSize)
      if (fs < 11) small.add(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}@${fs}`)
    }
    const cont = table.closest('.table-container')
    return {
      header: px(header?.getBoundingClientRect().height), tabs: px(tabs?.getBoundingClientRect().height), filters: px(filters?.getBoundingClientRect().height),
      chrome: px((header?.getBoundingClientRect().height || 0) + (tabs?.getBoundingClientRect().height || 0) + (filters?.getBoundingClientRect().height || 0)),
      table: px(table.getBoundingClientRect().width), cont: px(cont.clientWidth), hscroll: px(cont.scrollWidth - cont.clientWidth),
      rows: table.querySelectorAll(':scope > tbody > tr').length,
      totalH: px([...table.querySelectorAll(':scope > tbody > tr')].reduce((a, tr) => a + tr.getBoundingClientRect().height, 0)),
      spill: [...new Set(spill)], wraps: [...new Set(wraps)], small: [...small],
    }
  })
  console.log(`\n${variant} @${width}: шапка ${r.header} + вкладки ${r.tabs} + панель ${r.filters} = ${r.chrome}px · таблица ${r.table}/${r.cont} прокрутка ${r.hscroll} · строк ${r.rows}, сумма ${r.totalH}`)
  console.log(`  выход за ячейку: ${r.spill.length ? r.spill.join(', ') : 'нет'}`)
  console.log(`  перенос коротких значений: ${r.wraps.length ? r.wraps.join(', ') : 'нет'}`)
  console.log(`  текст <11px: ${r.small.length ? r.small.join(', ') : 'нет'} · ошибки: ${s.errors.length}`)
  await s.close()
}
