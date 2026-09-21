// Сколько ширины реально нужно каждой колонке при текущем кегле:
// максимум по строкам от «самой широкой неразрывной группы» в ячейке.
import { openStand } from './lib.mjs'
const variant = process.argv[2] || 'new'
const s = await openStand({ variant, width: 1920, height: 1000 })
const r = await s.page.evaluate(() => {
  const px = (n) => Math.round(n * 10) / 10
  const table = document.querySelector('table.tenders-registry')
  const heads = [...table.querySelectorAll(':scope > thead > tr > th')].map(th => th.textContent.trim().replace(/\s+/g, ' ').slice(0, 20) || '—')
  const rows = [...table.querySelectorAll(':scope > tbody > tr')]
  const need = heads.map(() => 0)
  const sample = heads.map(() => '')
  // ширина самого широкого «неразрывного» куска: элементы с white-space: nowrap
  // и отдельные слова обычного текста
  const widest = (td) => {
    let max = 0, what = ''
    const consider = (w, text) => { if (w > max) { max = w; what = text } }
    for (const el of td.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none') continue
      if (cs.whiteSpace.includes('nowrap') || el.children.length === 0) {
        const r = el.getBoundingClientRect()
        if (r.height > 0) consider(r.width, (el.textContent || '').trim().slice(0, 24))
      }
    }
    const rg = document.createRange()
    for (const n of td.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) { rg.selectNode(n); consider(rg.getBoundingClientRect().width, n.textContent.trim().slice(0, 24)) }
    }
    return [max, what]
  }
  for (const tr of rows) {
    ;[...tr.children].forEach((td, i) => {
      const [w, what] = widest(td)
      if (w > need[i]) { need[i] = w; sample[i] = what }
    })
  }
  // заголовок тоже должен помещаться
  const headNeed = [...table.querySelectorAll(':scope > thead > tr > th')].map((th) => {
    let max = 0
    const rg = document.createRange()
    for (const n of th.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) { rg.selectNode(n); max = Math.max(max, rg.getBoundingClientRect().width) }
      else if (n.nodeType === 1) max = Math.max(max, n.getBoundingClientRect().width)
    }
    return max
  })
  const pad = (() => { const cs = getComputedStyle(table.querySelector('td')); return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 1 })()
  return heads.map((h, i) => ({
    col: h,
    cur: px([...table.querySelectorAll(':scope > thead > tr > th')][i].getBoundingClientRect().width),
    needCell: px(need[i] + pad),
    needHead: px(headNeed[i] + pad),
    rem: ((Math.max(need[i], headNeed[i]) + pad) / 16).toFixed(2),
    sample: sample[i],
  }))
})
console.log(`вариант ${variant}, окно 1920`)
for (const c of r) console.log(`  ${c.col.padEnd(22)} сейчас ${String(c.cur).padStart(6)} · нужно ячейке ${String(c.needCell).padStart(6)} (${c.sample}) · заголовку ${String(c.needHead).padStart(6)} → ${c.rem}rem`)
console.log('ошибки:', s.errors.length)
await s.close()
