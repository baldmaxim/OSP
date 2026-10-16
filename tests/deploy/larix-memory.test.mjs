// Загрузка из Larix по памяти — в контейнере с потолками osp-api из compose.yml (память без подкачки, ядра):
// подделка Larix в том же контейнере отдаёт потоком ответ «ВОР по договорам» больше настоящего (на 16.10 — 65 МБ)
// с кириллицей в длинных полях; разбор — тем же кодом, что у службы (larixClient.fetchBoq({ onRow }) +
// createBoqAccumulator). Проверяем: контейнер не убит по памяти, все позиции разобраны, пик памяти процесса —
// с запасом под сам API (разбор идёт внутри службы). Каталог службы — только на чтение.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const COMPOSE = fs.readFileSync(path.join(ROOT, 'deploy', 'docker', 'compose.yml'), 'utf8')
const dockerOk = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = dockerOk ? false : 'нужен Docker'

const apiBlock = COMPOSE.slice(COMPOSE.indexOf('  osp-api:'), COMPOSE.indexOf('  osp-postgrest:'))
const MEMORY = /mem_limit:\s*(\d+m)/.exec(apiBlock)[1]
const CPUS = /cpus:\s*([\d.]+)/.exec(apiBlock)[1]
const TARGET_MB = 100 // больше настоящего ответа (65 МБ)
// Пик процесса разбора (замер 16.10: ~215 МБ на 100 МБ ответа, из них ~63 — сам Node с подделкой); остальное из
// потолка — самому API. Прирост — не больше 1,8 размера ответа: разбор целиком (куски, склейка, строка, объекты)
// дал бы 3–4 размера.
const PEAK_LIMIT_MB = 260
const GROWTH_PER_MB = 1.8

const SCRIPT = `
import http from 'node:http'
const { createLarixClient } = await import('/app/src/lib/larixClient.js')
const { createBoqAccumulator } = await import('/app/src/lib/larixSync.js')
const TARGET = ${TARGET_MB} * 1024 * 1024
const word = (i) => ['Кладка', 'газобетона', 'D500', 'устройство', 'стяжки', 'армирование', 'монтаж', 'перегородок', 'облицовка', 'фасада'][i % 10]
const text = (i, n) => Array.from({ length: n }, (_, k) => word(i + k)).join(' ')
const item = (i) => JSON.stringify({
  project_id: 1000 + (i % 40), project_name: 'ЖК ' + text(i, 3), object_type: i % 3 ? 'Договор' : 'Доп. соглашение',
  contract_id: 5000 + (i % 900), contract_number: 'СУ10-' + (i % 900) + '/2026', contract_date: '2026-0' + (1 + (i % 9)) + '-15T21:00:00+00:00',
  contract_state: 'Подписан', contractor_id: 300 + (i % 120), contractor_short_name: 'ООО «' + text(i, 2) + '»',
  work_title: text(i, 40), measure_title: 'м2', materials_used: text(i + 3, 30), comment: text(i + 7, 20),
  quantity: (i % 97) + 0.5, price_material: (i % 500) * 13.37, price_work: (i % 300) * 21.5, vat_rate: 20,
})
let positions = 0
let sentBytes = 0
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/login') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ token: 'tok-memory-test-0123456789' })) }
  res.writeHead(200, { 'content-type': 'application/json' })
  const write = (s) => { sentBytes += Buffer.byteLength(s); return res.write(s) ? null : new Promise((r) => res.once('drain', r)) }
  await write('[')
  for (let i = 0; sentBytes < TARGET; i++) {
    const wait = write((i ? ',' : '') + item(i))
    positions++
    if (wait) await wait
  }
  res.end(']')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const client = createLarixClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, username: 'robot', password: 'secret-pass', dataTimeoutMs: 600000 })
let peak = 0
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss) }
const timer = setInterval(sample, 20)
const baseline = process.memoryUsage().rss
const acc = createBoqAccumulator()
const started = Date.now()
const { count, bytes } = await client.fetchBoq({ onRow: acc.add })
const { rows, skipped } = acc.result()
sample()
clearInterval(timer)
server.close()
console.log(JSON.stringify({ positions, count, valid: rows.length, skipped, mb: Math.round(bytes / 1048576),
  seconds: Math.round((Date.now() - started) / 1000), baselineMb: Math.round(baseline / 1048576), peakMb: Math.round(peak / 1048576) }))
`

describe('Larix: разбор ответа больше настоящего в контейнере с потолками API', { skip, timeout: 600000 }, () => {
  it(`~${TARGET_MB} МБ ответа: без нехватки памяти (${MEMORY}, ${CPUS} ядра), все позиции, пик < ${PEAK_LIMIT_MB} МБ`, () => {
    const res = spawnSync('docker', ['run', '--rm', '--memory', MEMORY, '--memory-swap', MEMORY, '--cpus', CPUS,
      '-v', `${SERVER}:/app:ro`, '-w', '/app', 'node:24-alpine', 'node', '--input-type=module', '-e', SCRIPT],
    { encoding: 'utf8', timeout: 540000 })
    assert.notEqual(res.status, 137, 'контейнер убит по памяти')
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const r = JSON.parse(res.stdout.trim().split('\n').at(-1))
    console.log(`  larix: ${JSON.stringify(r)}`)
    assert.ok(r.mb >= TARGET_MB, `ответ ${r.mb} МБ — не меньше ${TARGET_MB}`)
    assert.equal(r.count, r.positions, 'разобраны все позиции')
    assert.equal(r.valid, r.positions, 'все позиции прошли проверку')
    assert.ok(r.peakMb < PEAK_LIMIT_MB, `пик памяти ${r.peakMb} МБ — с запасом до потолка ${MEMORY}`)
    assert.ok(r.peakMb - r.baselineMb < GROWTH_PER_MB * r.mb, `прирост ${r.peakMb - r.baselineMb} МБ на ${r.mb} МБ ответа — разбор потоком`)
  })
})
