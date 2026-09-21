// Профиль переключения направления: где уходит время при 340 тендерах.
//   node .tmp-preview/vor-profile.mjs [bulk]
// Снимает профиль CPU через CDP и печатает функции по собственному времени.
import { openStand, startServer } from './lib.mjs'

const BULK = Number(process.argv[2]) || 340

const server = await startServer()
const s = await openStand({ variant: 'new', page: 'vors', width: 1720, height: 900, bulk: BULK, server })
const page = s.page
const cdp = await page.context().newCDPSession(page)

// Прогрев: первое переключение включает ленивые куски.
await page.getByRole('tab', { name: 'Совместные тендеры' }).click()
await page.waitForTimeout(1200)

await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')
const t0 = Date.now()
await page.getByRole('tab', { name: 'Основное строительство' }).click()
await page.waitForFunction(() => document.querySelectorAll('.vors-table tbody tr').length > 100, null, { timeout: 30000 })
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
const ms = Date.now() - t0
const { profile } = await cdp.send('Profiler.stop')

// Собственное время по узлам: сколько сэмплов пришлось на каждую функцию.
const byId = new Map(profile.nodes.map(n => [n.id, n]))
const self = new Map()
const total = profile.samples?.length || 0
for (let i = 0; i < (profile.samples || []).length; i += 1) {
  const node = byId.get(profile.samples[i])
  if (!node) continue
  const f = node.callFrame
  const key = `${f.functionName || '(анонимная)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`
  self.set(key, (self.get(key) || 0) + 1)
}
const dur = (profile.endTime - profile.startTime) / 1000
console.log(`Переключение на «Основное строительство»: ${ms} мс, профиль ${Math.round(dur)} мс, сэмплов ${total}`)
console.log('Топ по собственному времени:')
;[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, n]) => {
  console.log(`  ${String(Math.round((n / total) * 100)).padStart(3)}%  ${Math.round((n / total) * dur).toString().padStart(5)} мс  ${k}`)
})

// Сколько всего узлов DOM и «тяжёлых» виджетов в строке.
console.log('\nВ таблице:', await page.evaluate(() => {
  const t = document.querySelector('.vors-table')
  return {
    строк: t.querySelectorAll('tbody tr').length,
    узловDOM: t.querySelectorAll('*').length,
    выпадашек: t.querySelectorAll('.fdrop').length,
    датныхЯчеек: t.querySelectorAll('.drc-btn').length,
    кнопок: t.querySelectorAll('button').length,
  }
}))
await s.close()
await server.close()
