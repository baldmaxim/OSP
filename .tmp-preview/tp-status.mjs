import { openStand } from './lib.mjs'
const s = await openStand({ variant: process.argv[2] || 'new', width: 1720, height: 1000 })
const r = await s.page.evaluate(() => {
  const px = (n) => Math.round(n * 10) / 10
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('table.tenders-registry tbody .status-dropdown-label, table.tenders-registry tbody .tp-status-badge')) {
    const text = el.textContent.trim().replace(/\s+/g, ' ')
    if (seen.has(text)) continue
    seen.add(text)
    const rg = document.createRange(); rg.selectNodeContents(el)
    const lines = new Set([...rg.getClientRects()].filter(q => q.width > 0.5).map(q => Math.round(q.top))).size
    const td = el.closest('td'); const cs = getComputedStyle(td)
    const trigger = el.closest('.status-dropdown-trigger, .tp-status-badge') || el
    const tcs = getComputedStyle(trigger)
    // сколько нужно в одну строку: текст + отступы плашки + шеврон
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(el).font}`
    probe.textContent = text
    document.body.appendChild(probe)
    const textW = probe.getBoundingClientRect().width
    probe.remove()
    const chev = trigger.querySelector('.status-dropdown-chevron')
    const need = textW + parseFloat(tcs.paddingLeft) + parseFloat(tcs.paddingRight) + (chev ? chev.getBoundingClientRect().width + 4 : 0) + 2
    out.push(`«${text}» строк=${lines} · нужно ${px(need)} · поле ${px(td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))} · колонка ${px(td.getBoundingClientRect().width)}`)
  }
  return out
})
console.log(r.join('\n'))
await s.close()
