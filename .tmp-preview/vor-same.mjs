// Содержимое реестра до и после правки загрузки должно совпасть построчно.
//   node .tmp-preview/vor-same.mjs
// Для обоих направлений и всех вкладок сверяем номера строк и счётчики.
import { openStand, startServer } from './lib.mjs'

const snapshot = async (page) => {
  const tabs = ['Все ВОРы и РД', 'Удалённые']
  const out = {}
  for (const tab of tabs) {
    await page.getByRole('button', { name: new RegExp('^' + tab) }).click()
    // Таблица рисуется порциями — ждём, пока появятся все строки.
    await page.waitForFunction(() => {
      const shown = Number((document.querySelector('.cp-shown b')?.textContent || '0').replace(/\s/g, ''))
      return document.querySelectorAll('.vors-table tbody tr').length >= shown
    }, null, { timeout: 15000 })
    await page.waitForTimeout(250)
    out[tab] = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.vors-table tbody tr')]
        .map(tr => tr.querySelector('td')?.innerText.replace(/\s+/g, ' ').trim())
      const counters = [...document.querySelectorAll('.cost-plans-tabs .tab')]
        .map(b => b.innerText.replace(/\s+/g, ' ').trim())
      const shown = document.querySelector('.cp-shown')?.innerText.replace(/\s+/g, ' ').trim()
      return { rows, counters, shown }
    })
  }
  // Статус-вкладки — под кнопкой «ВОРы и РД по статусам».
  await page.getByRole('button', { name: /ВОРы и РД по статусам/ }).click()
  await page.waitForTimeout(200)
  out.statuses = await page.evaluate(() => [...document.querySelectorAll('.cost-plans-tabs .tab')]
    .map(b => b.innerText.replace(/\s+/g, ' ').trim()))
  await page.getByRole('button', { name: /ВОРы и РД по статусам/ }).click()
  await page.getByRole('button', { name: /^Все ВОРы и РД/ }).click()
  await page.waitForTimeout(200)
  return out
}

const collect = async (variant, server) => {
  const s = await openStand({ variant, page: 'vors', width: 1720, height: 900, server })
  const data = {}
  for (const [key, name] of [['construction', 'Основное строительство'], ['joint', 'Совместные тендеры']]) {
    await s.page.getByRole('tab', { name }).click()
    await s.page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 15000 })
    await s.page.waitForTimeout(400)
    data[key] = await snapshot(s.page)
  }
  const errors = s.errors.slice()
  await s.close()
  return { data, errors }
}

const server = await startServer()
const a = await collect('cur', server)
const b = await collect('new', server)
await server.close()

let fails = 0
for (const scope of ['construction', 'joint']) {
  for (const key of Object.keys(a.data[scope])) {
    const x = JSON.stringify(a.data[scope][key])
    const y = JSON.stringify(b.data[scope][key])
    const same = x === y
    if (!same) fails += 1
    console.log(`${same ? 'OK  ' : 'FAIL'} ${scope} / ${key}`)
    if (!same) {
      console.log(`     было:  ${x.slice(0, 300)}`)
      console.log(`     стало: ${y.slice(0, 300)}`)
    }
  }
}
console.log(`ошибок страницы: cur ${a.errors.length}, new ${b.errors.length}`)
if (b.errors.length) console.log('  ' + b.errors.slice(0, 3).join(' | '))
console.log(fails ? `\nРАСХОЖДЕНИЙ: ${fails}` : '\nСодержимое совпадает полностью')
process.exitCode = fails || b.errors.length ? 1 : 0
