// Нагрузка входа в контейнере с потолками osp-api из compose.yml (память 384 МБ без подкачки, 0,45 ядра):
// 20 одновременных проверок пароля (scrypt 32 МиБ + bcrypt на каждую) — служба не падает по памяти, очередь
// ограничена: сверх неё — отказ «повторите» (OSP_AUTH_BUSY), а не рост памяти; время записывается.
// Код проверки — тот же, что у службы (server/osp-api/src/lib/auth/passwords.js), каталог — только на чтение.
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
const depsOk = fs.existsSync(path.join(SERVER, 'node_modules', 'bcryptjs'))
const skip = !dockerOk ? 'нужен Docker' : depsOk ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

// Потолки службы API — из compose.yml, чтобы тест не разошёлся с выкладкой.
const apiBlock = COMPOSE.slice(COMPOSE.indexOf('  osp-api:'), COMPOSE.indexOf('  osp-postgrest:'))
const MEMORY = /mem_limit:\s*(\d+m)/.exec(apiBlock)[1]
const CPUS = /cpus:\s*([\d.]+)/.exec(apiBlock)[1]

const SCRIPT = `
const { createPasswordVerifier, hashPassword } = await import('/app/src/lib/auth/passwords.js')
const bcrypt = (await import('/app/node_modules/bcryptjs/index.js')).default
const v = createPasswordVerifier()
await v.warmUp()
const own = await hashPassword('нагрузка своего входа')
const legacy = await bcrypt.hash('legacy-password-1', 10)
const started = Date.now()
const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => {
  const t = Date.now()
  return v.verify(i % 2 ? 'нагрузка своего входа' : 'legacy-password-1', i % 2 ? own : legacy).then((r) => ({ ok: r.ok, ms: Date.now() - t }))
}))
const done = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
const busy = results.filter((r) => r.status === 'rejected' && r.reason?.code === 'OSP_AUTH_BUSY').length
const other = results.length - done.length - busy
const ms = done.map((d) => d.ms).sort((a, b) => a - b)
console.log(JSON.stringify({ done: done.length, okAll: done.every((d) => d.ok), busy, other, totalMs: Date.now() - started,
  p50: ms[Math.floor(ms.length / 2)] ?? null, max: ms.at(-1) ?? null, rssMb: Math.round(process.memoryUsage().rss / 1048576) }))
`

describe('свой вход: нагрузка проверки пароля в контейнере с потолками API', { skip, timeout: 300000 }, () => {
  it(`20 одновременных проверок: без нехватки памяти (${MEMORY}, ${CPUS} ядра), сверх очереди — «повторите»`, () => {
    const res = spawnSync('docker', ['run', '--rm', '--memory', MEMORY, '--memory-swap', MEMORY, '--cpus', CPUS,
      '-v', `${SERVER}:/app:ro`, '-w', '/app', 'node:24-alpine', 'node', '--input-type=module', '-e', SCRIPT],
    { encoding: 'utf8', timeout: 240000 })
    assert.notEqual(res.status, 137, 'контейнер убит по памяти')
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const r = JSON.parse(res.stdout.trim().split('\n').at(-1))
    console.log(`  нагрузка: ${JSON.stringify(r)}`)
    assert.equal(r.other, 0, 'других ошибок, кроме «занято», нет')
    assert.equal(r.done + r.busy, 20)
    assert.ok(r.done >= 4, 'хотя бы первые проверки прошли')
    assert.equal(r.okAll, true, 'прошедшие проверки — верные')
    assert.ok(r.rssMb < Number.parseInt(MEMORY, 10) * 0.8, `память процесса ${r.rssMb} МБ — с запасом до потолка`)
  })
})
