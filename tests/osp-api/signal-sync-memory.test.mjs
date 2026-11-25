// Память обхода SIGNAL (С-39) — в контейнере с потолками osp-api из compose.yml (память без подкачки, ядра), по образцу
// tests/deploy/larix-memory.test.mjs: подделка SIGNAL внутри контейнера отдаёт дерево проекта почти предельного размера
// (30 000 папок) и список в 15 000 элементов одной папки (75 страниц по 200, каждая — запрос к подделке; затем сверка
// первой страницы), разбор и запись в базу-заглушку — тем же кодом, что у службы (signalClient → signalApi → signalSync).
// Проверяем: контейнер не убит по памяти, все строки дошли до staging, пик памяти процесса — с запасом под сам API
// (холостой API занимает ~100 МБ из потолка). Название, путь и идентификаторы — синтетика; каталог службы — только на чтение.
// Нет Docker или образа node:24-alpine — тест пропускается («пропущено», а не «прошло»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const COMPOSE = fs.readFileSync(path.join(ROOT, 'deploy', 'docker', 'compose.yml'), 'utf8')
const IMAGE = 'node:24-alpine'
const docker = (args) => spawnSync('docker', args, { stdio: 'ignore', timeout: 30_000 }).status === 0
const skip = !docker(['version']) ? 'нужен Docker' : !docker(['image', 'inspect', IMAGE]) ? `нет образа ${IMAGE} (docker pull не выполняется тестом)` : false

const apiBlock = COMPOSE.slice(COMPOSE.indexOf('  osp-api:'), COMPOSE.indexOf('  osp-postgrest:'))
const MEMORY = /mem_limit:\s*(\d+m)/.exec(apiBlock)[1]
const CPUS = /cpus:\s*([\d.]+)/.exec(apiBlock)[1]
const FOLDERS = 30_000
const BIG_ITEMS = 15_000
const SMALL_FOLDERS = 1_000 // папки по 2 элемента
// Потолок контейнера 384 МБ; холостой API ~103 МБ; остаётся ~250 МБ на обход (замер ревизии: 50 000 папок — пик 250 МБ вместе с
// самим процессом замера). Пик процесса обхода — не больше 260 МБ.
const PEAK_LIMIT_MB = 260

const SCRIPT = `
const { createSignalClient } = await import('/app/src/lib/signalClient.js')
const { createSignalApi } = await import('/app/src/lib/signalApi.js')
const { createSignalSync } = await import('/app/src/lib/signalSync.js')
const FOLDERS = ${FOLDERS}, BIG_ITEMS = ${BIG_ITEMS}, SMALL_FOLDERS = ${SMALL_FOLDERS}
const hex = (n, w) => Number(n).toString(16).padStart(w, '0')
const id = (kind, n) => hex(kind, 8) + '-0000-4000-8000-' + hex(n, 12)
const PROJECT = id(1, 1)
const ROOT_ID = id(2, 1)

// Дерево: корень → корпуса → разделы → папки договоров, всего FOLDERS папок; первая листовая — «большая», 1000 следующих — «малые».
let next = 1
const mk = (name) => ({ id: id(2, next++), name, modified: '2026-11-20T10:00:00Z', type: 'Regular', children: [] })
const root = mk('Документы проекта Альфа (договоры подряда и субподряда)')
const corp = []
for (let i = 0; next <= FOLDERS && i < 20; i++) { const c = mk('Корпус ' + (i + 1)); root.children.push(c); corp.push(c) }
const sect = []
for (const c of corp) for (let j = 0; next <= FOLDERS && j < 20; j++) { const s = mk('Раздел ' + (j + 1) + ' — договоры подряда'); c.children.push(s); sect.push(s) }
const leaves = []
let k = 0
while (next <= FOLDERS) { const f = mk('ДП АЛИЯ-ДП-26-' + String(next).padStart(5, '0') + ' ООО Ромашка-Строй'); sect[k++ % sect.length].children.push(f); leaves.push(f) }
const treeBody = Buffer.from(JSON.stringify(root))
const BIG = leaves[0].id
const SMALL = new Set(leaves.slice(1, 1 + SMALL_FOLDERS).map((f) => f.id))
const countOf = (folderId) => (folderId === BIG ? BIG_ITEMS : SMALL.has(folderId) ? 2 : 0)

let itemRequests = 0
const stubFetch = async (url) => {
  const u = new URL(url)
  if (u.pathname.endsWith('/auth/token')) return new Response(JSON.stringify({ token: 'tok-1234567890', expiresIn: 3600 }), { status: 200 })
  if (u.pathname.endsWith('/folders/tree')) {
    return new Response(new ReadableStream({
      start(c) { for (let i = 0; i < treeBody.length; i += 65536) c.enqueue(new Uint8Array(treeBody.subarray(i, i + 65536))); c.close() },
    }), { status: 200 })
  }
  if (u.pathname.endsWith('/items')) {
    itemRequests++
    const folderId = u.searchParams.get('folderId')
    const skip = Number(u.searchParams.get('Skip')), take = Number(u.searchParams.get('Take'))
    const total = countOf(folderId)
    const page = []
    for (let i = skip; i < Math.min(total, skip + take); i++) {
      page.push({ id: id(3, (folderId === BIG ? 1_000_000 : 5_000_000 + (parseInt(folderId.slice(-6), 16) * 10)) + i), folderId, name: 'Акт ' + (i + 1) + ' Кладка газобетона.pdf', type: 'File',
        modified: '2026-11-20T10:00:00Z', added: '2026-11-20T10:00:00Z', deleted: false, topVersionNumber: 1 })
    }
    return new Response(JSON.stringify(page), { status: 200 })
  }
  return new Response('{}', { status: 404 })
}

const api = createSignalApi({ client: createSignalClient({ baseUrl: 'https://api.sgnl.pro', clientId: 'id-test', clientSecret: 'secret-test', fetch: stubFetch }) })
let staged = 0
let finishRoots = null
const fnOf = (sql) => /osp_private\\.(\\w+)\\(/.exec(sql)?.[1]
const tx = {
  async query(sql, params) {
    const f = fnOf(sql)
    if (f === 'signal_sources_for_sync') return { rows: [{ r: { mode: 'full', codes: ['АЛИЯ', 'ПРИМ'], sources: [{ id: 1, projectId: PROJECT, folderId: ROOT_ID, linkedItems: [] }] } }] }
    if (f === 'signal_sync_begin') return { rows: [{ r: { runId: 1, ownerToken: '00000003-0000-4000-8000-000000000001' } }] }
    if (f === 'signal_stage_put') { const rows = JSON.parse(params[2]); staged += rows.length; return { rows: [{ r: rows.length }] } }
    if (f === 'signal_sync_heartbeat') return { rows: [{ r: true }] }
    if (f === 'signal_sync_finish') { finishRoots = JSON.parse(params[2]).roots; return { rows: [{ r: { status: 'ok', generation: 1, reason: null } }] } }
    return { rows: [{ r: null }] }
  },
}
const db = { read: async (_w, fn) => fn(tx), write: async (_w, fn) => fn(tx) }

let peak = 0
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 20)
const sync = createSignalSync({ db, api, isReadOnly: () => false, config: { firstDelayMs: 0 } })
const started = Date.now()
const run = await sync.runNow({ initiator: 'cli' })
const res = run.done ? await run.done : run
clearInterval(timer)
const ru = process.resourceUsage()
console.log(JSON.stringify({
  status: res.status, reason: res.reason ?? null, staged, items: finishRoots?.[0]?.items ?? null, folders: finishRoots?.[0]?.folders ?? null,
  rootStatus: finishRoots?.[0]?.status ?? null, itemRequests,
  peakMb: Math.round(Math.max(peak, ru.maxRSS * 1024) / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576), sec: +((Date.now() - started) / 1000).toFixed(1),
}))
`

describe('SIGNAL: обход большого дерева в контейнере с потолками API (С-39)', { skip, timeout: 600_000 }, () => {
  it(`${FOLDERS} папок и папка в ${BIG_ITEMS} элементов: без нехватки памяти (${MEMORY}, ${CPUS} ядра), все строки в staging, пик < ${PEAK_LIMIT_MB} МБ`, () => {
    const res = spawnSync('docker', ['run', '--rm', '--memory', MEMORY, '--memory-swap', MEMORY, '--cpus', CPUS,
      '-v', `${SERVER}:/app:ro`, '-w', '/app', IMAGE, 'node', '--input-type=module', '-e', SCRIPT],
    { encoding: 'utf8', timeout: 540_000 })
    assert.notEqual(res.status, 137, 'контейнер убит по памяти')
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const r = JSON.parse(res.stdout.trim().split('\n').at(-1))
    console.log(`  signal-sync memory: ${JSON.stringify(r)}`)
    assert.equal(r.status, 'ok', JSON.stringify(r))
    assert.equal(r.rootStatus, 'ok')
    assert.equal(r.folders, FOLDERS)
    assert.equal(r.items, BIG_ITEMS + SMALL_FOLDERS * 2)
    assert.equal(r.staged, FOLDERS + BIG_ITEMS + SMALL_FOLDERS * 2, 'каждая строка записана один раз')
    // 75 страниц большой папки + пустая + сверка первой; малые папки — по две страницы (элементы и пустая); прочие — пустая страница
    assert.ok(r.itemRequests > FOLDERS, `запросов элементов ${r.itemRequests}`)
    assert.ok(r.peakMb < PEAK_LIMIT_MB, `пик памяти ${r.peakMb} МБ — с запасом до потолка ${MEMORY}`)
  })
})
