// Сколько запросов к базе стоит переключение направления в «ВОРах и РД».
//   node .tmp-preview/vor-switch.mjs
// Считает обращения фейкового клиента (stubs/supabase.js пишет их в
// window.__STAND_QUERIES__) при первой загрузке и при каждом нажатии
// переключателя «Основное строительство» / «Совместные тендеры».
import { openStand, startServer } from './lib.mjs'

const summary = (list) => {
  const byTable = {}
  for (const q of list) {
    const k = `${q.table}`
    byTable[k] = byTable[k] || { n: 0, rows: 0 }
    byTable[k].n += 1
    byTable[k].rows += q.rows || 0
  }
  const parts = Object.entries(byTable).map(([t, v]) => `${t} ×${v.n} (${v.rows} стр.)`)
  return { count: list.length, text: parts.join(', ') || '—' }
}

const read = (page) => page.evaluate(() => (window.__STAND_QUERIES__ || []).slice())
const reset = (page) => page.evaluate(() => { window.__STAND_QUERIES__ = [] })
const rowsShown = (page) => page.evaluate(() => document.querySelectorAll('.vors-table tbody tr').length)

const server = await startServer()
for (const variant of ['cur', 'new']) {
  const s = await openStand({ variant, page: 'vors', width: 1720, height: 900, server })
  await s.page.waitForTimeout(600)
  const first = summary(await read(s.page))
  console.log(`\n${variant}: первая загрузка — запросов ${first.count}: ${first.text}; строк в таблице ${await rowsShown(s.page)}`)

  for (const [label, name] of [['→ Совместные', 'Совместные тендеры'], ['→ Основное', 'Основное строительство']]) {
    await reset(s.page)
    const t0 = Date.now()
    await s.page.getByRole('tab', { name }).click()
    await s.page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 15000 })
    await s.page.waitForTimeout(500)
    const m = summary(await read(s.page))
    console.log(`  ${label}: запросов ${m.count}: ${m.text}; строк ${await rowsShown(s.page)}; ${Date.now() - t0} мс (фейковая база — сеть не учитывается)`)
  }
  if (s.errors.length) console.log(`  ошибки: ${s.errors.slice(0, 2).join(' | ')}`)
  await s.close()
}
await server.close()
