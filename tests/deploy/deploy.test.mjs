// Выкладка в каталоги-релизы и откат (deploy/publish.sh, deploy/rollback.sh) на
// временных каталогах вместо /var/www/osp. Нужны bash, rsync, find (GNU) — без них
// набор пропускается.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLISH = path.join(ROOT, 'deploy', 'publish.sh')
const ROLLBACK = path.join(ROOT, 'deploy', 'rollback.sh')

const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !has('rsync') || !has('find') ? 'нужны bash, rsync, find' : false

function makeDist(dir, { buildId, compat = 1, rollbackFloor = 1, assets }) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), `<html>${buildId}</html>`)
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ buildId, compat, rollbackFloor }))
  for (const name of assets) fs.writeFileSync(path.join(dir, 'assets', name), `/* ${name} */`)
  return dir
}

function sh(script, args, env = {}) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
}

describe('Деплой: каталоги-релизы и откат', { skip }, () => {
  let tmp
  let web
  const current = () => path.basename(fs.readlinkSync(path.join(web, 'current')))

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-deploy-'))
    web = path.join(tmp, 'www')
    fs.mkdirSync(web)
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('первая выкладка: релиз, current и общие хэш-файлы', () => {
    const dist = makeDist(path.join(tmp, 'd1'), { buildId: '1000', assets: ['index-a.js', 'App-a.js'] })
    const res = sh(PUBLISH, [dist, web])
    assert.equal(res.status, 0, res.stderr)
    assert.equal(current(), '1000')
    assert.ok(fs.existsSync(path.join(web, 'releases', '1000', 'index.html')))
    assert.ok(fs.existsSync(path.join(web, 'assets', 'App-a.js')))
    assert.ok(fs.existsSync(path.join(web, 'shared')))
  })

  it('вторая выкладка: файлы прошлой сборки остаются — открытые вкладки догрузят свои чанки', () => {
    const dist = makeDist(path.join(tmp, 'd2'), { buildId: '2000', assets: ['index-b.js', 'App-b.js'] })
    assert.equal(sh(PUBLISH, [dist, web]).status, 0)
    assert.equal(current(), '2000')
    for (const f of ['App-a.js', 'index-a.js', 'App-b.js']) assert.ok(fs.existsSync(path.join(web, 'assets', f)), f)
  })

  it('повтор той же выкладки безопасен', () => {
    const res = sh(PUBLISH, [path.join(tmp, 'd2'), web])
    assert.equal(res.status, 0, res.stderr)
    assert.equal(current(), '2000')
    assert.deepEqual(fs.readdirSync(path.join(web, 'releases')).sort(), ['1000', '2000'])
  })

  it('откат на предыдущий релиз и обратно', () => {
    let res = sh(ROLLBACK, [], { WEB_ROOT: web })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(current(), '1000')
    res = sh(ROLLBACK, ['2000'], { WEB_ROOT: web })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(current(), '2000')
  })

  it('граница отката: после релиза с rollbackFloor=2 откат на сборку с compat=1 запрещён', () => {
    const dist = makeDist(path.join(tmp, 'd3'), { buildId: '3000', compat: 2, rollbackFloor: 2, assets: ['App-c.js'] })
    assert.equal(sh(PUBLISH, [dist, web]).status, 0)
    const res = sh(ROLLBACK, [], { WEB_ROOT: web })
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /запрещён/)
    assert.equal(current(), '3000')
  })

  it('чистка: хранятся KEEP_RELEASES релизов; старые ничейные хэш-файлы удаляются, нужные — нет', () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    for (const f of ['App-a.js', 'index-a.js', 'App-b.js']) fs.utimesSync(path.join(web, 'assets', f), old, old)
    const dist = makeDist(path.join(tmp, 'd4'), { buildId: '4000', compat: 2, rollbackFloor: 2, assets: ['App-d.js'] })
    const res = sh(PUBLISH, [dist, web], { KEEP_RELEASES: '2' })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(fs.readdirSync(path.join(web, 'releases')).sort(), ['3000', '4000'])
    assert.ok(!fs.existsSync(path.join(web, 'assets', 'App-a.js')), 'файл удалённого релиза старше срока — удалён')
    assert.ok(fs.existsSync(path.join(web, 'assets', 'App-c.js')), 'файл хранимого релиза остаётся')
    assert.ok(fs.existsSync(path.join(web, 'assets', 'App-d.js')))
  })

  it('недописанная сборка не выкладывается', () => {
    const broken = path.join(tmp, 'broken')
    fs.mkdirSync(broken)
    const res = sh(PUBLISH, [broken, web])
    assert.notEqual(res.status, 0)
    assert.equal(current(), '4000')
  })
})
