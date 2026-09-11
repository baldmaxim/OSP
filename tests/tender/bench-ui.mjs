// Сравнение «до/после» на одном сценарии в браузере:
//   node tests/tender/bench-ui.mjs <каталог исходной версии> [позиций] [подрядчиков] [задержка мс]
// Исходную версию удобно взять из git: git worktree add --detach ../base <коммит>
// (и сделать ссылку на node_modules текущего репозитория).
import { chromium } from 'playwright'
import { startStand, runScenario, browserLaunchOptions, REPO } from './lib/stand.mjs'

const [baseRoot, items = '5000', cps = '10', latency = '120'] = process.argv.slice(2)
if (!baseRoot) {
  console.error('Укажите каталог исходной версии')
  process.exit(1)
}
const opts = { items: Number(items), cps: Number(cps), latency: Number(latency), stepTimeout: 90000, tolerant: true }

const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true })
const results = {}
try {
  for (const [label, root] of [['до', baseRoot], ['после', REPO]]) {
    const stand = await startStand(root)
    try {
      results[label] = await runScenario(browser, stand.url, opts)
    } finally {
      await stand.server.close()
    }
  }
} finally {
  await browser.close()
}

const rows = [
  ['Загрузка вкладки ВОР, мс', 'vorLoadMs'],
  ['Строк ВОР в DOM', 'vorDomRows'],
  ['Открытие «Сравнение КП», мс', 'compareLoadMs'],
  ['Строк сравнения в DOM', 'compareDomRows'],
  ['Запросов КП при открытии', 'compareRequests'],
  ['Отметка «учтено», мс', 'toggleMs'],
  ['Перезапросов КП после «учтено»', 'toggleProposalSelects'],
  ['Возврат на «Сравнение КП», мс', 'compareReturnMs'],
  ['Подвкладка «Материалы», мс', 'materialsMs'],
  ['Одновременных запросов (макс.)', 'maxParallelRequests'],
]
console.log(`\nТендер: ${opts.items} позиций × ${opts.cps} подрядчиков, задержка сети ${opts.latency} мс, dev-сборка\n`)
console.log('Показатель'.padEnd(36), 'До'.padStart(14), 'После'.padStart(14))
for (const [title, key] of rows) {
  const fmt = (m) => {
    if (m[key] != null) return String(m[key])
    if (m.stoppedAt) return `не дождались`
    return '—'
  }
  console.log(title.padEnd(36), fmt(results['до']).padStart(14), fmt(results['после']).padStart(14))
}
for (const [label, m] of Object.entries(results)) {
  if (m.stoppedAt) console.log(`\n${label}: сценарий остановлен на шаге «${m.stoppedAt}»: ${m.stopReason}`)
  if (m.errors?.length) console.log(`\n${label}: ошибки страницы: ${m.errors.join(' | ')}`)
}
