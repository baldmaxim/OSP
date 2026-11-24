// deploy/docker/deploy.sh signal …: ручные команды SIGNAL (server/osp-api/src/signal-cli.js) в образе выложенного выпуска.
// Docker не нужен: настоящий deploy.sh работает на временном каталоге портала, а `docker` — записывающая заглушка. Проверяем:
//   • допускаются только probe | sync | accept-held, остальное — отказ до обращения к Docker;
//   • команда идёт тем же способом, что у larix (compose -p osp … run --rm --no-deps -T osp-api node src/signal-cli.js …),
//     аргументы accept-held (включая причину с пробелами) передаются без изменений;
//   • код выхода CLI (0 / 3 / 4) возвращается как есть;
//   • нет выложенного выпуска — отказ; в справке (без команды) команда перечислена.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'deploy', 'docker', 'deploy.sh')
const skip = process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v flock sha256sum'], { stdio: 'ignore' }).status !== 0
  ? 'нужны bash, flock, sha256sum' : false

const TAG = 'aaaaaaaaaaaa'
// Каждый аргумент — отдельной строкой «ARG <значение>», перед ними строка «CALL»; код выхода для `run` — из FAKE_RC.
const FAKE_DOCKER = `#!/usr/bin/env bash
if [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi
{ echo CALL; for a in "$@"; do printf 'ARG %s\\n' "$a"; done; } >> "$LOG"
for a in "$@"; do if [ "$a" = run ]; then exit "\${FAKE_RC:-0}"; fi; done
exit 0
`

describe('deploy.sh signal: ручные команды SIGNAL в образе выпуска', { skip }, () => {
  let tmp, home, bin, log

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-deploy-signal-'))
    bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
    log = path.join(tmp, 'docker.log')
    home = path.join(tmp, 'osp')
    const rel = path.join(home, 'releases', TAG)
    fs.mkdirSync(rel, { recursive: true })
    fs.writeFileSync(path.join(rel, 'compose.yml'), 'services: {}\n')
    fs.writeFileSync(path.join(rel, 'release.env'), `OSP_TAG=${TAG}\n`)
    fs.writeFileSync(path.join(home, 'server.env'), 'OSP_PROXY_NETWORK=proxy\n')
  })
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const link = (on) => {
    const current = path.join(home, 'current')
    fs.rmSync(current, { force: true })
    if (on) fs.symlinkSync(`releases/${TAG}`, current)
  }
  const deploy = (args, { rc = 0 } = {}) => {
    fs.writeFileSync(log, '')
    const res = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, OSP_HOME: home, OSP_PROJECT: 'osp', LOG: log, FAKE_RC: String(rc) },
    })
    const calls = []
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (line === 'CALL') calls.push([])
      else if (line.startsWith('ARG ')) calls.at(-1).push(line.slice(4))
    }
    return { ...res, calls }
  }
  const tail = (call) => call.slice(call.indexOf('run'))

  it('probe, sync и accept-held: тот же запуск, что у larix, — run --rm --no-deps -T osp-api node src/signal-cli.js <аргументы как есть>', () => {
    link(true)
    const reason = 'проверено вручную: сеть была недоступна'
    for (const args of [['probe'], ['sync'], ['accept-held', '--run', '12', '--expected-generation', '7', '--reason', reason]]) {
      const res = deploy(['signal', ...args])
      assert.equal(res.status, 0, res.stderr)
      assert.equal(res.calls.length, 1, 'один вызов docker')
      const [call] = res.calls
      assert.deepEqual(call.slice(0, 3), ['compose', '-p', 'osp'])
      assert.ok(call.includes(path.join(home, 'releases', TAG, 'compose.yml')), 'compose выложенного выпуска')
      assert.deepEqual(tail(call), ['run', '--rm', '--no-deps', '-T', 'osp-api', 'node', 'src/signal-cli.js', ...args])
    }
    // образец: larix идёт тем же способом
    const larix = deploy(['larix', 'probe'])
    assert.deepEqual(tail(larix.calls[0]).slice(0, 6), ['run', '--rm', '--no-deps', '-T', 'osp-api', 'node'])
  })

  it('код выхода CLI возвращается как есть: 0 — готово, 3 — отложено защитой, 4 — сбой', () => {
    link(true)
    for (const rc of [0, 3, 4]) assert.equal(deploy(['signal', 'sync'], { rc }).status, rc)
  })

  it('без команды и с чужой командой — отказ до обращения к Docker', () => {
    link(true)
    for (const args of [['signal'], ['signal', 'nope'], ['signal', '--run', '1'], ['signal', 'identity']]) {
      const res = deploy(args)
      assert.equal(res.status, 1, args.join(' '))
      assert.match(res.stderr, /FAIL укажите команду: bash deploy\.sh signal probe \| sync \| accept-held --run <id> --expected-generation <n> --reason/)
      assert.deepEqual(res.calls, [], 'Docker не вызывался')
    }
  })

  it('выпуск не выложен — отказ, Docker не вызывался', () => {
    link(false)
    const res = deploy(['signal', 'probe'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /FAIL портал не выложен/)
    assert.deepEqual(res.calls, [])
  })

  it('справка (без команды) перечисляет signal; шапка скрипта описывает все три команды', () => {
    const res = deploy([])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /larix probe\|sync \| signal probe\|sync\|accept-held \| identity/)
    const head = fs.readFileSync(SCRIPT, 'utf8').split('\n').slice(0, 14).join('\n')
    assert.match(head, /bash deploy\.sh signal probe \| sync \| accept-held --run <id> --expected-generation <n> --reason/)
  })
})
