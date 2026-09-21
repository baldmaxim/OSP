// Сколько длится переключение направления на настоящем объёме (~340 тендеров).
//   node .tmp-preview/vor-time.mjs [bulk]
//
// Замер ведёт сама страница (кадр за кадром), чтобы ожидания Playwright не
// добавляли своё время. У стенда база отвечает мгновенно, поэтому для «cur»
// это нижняя граница: в бою сюда добавляются запросы к Supabase.
import { openStand, startServer } from './lib.mjs'

const BULK = Number(process.argv[2]) || 340

const installTimeline = (page) => page.evaluate(() => {
  window.__GEN = 0
  window.__START = () => {
    const gen = ++window.__GEN          // старый цикл сам остановится
    window.__TL = []
    const t0 = performance.now()
    const tick = () => {
      if (window.__GEN !== gen) return
      window.__TL.push([
        Math.round(performance.now() - t0),
        document.querySelectorAll('.vors-table tbody tr').length,
        !!document.querySelector('.loading'),
      ])
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
})

const switchTime = async (page, name) => {
  await installTimeline(page)
  const before = await page.evaluate(() => document.querySelectorAll('.vors-table tbody tr').length)
  await page.evaluate(() => window.__START())
  await page.getByRole('tab', { name }).click()
  await page.waitForTimeout(4200)
  const tl = await page.evaluate(() => window.__TL)
  const target = await page.evaluate(() => Number((document.querySelector('.cp-shown b')?.textContent || '0').replace(/\s/g, '')))
  const final = tl.length ? tl[tl.length - 1][1] : 0
  const firstChange = tl.find(([, n]) => n !== before && n > 0)
  const complete = firstChange ? tl.find(([ms, n]) => ms >= firstChange[0] && n >= final) : null
  const blank = tl.some(([, n, loading]) => loading || n === 0)
  return { first: firstChange?.[0] ?? null, all: complete?.[0] ?? null, target, final, blank }
}

const server = await startServer()
for (const variant of ['cur', 'new']) {
  const s = await openStand({ variant, page: 'vors', width: 1720, height: 900, bulk: BULK, server })
  const rows = await s.page.evaluate(() => document.querySelectorAll('.vors-table tbody tr').length)
  console.log(`\n${variant} (bulk=${BULK}, строк ${rows}):`)
  for (const name of ['Совместные тендеры', 'Основное строительство', 'Совместные тендеры', 'Основное строительство']) {
    const r = await switchTime(s.page, name)
    console.log(`  → ${name.padEnd(22)} первые строки ${String(r.first).padStart(4)} мс, все ${String(r.all).padStart(4)} мс (${r.target} стр.)${r.blank ? ', таблица пропадала («Загрузка…»)' : ''}`)
  }
  if (s.errors.length) console.log(`  ошибки: ${s.errors.slice(0, 2).join(' | ')}`)
  await s.close()
}
await server.close()
