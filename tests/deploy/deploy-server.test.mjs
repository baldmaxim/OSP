// scripts/deploy-server.sh — выкладка нового портала на общем сервере одной командой. Проверяем обещанное
// владельцу портала, не трогая Docker: настоящий скрипт работает на временном «сервере», где docker,
// сборка выпуска (build.sh), выкладка (deploy.sh) и снимок соседей (neighbors.sh) — записывающие заглушки:
//   • запуск не из клона в каталоге портала — отказ; мало памяти или диска — отказ до сборки;
//   • both: git sync → свой сборщик с потолком памяти и одним ядром → сборка без архива образов →
//     сборщик остановлен → снимок соседей → выкладка → сравнение соседей;
//   • backend / frontend: собирается один образ, второй — из выложенного выпуска;
//   • сборка не удалась — сборщик всё равно остановлен, выкладки нет;
//   • migrate: сначала только чтение; новых нет — ничего не пишется; есть — без терминала нужен --yes;
//     после — PostgREST перечитывает структуру; клон и подключение к базе — только на чтение;
//   • скрипт обновился в репозитории — выкладка продолжается новой версией;
//   • buildx — свой, из каталога портала (DOCKER_CONFIG только у команд сборки): ставится из заранее
//     положенного файла или скачиванием, всегда со сверкой суммы; compose его не видит;
//   • в скрипте нет общих команд Docker (prune всего, остановка чужого).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-server.sh')
const skip = process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v git flock'], { stdio: 'ignore' }).status !== 0
  ? 'нужны bash, git, flock' : false

// buildx есть только как свой плагин в каталоге портала (DOCKER_CONFIG) — как на сервере corp, где его нет в системе.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$LOG"
if [ "$1" = buildx ] && [ ! -x "\${DOCKER_CONFIG:-/nonexistent}/cli-plugins/docker-buildx" ]; then echo "docker: 'buildx' is not a docker command." >&2; exit 1; fi
if [ "$1" = compose ] && [ -n "\${DOCKER_CONFIG:-}" ]; then echo "COMPOSE-WITH-PRIVATE-CONFIG" >> "$LOG"; fi
case "$1 $2" in
  "compose version"|"buildx version") exit 0 ;;
  "buildx inspect") [ -f "$STATE/builder" ] || exit 1; echo "Driver Options: $(cat "$STATE/builder")"; exit 0 ;;
  "buildx create") for a in "$@"; do case "$a" in image=*) echo "$a" | sed -E 's/([a-z-]+)=([^,]*)(,|$)/\\1="\\2" /g' > "$STATE/builder" ;; esac; done; exit 0 ;;
  "buildx rm") rm -f "$STATE/builder"; exit 0 ;;
  "buildx build") for a in "$@"; do case "$a" in osp-tools:*) touch "$STATE/tools" ;; esac; done; exit 0 ;;
  "image inspect") case "$3" in osp-tools:*) [ -f "$STATE/tools" ]; exit ;; esac; exit 0 ;;
  "info --format") echo "$STATE"; exit 0 ;;
  "run --rm")
    for a in "$@"; do
      case "$a" in
        --dry-run) printf '%b\\n' "\${FAKE_DRY:-ИТОГ: новых миграций нет — база не менялась.}"; exit 0 ;;
        --yes) echo "OK 20990101_x: применена"; exit "\${FAKE_MIGRATE_RC:-0}" ;;
      esac
    done ;;
esac
exit 0
`
// Сборка выпуска: записывает аргументы и сборщик, кладёт каталог выпуска с заглушками выкладки.
const FAKE_BUILD = `#!/usr/bin/env bash
echo "build.sh $* OSP_BUILDER=\${OSP_BUILDER:-} WEB_ENV=\${OSP_WEB_BUILD_ENV:-}" >> "$LOG"
[ "\${FAKE_BUILD_RC:-0}" = 0 ] || exit "$FAKE_BUILD_RC"
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
out=""; while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done
rel="$out/osp-release-$(git -C "$here/../.." rev-parse --short=12 HEAD)"
mkdir -p "$rel"; echo "tag=x" > "$rel/MANIFEST"; cp "$here/deploy.sh" "$here/neighbors.sh" "$rel/"
`
const FAKE_DEPLOY = `#!/usr/bin/env bash
echo "deploy.sh $*" >> "$LOG"
[ "$1" != install ] || exit "\${FAKE_INSTALL_RC:-0}"
`
const FAKE_NEIGHBORS = `#!/usr/bin/env bash
echo "neighbors.sh $*" >> "$LOG"
`
const BUILDX_BODY = '#!/bin/sh\necho fake buildx\n'
const BUILDX_SHA = crypto.createHash('sha256').update(BUILDX_BODY).digest('hex')
const BUILDKIT = 'moby/buildkit:v0.0.0@sha256:' + 'b'.repeat(64)
const PIN = `BUILDX_VERSION=v0.0.0-test\nBUILDX_SHA256_AMD64=${BUILDX_SHA}\nBUILDX_SHA256_ARM64=${BUILDX_SHA}\nBUILDKIT_IMAGE=${BUILDKIT}\n`
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'

describe('deploy-server.sh: выкладка на общем сервере — свой сборщик с потолком, соседи, миграции', { skip, timeout: 120000 }, () => {
  let tmp, origin, home, bin, state, log, meminfo
  const placed = () => path.join(home, 'docker', `buildx-v0.0.0-test.linux-${ARCH}`)
  const plugin = () => path.join(home, 'docker', 'cli-plugins', 'docker-buildx')
  const git = (cwd, ...args) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }
  const setMem = (mb) => fs.writeFileSync(meminfo, `MemTotal: 4000000 kB\nMemAvailable: ${mb * 1024} kB\n`)
  const run = (args, env = {}, script = path.join(home, 'src', 'scripts', 'deploy-server.sh')) => {
    fs.writeFileSync(log, '')
    const res = spawnSync('bash', [script, ...args], { encoding: 'utf8', input: '', timeout: 60000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OSP_HOME: home, LOG: log, STATE: state, OSP_MEMINFO: meminfo, OSP_MIN_DISK_GB: '0', ...env } })
    return { ...res, all: res.stdout + res.stderr, log: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
  }
  const order = (lines, ...patterns) => {
    let at = -1
    for (const p of patterns) {
      const i = lines.findIndex((l, n) => n > at && p.test(l))
      assert.ok(i > at, `в журнале нет ${p} после строки ${at}:\n${lines.join('\n')}`)
      at = i
    }
  }
  // Новый коммит в «GitHub»: файл в репозитории и, по желанию, правка самого скрипта.
  const pushChange = (file, text) => {
    const work = path.join(tmp, 'work')
    if (!fs.existsSync(work)) git(tmp, 'clone', '-q', origin, work)
    git(work, 'pull', '-q')
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    fs.writeFileSync(path.join(work, file), text)
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', `change ${file}`); git(work, 'push', '-q', 'origin', 'HEAD:main')
    return git(work, 'rev-parse', '--short=12', 'HEAD')
  }

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-deploy-server-')))
    origin = path.join(tmp, 'origin.git')
    home = path.join(tmp, 'portal')
    bin = path.join(tmp, 'bin')
    state = path.join(tmp, 'state')
    log = path.join(tmp, 'log.txt')
    meminfo = path.join(tmp, 'meminfo')
    for (const d of [bin, state, home]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
    setMem(4000)

    // Репозиторий: настоящий скрипт выкладки и заглушки того, что он вызывает.
    const seed = path.join(tmp, 'seed')
    for (const [f, text] of [
      ['scripts/deploy-server.sh', fs.readFileSync(SCRIPT, 'utf8')],
      ['deploy/docker/build.sh', FAKE_BUILD], ['deploy/docker/deploy.sh', FAKE_DEPLOY], ['deploy/docker/neighbors.sh', FAKE_NEIGHBORS],
      ['deploy/docker/tools.Dockerfile', 'FROM scratch\n'], ['deploy/docker/buildx.pin', PIN], ['migration/yandex/README.md', 'миграции\n'],
    ]) {
      fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true })
      fs.writeFileSync(path.join(seed, f), text)
    }
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'init')
    git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', 'origin', 'main')
    git(tmp, 'clone', '-q', origin, path.join(home, 'src'))

    // Каталог портала, как после первой установки (deploy/docker/README.md).
    fs.writeFileSync(path.join(home, 'server.env'), 'OSP_PROXY_NETWORK=edge\n')
    fs.mkdirSync(path.join(home, 'secrets', 'db'), { recursive: true })
    fs.writeFileSync(path.join(home, 'secrets', 'web-build.env'), 'VITE_SUPABASE_URL=x\nVITE_SUPABASE_ANON_KEY=y\n', { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'secrets', 'db', 'target.env'), 'PGHOST=db\nPGPASSWORD=SECRET-DB-PASS\n', { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'secrets', 'db', 'target.env.pin'), 'a'.repeat(64) + '\n')
    fs.writeFileSync(path.join(home, 'secrets', 'db', 'root.crt'), 'cert\n')
    fs.mkdirSync(path.join(home, 'releases', 'aaaaaaaaaaaa'), { recursive: true })
    fs.writeFileSync(path.join(home, 'releases', 'aaaaaaaaaaaa', 'release.env'), 'OSP_API_IMAGE=osp-api:aaaaaaaaaaaa\nOSP_WEB_IMAGE=osp-web:aaaaaaaaaaaa\n')
    fs.symlinkSync('releases/aaaaaaaaaaaa', path.join(home, 'current'))
    fs.writeFileSync(path.join(home, 'deploy.sh'), FAKE_DEPLOY)
  })
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

  it('запуск не из клона в каталоге портала — отказ; без режима — подсказка', () => {
    const elsewhere = path.join(tmp, 'elsewhere', 'scripts')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.copyFileSync(SCRIPT, path.join(elsewhere, 'deploy-server.sh'))
    const res = run(['both'], {}, path.join(elsewhere, 'deploy-server.sh'))
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /скрипт запущен не из клона/)
    assert.equal(res.log.length, 0, 'ничего не вызывалось')
    const bare = run([])
    assert.equal(bare.status, 1)
    assert.match(bare.all, /migrate \[--yes\]/)
  })

  it('мало памяти или диска — отказ до сборки, сборщик не создаётся', () => {
    setMem(1500)
    let res = run(['both'])
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /мало свободной памяти: 1500 МБ, для сборки нужно 1792 МБ — сейчас она нужна соседним порталам/)
    assert.ok(!res.log.some((l) => /buildx (create|build)|build\.sh/.test(l)), res.log.join('\n'))
    setMem(4000)
    res = run(['both'], { OSP_MIN_DISK_GB: '1000000' })
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /мало места на диске Docker/)
    assert.ok(!res.log.some((l) => /buildx (create|build)|build\.sh/.test(l)))
  })

  it('свой buildx: файл с неверной суммой — отказ до сборки, ничего не установлено', () => {
    fs.mkdirSync(path.dirname(placed()), { recursive: true })
    fs.writeFileSync(placed(), 'подменённый файл\n')
    const res = run(['both'])
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /контрольная сумма buildx не совпала с buildx\.pin — файл удалён, ничего не установлено/)
    assert.ok(!fs.existsSync(plugin()), 'плагин не установлен')
    assert.ok(!res.log.some((l) => /buildx (create|build)|build\.sh/.test(l)), res.log.join('\n'))
    fs.writeFileSync(placed(), BUILDX_BODY) // дальше — правильный файл, положенный заранее
  })

  it('both: git sync → свой сборщик с потолком → сборка без архива → сборщик остановлен → соседи → выкладка', () => {
    const head = pushChange('src/app.txt', 'новая версия\n')
    const res = run(['both'])
    assert.equal(res.status, 0, res.all)
    assert.equal(git(path.join(home, 'src'), 'rev-parse', '--short=12', 'HEAD'), head, 'клон на новом коммите')
    const cpu = String(os.cpus().length - 1)
    order(res.log,
      new RegExp(`^docker buildx create --name osp-builder --driver docker-container --driver-opt image=${BUILDKIT.replace(/[.]/g, '\\.')},memory=1280m,memory-swap=1280m,cpuset-cpus=${cpu},cpu-shares=256,default-load=true$`),
      new RegExp(`^build\\.sh --out ${home}/build-out --no-save OSP_BUILDER=osp-builder WEB_ENV=${home}/secrets/web-build.env$`),
      /^docker buildx prune --builder osp-builder --force --max-used-space 3gb$/,
      /^docker buildx stop osp-builder$/,
      /^neighbors\.sh --save$/,
      new RegExp(`^deploy\\.sh install ${home}/build-out/osp-release-${head}$`),
      /^neighbors\.sh --compare$/)
    assert.match(res.all, new RegExp(`готово — выпуск ${head}`))
    assert.match(res.all, /свой buildx v0\.0\.0-test — из заранее положенного файла/)
    assert.equal(fs.readFileSync(plugin(), 'utf8'), BUILDX_BODY, 'свой buildx установлен в каталог портала')
    assert.ok(!res.log.includes('COMPOSE-WITH-PRIVATE-CONFIG'), 'compose работает без своего DOCKER_CONFIG')
    // Сборщик уже есть с тем же потолком — не пересоздаётся; потолок сменили — пересоздаётся свой.
    let again = run(['both'])
    assert.ok(!again.log.some((l) => /buildx (create|rm)/.test(l)), again.log.join('\n'))
    again = run(['both'], { OSP_BUILD_MEMORY: '1g' })
    assert.equal(again.status, 0, again.all)
    order(again.log, /^docker buildx rm osp-builder$/, /^docker buildx create --name osp-builder .*memory=1g,memory-swap=1g,/)
  })

  it('своего buildx нет и файл не положен — скачивается (сумма сверяется); с сервера скачать не вышло — понятный отказ', () => {
    const src = path.join(tmp, 'buildx-download')
    fs.writeFileSync(src, BUILDX_BODY)
    fs.rmSync(plugin()); fs.rmSync(placed())
    let res = run(['both'], { OSP_BUILDX_URL: `file://${src}` })
    assert.equal(res.status, 0, res.all)
    assert.match(res.all, /скачиваю свой buildx v0\.0\.0-test/)
    assert.equal(fs.readFileSync(plugin(), 'utf8'), BUILDX_BODY)
    fs.rmSync(plugin())
    res = run(['both'], { OSP_BUILDX_URL: `file://${path.join(tmp, 'нет-такого-файла')}` })
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /buildx не скачан — положите файл .*buildx-v0\.0\.0-test\.linux-/)
    fs.writeFileSync(placed(), BUILDX_BODY)
  })

  it('backend / frontend: собирается один образ, второй — из выложенного выпуска', () => {
    for (const [mode, only] of [['backend', 'api'], ['frontend', 'web']]) {
      const res = run([mode])
      assert.equal(res.status, 0, res.all)
      assert.ok(res.log.some((l) => l.startsWith(`build.sh --out ${home}/build-out --no-save --only ${only} --reuse ${home}/current/release.env `)), res.log.join('\n'))
    }
  })

  it('сборка не удалась — сборщик всё равно остановлен, выкладки и снимка соседей нет', () => {
    const res = run(['both'], { FAKE_BUILD_RC: '2' })
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /сборка не удалась \(код 2\) — на сервере ничего не изменилось/)
    order(res.log, /^build\.sh /, /^docker buildx stop osp-builder$/)
    assert.ok(!res.log.some((l) => /^deploy\.sh install|^neighbors\.sh/.test(l)), res.log.join('\n'))
  })

  it('выкладка отказала — сообщение, сравнения соседей после неё нет', () => {
    const res = run(['both'], { FAKE_INSTALL_RC: '1' })
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /выпуск не выложен — работает прежний/)
    order(res.log, /^neighbors\.sh --save$/, /^deploy\.sh install /)
    assert.ok(!res.log.some((l) => /^neighbors\.sh --compare$/.test(l)), res.log.join('\n'))
  })

  it('migrate: только чтение → нет новых — ни записи, ни сигнала; клон и подключение — только на чтение', () => {
    const res = run(['migrate'])
    assert.equal(res.status, 0, res.all)
    const tools = res.log.filter((l) => /^docker run --rm /.test(l))
    assert.equal(tools.length, 1, res.log.join('\n'))
    assert.match(tools[0], new RegExp(`--user ${process.getuid()}:${process.getgid()} --memory 512m --cpus 1 `))
    assert.match(tools[0], new RegExp(`-v ${home}/src:/src:ro -v ${home}/secrets/db:/db:ro `))
    assert.match(tools[0], /bash migration\/target\/migrate\.sh \/db\/target\.env --dry-run$/)
    assert.ok(!res.log.some((l) => /SIGUSR1/.test(l)))
    assert.match(res.all, /новых миграций нет — база не менялась/)
    assert.ok(!res.all.includes('SECRET-DB-PASS'))
  })

  it('migrate: новые есть — без терминала нужен --yes; с --yes — применение, сигнал PostgREST, проверка готовности', () => {
    const dry = { FAKE_DRY: 'ИНФО к применению: 20990101_x\\nИТОГ: к применению 1 — запуск с --yes применит их по порядку.' }
    let res = run(['migrate'], dry)
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /нет терминала для вопроса — запустите: bash scripts\/deploy-server\.sh migrate --yes/)
    assert.ok(!res.log.some((l) => / --yes$/.test(l)), 'без согласия не применялось')
    res = run(['migrate', '--yes'], dry)
    assert.equal(res.status, 0, res.all)
    order(res.log, /migrate\.sh \/db\/target\.env --dry-run$/, /migrate\.sh \/db\/target\.env --yes$/,
      /^docker compose -p osp kill -s SIGUSR1 osp-postgrest$/, /^deploy\.sh status$/)
    res = run(['migrate', '--yes'], { ...dry, FAKE_MIGRATE_RC: '4' })
    assert.equal(res.status, 1, res.all)
    assert.match(res.all, /миграции остановлены \(код 4\)/)
    assert.ok(res.log.some((l) => /SIGUSR1/.test(l)), 'применённое до отказа PostgREST тоже должен увидеть')
    assert.equal(run(['migrate', '--force']).status, 1)
  })

  it('скрипт обновился в репозитории — выкладка продолжается новой версией без повторного git sync', () => {
    const next = fs.readFileSync(SCRIPT, 'utf8').replace('set -euo pipefail\n', 'set -euo pipefail\necho "НОВАЯ ВЕРСИЯ СКРИПТА"\n')
    pushChange('scripts/deploy-server.sh', next)
    const res = run(['migrate'])
    assert.equal(res.status, 0, res.all)
    assert.match(res.all, /скрипт выкладки обновился — продолжаю новой версией[\s\S]*НОВАЯ ВЕРСИЯ СКРИПТА[\s\S]*SKIP_GIT_SYNC=1/)
  })

  it('в скрипте нет общих команд Docker: prune всего, остановка и удаление чужого', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    assert.doesNotMatch(text, /docker\s+(system|image|container|volume|network|builder)\s+prune/)
    assert.deepEqual([...text.matchAll(/docker buildx[^\n]*/g)].map((m) => m[0]), ['docker buildx "$@"; }'], 'buildx — только через свой DOCKER_CONFIG (bx)')
    for (const m of text.matchAll(/\bbx (prune|stop|rm)[^\n]*/g)) assert.match(m[0], /--builder "\$BUILDER"|"\$BUILDER"/, m[0])
    assert.doesNotMatch(text, /docker\s+(stop|kill|rm|rmi)\b/)
    for (const m of text.matchAll(/docker compose (?!version)[^\n]*/g)) assert.match(m[0], /-p "\$PROJECT"/, m[0])
  })
})
