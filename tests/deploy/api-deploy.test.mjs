// Выкладка osp-api (deploy/api-deploy.sh) на временных каталогах: релизы, атомарное переключение,
// автоматический возврат, если новый релиз не ответил на /api/health, ручной --rollback, чистка.
// Служба — подделка: systemctl только записывает вызов, а «здоровье» отвечает по файлу HEALTH
// в текущем релизе. Нужны bash, git, npm, rsync, curl, flock.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'deploy', 'api-deploy.sh')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !['git', 'npm', 'rsync', 'curl', 'flock'].every(has) ? 'нужны bash, git, npm, rsync, curl, flock' : false

describe('Выкладка osp-api: релизы, проверка, возврат', { skip, timeout: 120000 }, () => {
  let tmp, project, apiRoot, health, env
  const restarts = []

  const current = () => path.basename(fs.readlinkSync(path.join(apiRoot, 'current')))
  const previous = () => (fs.existsSync(path.join(apiRoot, 'previous')) ? path.basename(fs.readlinkSync(path.join(apiRoot, 'previous'))) : null)
  const releases = () => fs.readdirSync(path.join(apiRoot, 'releases')).filter((n) => !n.startsWith('.')).sort()

  function commit(healthState) {
    fs.writeFileSync(path.join(project, 'server', 'osp-api', 'HEALTH'), healthState)
    spawnSync('git', ['-C', project, 'add', '-A'])
    spawnSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', healthState])
  }
  // Асинхронно: «здоровье» отвечает из этого же процесса, spawnSync заблокировал бы его.
  const deploy = (...args) => new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-api-deploy-'))
    project = path.join(tmp, 'project')
    apiRoot = path.join(tmp, 'osp-api')
    const srv = path.join(project, 'server', 'osp-api')
    fs.mkdirSync(path.join(srv, 'src'), { recursive: true })
    fs.writeFileSync(path.join(srv, 'package.json'), JSON.stringify({ name: 'osp-api-test', version: '1.0.0', private: true }))
    fs.writeFileSync(path.join(srv, 'src', 'server.js'), '// stub\n')
    assert.equal(spawnSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--prefix', srv]).status, 0)
    fs.mkdirSync(path.join(srv, 'node_modules', 'junk'), { recursive: true }) // не должно попасть в релиз
    spawnSync('git', ['init', '-q', project])

    // «Служба»: здорова, если в текущем релизе HEALTH = ok.
    health = http.createServer((req, res) => {
      let state = 'none'
      try { state = fs.readFileSync(path.join(apiRoot, 'current', 'HEALTH'), 'utf8').trim() } catch { /* нет релиза */ }
      res.writeHead(state === 'ok' ? 200 : 503)
      res.end(state)
    })
    await new Promise((r) => health.listen(0, '127.0.0.1', r))
    const fakeSystemctl = path.join(tmp, 'systemctl')
    fs.writeFileSync(fakeSystemctl, `#!/usr/bin/env bash\necho "$@" >> "${path.join(tmp, 'systemctl.log')}"\n`, { mode: 0o755 })
    env = {
      ...process.env, OSP_DEPLOY_TEST: '1', APP_USER: '', SKIP_PULL: '1', TMPDIR: tmp,
      PROJECT_DIR: project, API_ROOT: apiRoot, SYSTEMCTL: fakeSystemctl, NODE_BIN: process.execPath,
      HEALTH_URL: `http://127.0.0.1:${health.address().port}/api/health`, HEALTH_TRIES: '2', KEEP_RELEASES: '2',
    }
    restarts.push(() => fs.existsSync(path.join(tmp, 'systemctl.log')) ? fs.readFileSync(path.join(tmp, 'systemctl.log'), 'utf8').trim().split('\n').length : 0)
  })
  after(async () => {
    await new Promise((r) => health ? health.close(r) : r())
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('первый релиз: каталог с зависимостями по lock-файлу, current, без node_modules из исходников', async () => {
    commit('ok')
    const res = await deploy()
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const id = current()
    assert.match(id, /^\d{8}-\d{6}-\d{3}-[0-9a-f]{12}$/)
    assert.ok(fs.existsSync(path.join(apiRoot, 'releases', id, 'src', 'server.js')))
    assert.ok(!fs.existsSync(path.join(apiRoot, 'releases', id, 'node_modules', 'junk')), 'node_modules исходников не копируются')
    assert.equal(previous(), null)
    assert.match(res.stdout, /osp-api работает/)
  })

  it('второй релиз: current на новый, previous — на прежний', async () => {
    const first = current()
    commit('ok ')
    assert.equal((await deploy()).status, 0)
    assert.notEqual(current(), first)
    assert.equal(previous(), first)
  })

  it('новый релиз не ответил — автоматически назад на прежний', async () => {
    const good = current()
    const prev = previous()
    commit('bad')
    const res = await deploy()
    assert.equal(res.status, 1)
    assert.match(res.stdout, /Возвращён прежний релиз/)
    assert.equal(current(), good)
    assert.equal(previous(), prev, 'previous не меняется при неудаче')
  })

  it('--rollback: на предыдущий и обратно', async () => {
    const cur = current()
    const prev = previous()
    assert.equal((await deploy('--rollback')).status, 0)
    assert.equal(current(), prev)
    assert.equal(previous(), cur)
    assert.equal((await deploy('--rollback')).status, 0)
    assert.equal(current(), cur)
  })

  it('Node службы не годится — отказ до выкладки, current не меняется', async () => {
    const cur = current()
    const before = releases()
    commit('ok   ')
    const saved = env.NODE_BIN
    env.NODE_BIN = '/bin/false'
    try {
      const res = await deploy()
      assert.equal(res.status, 1)
      assert.match(res.stdout, /Нужен Node 20 или новее/)
    } finally {
      env.NODE_BIN = saved
    }
    assert.equal(current(), cur)
    assert.deepEqual(releases(), before, 'новый релиз не создавался')
  })

  it('чистка: хранятся KEEP_RELEASES последних, current и previous — всегда', async () => {
    commit('ok  ')
    assert.equal((await deploy()).status, 0)
    const kept = releases()
    assert.ok(kept.includes(current()) && kept.includes(previous()))
    assert.ok(kept.length <= 3, kept.join(', '))
    assert.ok(restarts[0]() >= 5, 'служба перезапускалась при каждом переключении')
  })
})
