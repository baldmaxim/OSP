// Портал в Docker — та связка, что ставится на общий сервер (deploy/docker): образы сайта и своего API,
// PostgREST закреплённой версии, выкладка deploy.sh и запись в общем nginx сервера. Всё настоящее:
//   • образы собирает deploy/docker/build.sh — как для сервера, с контрольными суммами выпуска;
//   • база — копия прода под одной учёткой (tests/db/lib/stand.mjs), с TLS и проверкой сертификата,
//     как база Яндекса;
//   • «общий nginx сервера» и «соседний проект» — отдельные контейнеры в общей сети.
// Проверяем то, что обещано владельцу портала: портал отвечает так же, как прежняя цепочка; выпуск,
// не прошедший проверку, возвращается; соседи по серверу не затронуты; в образах нет ни копий базы,
// ни секретов; ключ из ?key= не попадает в журналы.
// Нужны Docker с Compose, openssl, curl, проверенная копия прода и базовые образы (см. skipReason).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason as dbSkipReason, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { createOwnDb } from '../../src/api/ownDb.js'
import { SECRET, userToken, projectKey } from '../osp-api/lib/tokens.mjs'

const DOCKER_DIR = path.join(ROOT, 'deploy', 'docker')
const NGINX_IMAGE = 'nginx:1.29-alpine'
const NODE_IMAGE = 'node:24-alpine'
const PGRST_IMAGE = fs.readFileSync(path.join(DOCKER_DIR, 'postgrest.image'), 'utf8').split('\n').find((l) => l && !l.startsWith('#')).split('@')[0]
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0

function skipReason() {
  const db = dbSkipReason({ needCopy: true })
  if (db) return db
  if (!has('openssl') || !has('curl')) return 'нужны openssl и curl'
  if (docker(['compose', 'version']).status !== 0) return 'нужен docker compose'
  for (const img of [NGINX_IMAGE, NODE_IMAGE, PGRST_IMAGE]) if (docker(['image', 'inspect', img]).status !== 0) return `нет образа ${img}`
  return false
}
const skip = skipReason()

const P = process.pid
const PROJECT = `osp-test-${P}`
const PROXY_NET = `osp-test-proxy-${P}`
const DB_NET = `osp-test-db-${P}`
const INFRA = `osp-test-infra-${P}`
const NEIGHBOUR = `osp-test-neighbour-${P}`
const SUPABASE = `osp-test-supabase-${P}`
const SUPABASE_URL = 'http://supabase:8080'
const GATEWAY_SECRET = 'docker-test-gateway-secret-0123456789abcdefgh'
const RATES_KEY = 'SECRET-RATES-KEY-DOCKER-123'
const OTHER_TAG = 'aaaaaaaaaaaa'
const BAD_TAG = 'bbbbbbbbbbbb'

describe('Портал в Docker: связка для общего сервера, выкладка с возвратом, соседи не затронуты', { skip, timeout: 60 * 60 * 1000 }, () => {
  let tmp, home, db, release, tag, buildId
  let p443, p80, pweb
  const users = {}
  const builtHere = []

  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  const ok = (res, what) => { assert.equal(res.status, 0, `${what}: ${(res.stdout || '') + (res.stderr || '')}`.slice(0, 2000)); return res }
  const env = () => ({ ...process.env, OSP_HOME: home, OSP_PROJECT: PROJECT, OSP_REPORT_DIR: path.join(tmp, 'reports') })
  const deploy = (args, extra = {}) => sh('bash', [path.join(release, 'deploy.sh'), ...args], { env: { ...env(), ...extra }, timeout: 15 * 60 * 1000 })
  const neighbors = (mode) => sh('bash', [path.join(release, 'neighbors.sh'), mode], { env: env() })
  const containerOf = (service) => docker(['compose', '-p', PROJECT, 'ps', '-q', service]).stdout.trim()
  const inspect = (id, format) => docker(['inspect', id, '--format', format]).stdout.trim()
  const current = () => (fs.existsSync(path.join(home, 'current')) ? path.basename(fs.readlinkSync(path.join(home, 'current'))) : null)
  // Запросы через «общий nginx сервера»: настоящее имя сайта, HTTPS.
  const curl = (args) => sh('curl', ['-sk', '-m', '30', '--resolve', `osp.root.sx:${p443}:127.0.0.1`, '--resolve', `osp.root.sx:${p80}:127.0.0.1`, ...args])
  const https = (urlPath, args = []) => curl([...args, `https://osp.root.sx:${p443}${urlPath}`])
  const code = (url, args = []) => curl(['-o', '/dev/null', '-w', '%{http_code}', ...args, url]).stdout
  // Клиент портала — тот же построитель запросов, что в браузере; идёт в контейнер сайта.
  const as = (sub) => createOwnDb({ baseUrl: `http://127.0.0.1:${pweb}/api/db`, getToken: async () => (sub ? userToken(SUPABASE_URL, sub) : null), fetchImpl: fetch })
  const direct = (table, sub) => Number(db.sql(`begin transaction read only;
      select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
      select 'n=' || count(*) from public.${table}; rollback;`, { appName: 'osp-test-direct' }).split('\n').find((l) => l.startsWith('n=')).slice(2))

  // Выпуск с другой меткой из тех же (или подменённых) образов — без архива: образы уже на машине.
  function makeRelease(newTag, { apiFrom } = {}) {
    const dir = path.join(tmp, 'out', `osp-release-${newTag}`)
    fs.cpSync(release, dir, { recursive: true })
    fs.rmSync(path.join(dir, 'images.tar.gz'))
    ok(docker(['tag', apiFrom || `osp-api:${tag}`, `osp-api:${newTag}`]), 'tag api')
    ok(docker(['tag', `osp-web:${tag}`, `osp-web:${newTag}`]), 'tag web')
    const id = (ref) => docker(['image', 'inspect', ref, '--format', '{{.Id}}']).stdout.trim()
    fs.writeFileSync(path.join(dir, 'release.env'), [`OSP_TAG=${newTag}`, `OSP_API_IMAGE=osp-api:${newTag}`, `OSP_WEB_IMAGE=osp-web:${newTag}`, `OSP_POSTGREST_IMAGE=${PGRST_IMAGE}`].join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'MANIFEST'), [`commit=${newTag.repeat(4).slice(0, 40)}`, `tag=${newTag}`, `build_id=${buildId}`,
      `image osp-api:${newTag} ${id(`osp-api:${newTag}`)}`, `image osp-web:${newTag} ${id(`osp-web:${newTag}`)}`, `image ${PGRST_IMAGE} ${id(PGRST_IMAGE)}`].join('\n') + '\n')
    ok(sh('bash', ['-c', "find . -type f ! -name SHA256SUMS -printf '%P\\n' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS"], { cwd: dir }), 'sums')
    return dir
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-docker-'))
    home = path.join(tmp, 'portal')
    for (const d of ['secrets', 'certs', 'shared', 'state']) fs.mkdirSync(path.join(home, d), { recursive: true })
    p443 = 25000 + Math.floor(Math.random() * 300) // ниже портов исходящих соединений (32768–60999)
    p80 = p443 + 300
    pweb = p443 + 600

    // 1. База: копия прода под одной учёткой; TLS с проверкой сертификата и имени — как у базы Яндекса.
    db = startSingleOwner(latestVerifiedCopy())
    users.admin = db.sql("select user_id from public.user_roles where role = 'admin' and is_approved and not coalesce(is_blocked, false) order by user_id limit 1", { appName: 'osp:internal' })
    const tls = path.join(tmp, 'tls')
    fs.mkdirSync(tls)
    const ssl = (args) => ok(sh('openssl', args, { cwd: tls }), `openssl ${args[0]}`)
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=osp-test-ca', '-keyout', 'ca.key', '-out', 'ca.crt'])
    ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=db', '-keyout', 'server.key', '-out', 'server.csr'])
    fs.writeFileSync(path.join(tls, 'ext.cnf'), 'subjectAltName=DNS:db\n')
    ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'server.crt'])
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=osp.root.sx', '-keyout', 'site.key', '-out', 'site.crt'])
    for (const f of ['server.crt', 'server.key']) ok(docker(['cp', path.join(tls, f), `${db.container}:/var/lib/postgresql/${f}`]), `cp ${f}`)
    ok(docker(['exec', '-u', 'root', db.container, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key']), 'права ключа')
    for (const q of ["alter system set ssl_cert_file = '/var/lib/postgresql/server.crt'", "alter system set ssl_key_file = '/var/lib/postgresql/server.key'",
      'alter system set ssl = on', 'select pg_reload_conf()']) db.adminSql(q)
    assert.equal(db.adminSql('show ssl'), 'on')

    // 2. Сети: общая сеть «nginx сервера» и сеть до базы (на сервере база — снаружи, здесь — контейнер).
    for (const n of [PROXY_NET, DB_NET]) ok(docker(['network', 'create', n]), `сеть ${n}`)
    ok(docker(['network', 'connect', '--alias', 'db', DB_NET, db.container]), 'база в сети')
    // Вместо Supabase Auth — заглушка: готовность osp-api проверяет его «здоровье».
    ok(docker(['run', '-d', '--rm', '--name', SUPABASE, '--network', DB_NET, '--network-alias', 'supabase', NODE_IMAGE, 'node', '-e',
      "require('http').createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('{}') }).listen(8080, '0.0.0.0')"]), 'заглушка входа')
    // Соседний проект сервера и общий nginx с записью портала — запущены ДО установки портала.
    ok(docker(['run', '-d', '--name', NEIGHBOUR, '--network', PROXY_NET, NGINX_IMAGE]), 'сосед')
    const conf = fs.readFileSync(path.join(DOCKER_DIR, 'infra-nginx', 'osp.conf'), 'utf8')
      .replaceAll('__NAMES__', 'osp.root.sx').replaceAll('__CERT__', '/etc/nginx/certs/site.crt').replaceAll('__KEY__', '/etc/nginx/certs/site.key')
    assert.ok(!/__[A-Z]+__/.test(conf), 'в записи общего nginx не осталось незаполненных мест')
    fs.writeFileSync(path.join(tmp, 'osp.conf'), conf)
    for (const f of ['site.crt', 'site.key']) fs.chmodSync(path.join(tls, f), 0o644)
    ok(docker(['run', '-d', '--name', INFRA, '--network', PROXY_NET, '-p', `127.0.0.1:${p443}:443`, '-p', `127.0.0.1:${p80}:80`,
      '-v', `${path.join(tmp, 'osp.conf')}:/etc/nginx/conf.d/osp.conf:ro`, '-v', `${tls}:/etc/nginx/certs:ro`, NGINX_IMAGE]), 'общий nginx')

    // 3. Каталог портала на «сервере»: настройки, сертификат базы, флаги.
    fs.writeFileSync(path.join(home, 'server.env'), `OSP_PROXY_NETWORK=${PROXY_NET}\n`)
    const dbUri = `postgres://${db.owner}:${db.ownerPass}@db:5432/osp_target?sslmode=verify-full`
    fs.writeFileSync(path.join(home, 'secrets', 'osp-api.env'), [
      `SUPABASE_URL=${SUPABASE_URL}`, `SUPABASE_ANON_KEY=${projectKey('anon')}`, `SUPABASE_JWT_SECRET=${SECRET}`, 'OSP_API_REQUIRE=supabase',
      `RATES_API_KEYS=${RATES_KEY}`, `OSP_DB_URL=${dbUri}`, 'OSP_DB_POOL_MAX=2', `OSP_PGRST_JWT_SECRET=${GATEWAY_SECRET}`, `OSP_PGRST_DB_ROLE=${db.owner}`,
    ].join('\n') + '\n', { mode: 0o600 })
    const pgrstEnv = fs.readFileSync(path.join(ROOT, 'deploy', 'postgrest', 'postgrest.env.example'), 'utf8')
      .replace(/^PGRST_DB_URI=.*$/m, `PGRST_DB_URI=${dbUri}&sslrootcert=/etc/ssl/osp/yandex-root.crt&application_name=osp-postgrest`)
      .replace(/^PGRST_JWT_SECRET=.*$/m, `PGRST_JWT_SECRET=${GATEWAY_SECRET}`)
    fs.writeFileSync(path.join(home, 'secrets', 'postgrest.env'), pgrstEnv, { mode: 0o600 })
    fs.copyFileSync(path.join(tls, 'ca.crt'), path.join(home, 'certs', 'yandex-root.crt'))
    fs.chmodSync(path.join(home, 'certs', 'yandex-root.crt'), 0o644)
    fs.writeFileSync(path.join(home, 'shared', 'config.json'), '{"features":{"ospDb":true},"marker":"osp-docker-test"}\n')
    for (const d of ['shared', 'state']) fs.chmodSync(path.join(home, d), 0o755)
    // Только для теста: сеть до базы-контейнера и порт сайта для клиента портала.
    fs.writeFileSync(path.join(home, 'compose.server.yml'), `services:
  api: { networks: [internal, dbnet] }
  postgrest: { networks: [internal, dbnet] }
  web: { ports: ["127.0.0.1:${pweb}:8080"] }
networks:
  dbnet: { external: true, name: ${DB_NET} }
`)

    // 4. Выпуск — тем же скриптом, что для сервера.
    const webEnv = path.join(tmp, 'web-build.env')
    fs.writeFileSync(webEnv, `VITE_SUPABASE_URL=${SUPABASE_URL}\nVITE_SUPABASE_ANON_KEY=test-anon-key\n`)
    const head = sh('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD']).stdout.trim()
    for (const ref of [`osp-api:${head}`, `osp-web:${head}`]) if (docker(['image', 'inspect', ref]).status !== 0) builtHere.push(ref)
    const built = sh('bash', [path.join(DOCKER_DIR, 'build.sh'), '--out', path.join(tmp, 'out')],
      { env: { ...process.env, OSP_BUILD_DIRTY: '1', OSP_WEB_BUILD_ENV: webEnv }, cwd: ROOT, timeout: 30 * 60 * 1000 })
    ok(built, 'build.sh')
    assert.ok(!built.stdout.includes('test-anon-key'), 'ключ сайта на экран не выводится')
    release = path.join(tmp, 'out', fs.readdirSync(path.join(tmp, 'out')).find((d) => d.startsWith('osp-release-')))
    const manifest = fs.readFileSync(path.join(release, 'MANIFEST'), 'utf8')
    tag = /^tag=(.+)$/m.exec(manifest)[1]
    buildId = /^build_id=(.+)$/m.exec(manifest)[1]
    assert.equal(tag, head)
  })

  after(() => {
    docker(['compose', '-p', PROJECT, 'down', '--volumes', '--remove-orphans'])
    docker(['rm', '-f', INFRA, NEIGHBOUR, SUPABASE])
    db?.stop()
    docker(['network', 'rm', PROXY_NET, DB_NET])
    docker(['image', 'rm', `osp-api:${OTHER_TAG}`, `osp-web:${OTHER_TAG}`, `osp-api:${BAD_TAG}`, `osp-web:${BAD_TAG}`, ...builtHere])
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('выпуск: образы, файлы установки и контрольные суммы; в контекст сборки попадает только разрешённое', () => {
    for (const f of ['images.tar.gz', 'compose.yml', 'deploy.sh', 'neighbors.sh', 'infra-nginx/osp.conf', 'release.env', 'MANIFEST', 'SHA256SUMS']) {
      assert.ok(fs.existsSync(path.join(release, f)), f)
    }
    ok(sh('sha256sum', ['--quiet', '-c', 'SHA256SUMS'], { cwd: release }), 'суммы выпуска')
    const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    assert.equal(ignore[0], '*', 'сначала исключено всё')
    assert.ok(ignore.slice(1).every((l) => l.startsWith('!')), 'дальше — только разрешённое')
    assert.ok(!ignore.some((l) => /migration|tests|\.env|secrets|dumps/.test(l)), 'копии базы, тесты и секреты в контекст не входят')
    // В самих образах нет ни копий базы, ни файлов настроек, ни тестов, ни каталога переноса.
    for (const image of [`osp-web:${tag}`, `osp-api:${tag}`]) {
      const found = docker(['run', '--rm', '--entrypoint', 'sh', image, '-c',
        "find / -xdev \\( -name '*.dump' -o -name '*.env' -o -name '*.env.*' -o -name '*.tsv' -o -path '*/migration/*' -o -path '*/tests/*' \\) -not -path '/proc/*' -not -path '*/node_modules/*' 2>/dev/null | head -5"]).stdout.trim()
      assert.equal(found, '', `${image}: лишние файлы`)
    }
  })

  // Главное для соседей: запись портала в общем nginx не мешает ему работать, когда портал остановлен.
  it('общий nginx сервера работает и без контейнеров портала: сайт ОСП — 502, остальное как было', () => {
    ok(docker(['exec', INFRA, 'nginx', '-t']), 'настройки общего nginx с записью портала')
    assert.equal(inspect(INFRA, '{{.State.Status}}'), 'running')
    assert.equal(code(`https://osp.root.sx:${p443}/`), '502')
    ok(docker(['exec', INFRA, 'nginx', '-s', 'reload']), 'перечитывание настроек')
    ok(neighbors('--save'), 'снимок соседей')
  })

  it('первая установка: суммы сверены, образы загружены, готовность пройдена', () => {
    const res = deploy(['install', release])
    ok(res, 'deploy.sh install')
    assert.match(res.stdout, new RegExp(`OK портал работает: выпуск ${tag}`))
    assert.match(res.stdout, /Готовность: \{"ok":true/)
    assert.equal(current(), tag)
    ok(deploy(['status']), 'status')
    // После установки скрипты лежат в каталоге портала — ими пользуются дальше.
    const status = sh('bash', [path.join(home, 'deploy.sh'), 'status'], { env: env() })
    ok(status, 'status из каталога портала')
    assert.match(status.stdout, new RegExp(`Выпуск: ${tag}`))
    assert.ok(fs.existsSync(path.join(home, 'neighbors.sh')))
    // Готовность изнутри: база и шлюз отвечают; сервер видит, что копия — репетиция.
    const ready = JSON.parse(docker(['compose', '-p', PROJECT, 'exec', '-T', 'api', 'node', '-e',
      'fetch("http://127.0.0.1:8787/api/ready").then(async (r) => process.stdout.write(await r.text()))']).stdout)
    assert.deepEqual([ready.ok, ready.checks.db, ready.checks.gateway, ready.checks.token, ready.data], [true, 'ok', 'ok', 'ok', 'rehearsal'])
    for (const s of [GATEWAY_SECRET, SECRET, db.ownerPass]) assert.ok(!res.stdout.includes(s) && !res.stderr.includes(s), 'секрет в выводе выкладки')
  })

  it('через общий nginx: сайт, версия, флаги, /api — те же правила, что на прежнем сервере', () => {
    assert.match(https('/').stdout, /<div id="root">/)
    assert.equal(JSON.parse(https('/version.json').stdout).buildId, buildId)
    assert.equal(JSON.parse(https('/config.json').stdout).marker, 'osp-docker-test', 'флаги — файл на сервере, вне образа')
    assert.match(https('/tenders/construction').stdout, /<div id="root">/, 'адреса страниц отдают сайт')
    const asset = docker(['compose', '-p', PROJECT, 'exec', '-T', 'web', 'sh', '-c', 'ls /var/www/osp/assets | head -n 1']).stdout.trim()
    assert.match(https(`/assets/${asset}`, ['-D', '-', '-o', '/dev/null']).stdout, /cache-control: public, immutable/i)
    assert.equal(code(`https://osp.root.sx:${p443}/assets/no-such-file.js`), '404')
    // /api: только по HTTPS, не кешируется, готовность снаружи закрыта.
    const health = https('/api/health', ['-D', '-'])
    assert.match(health.stdout, /"service":"osp-api"/)
    assert.equal((health.stdout.match(/^cache-control:/gim) || []).length, 1)
    assert.match(health.stdout, /cache-control: no-store/i)
    assert.equal(code(`https://osp.root.sx:${p443}/api/ready`), '404')
    assert.equal(code(`http://osp.root.sx:${p80}/api/health`), '403', 'по HTTP /api закрыт без перенаправления')
    assert.equal(code(`http://osp.root.sx:${p80}/`), '301')
    assert.equal(code(`https://osp.root.sx:${p443}/api`), '404')
    // Запрос больше 2 МБ на обычный маршрут — 413; шлюз данных принимает большие тела.
    const big = path.join(tmp, 'big.json')
    fs.writeFileSync(big, JSON.stringify({ x: 'a'.repeat(3 * 1024 * 1024) }))
    assert.equal(code(`https://osp.root.sx:${p443}/api/fn/ai-assist`, ['-X', 'POST', '-H', 'content-type: application/json', '--data-binary', `@${big}`]), '413')
    assert.notEqual(code(`https://osp.root.sx:${p443}/api/db/tenders`, ['-X', 'POST', '-H', 'content-type: application/json', '--data-binary', `@${big}`]), '413')
  })

  it('ключ из ?key= не попадает в журналы — ни общего nginx, ни контейнеров портала', () => {
    assert.match(https(`/api/rates/health?key=${RATES_KEY}`).stdout, /"ok":true/)
    https(`/api/rates/kp?key=${RATES_KEY}&limit=1`)
    code(`http://osp.root.sx:${p80}/api/rates/health?key=${RATES_KEY}`)
    const logs = [docker(['logs', INFRA]), docker(['compose', '-p', PROJECT, 'logs', '--no-color'])].map((r) => r.stdout + r.stderr).join('\n')
    assert.ok(logs.includes('/api/rates/health'), 'запросы в журнале есть')
    assert.ok(!logs.includes(RATES_KEY), 'ключ в журнале')
    for (const s of [GATEWAY_SECRET, SECRET, db.ownerPass]) assert.ok(!logs.includes(s), 'секрет в журнале')
  })

  it('данные: клиент портала → сайт → API → PostgREST → база — столько же строк, сколько даёт база', async () => {
    const admin = as(users.admin)
    for (const t of ['tenders', 'contracts', 'user_roles', 'tender_estimate_items']) {
      const res = await admin.from(t).select('*', { count: 'exact', head: true })
      assert.equal(res.error, null, t)
      assert.equal(res.count, direct(t, users.admin), `администратор / ${t}`)
    }
    const anon = as(null)
    for (const t of ['tenders', 'objects']) assert.equal((await anon.from(t).select('*', { count: 'exact', head: true })).count, direct(t, null), `аноним / ${t}`)
    assert.ok(direct('tenders', users.admin) > direct('tenders', null), 'аноним видит только витрину')
    assert.equal((await anon.from('tenders').insert({ work_description: 'x' })).status, 401)
    assert.equal((await admin.rpc('is_admin')).data, true)
    // То же через общий nginx (HTTPS): ответ PostgREST доходит как есть.
    const viaInfra = https('/api/db/tenders?select=id&limit=1', ['-H', `authorization: Bearer ${userToken(SUPABASE_URL, users.admin)}`])
    assert.equal(JSON.parse(viaInfra.stdout).length, 1)
    // PostgREST и API доступны только внутри проекта: из общей сети сервера сосед до них не дотягивается.
    const fromNeighbour = (host) => docker(['exec', NEIGHBOUR, 'sh', '-c', `wget -q -T 3 -O /dev/null http://${host}/ ; echo $?`]).stdout.trim()
    assert.notEqual(fromNeighbour('postgrest:3001'), '0')
    assert.notEqual(fromNeighbour('api:8787'), '0')
  })

  it('барьер записи — файл на сервере: запись через шлюз закрыта, чтение работает', async () => {
    const admin = as(users.admin)
    const key = `osp_docker_probe_${P}`
    fs.writeFileSync(path.join(home, 'state', 'db-readonly'), '')
    await new Promise((r) => setTimeout(r, 1500))
    const refused = await admin.from('app_settings').insert({ key, value: 'x' })
    assert.deepEqual([refused.status, refused.error.code], [503, 'OSP_READONLY'])
    assert.equal((await admin.from('tenders').select('id').limit(1)).error, null)
    fs.rmSync(path.join(home, 'state', 'db-readonly'))
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal((await admin.from('app_settings').insert({ key, value: 'x' })).error, null)
    assert.equal((await admin.from('app_settings').delete().eq('key', key).select('key')).data.length, 1)
  })

  it('контейнеры: не от root, файловая система только на чтение, потолок памяти, портов на сервере нет', () => {
    for (const service of ['web', 'api', 'postgrest']) {
      const id = containerOf(service)
      assert.equal(inspect(id, '{{.HostConfig.ReadonlyRootfs}}'), 'true', `${service}: только чтение`)
      assert.ok(Number(inspect(id, '{{.HostConfig.Memory}}')) > 0, `${service}: потолок памяти`)
      assert.ok(Number(inspect(id, '{{.HostConfig.NanoCpus}}')) > 0, `${service}: потолок процессора`)
      assert.equal(inspect(id, '{{.HostConfig.Privileged}}'), 'false')
      assert.match(inspect(id, '{{.HostConfig.CapDrop}}'), /ALL/)
      assert.notEqual(inspect(id, '{{.Config.User}}'), '', `${service}: пользователь задан`)
      assert.ok(!/^(0|root)(:|$)/.test(inspect(id, '{{.Config.User}}')), `${service}: не root`)
      assert.equal(inspect(id, '{{.HostConfig.LogConfig.Config}}').includes('max-size'), true, `${service}: журнал ограничен`)
    }
    assert.equal(docker(['compose', '-p', PROJECT, 'exec', '-T', 'web', 'sh', '-c', 'id -u; touch /probe 2>/dev/null; echo $?']).stdout.trim(), '101\n1')
    assert.equal(docker(['compose', '-p', PROJECT, 'exec', '-T', 'api', 'sh', '-c', 'id -u; touch /app/probe 2>/dev/null; echo $?']).stdout.trim(), '1000\n1')
    // Порты на сервере: у API и PostgREST — ни одного (порт сайта здесь открыт только правкой теста).
    for (const service of ['api', 'postgrest']) assert.equal(docker(['port', containerOf(service)]).stdout.trim(), '', `${service}: порт наружу`)
    assert.ok(!inspect(containerOf('api'), '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').includes(PROXY_NET), 'API не в общей сети сервера')
    assert.ok(!inspect(containerOf('postgrest'), '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').includes(PROXY_NET))
    // В выпуске порт сайта не публикуется: сайт доступен только общему nginx по сети.
    assert.ok(!/^\s*ports:/m.test(fs.readFileSync(path.join(release, 'compose.yml'), 'utf8')))
  })

  it('испорченный при переносе выпуск не устанавливается', () => {
    const broken = path.join(tmp, 'out', 'broken')
    fs.cpSync(release, broken, { recursive: true })
    fs.appendFileSync(path.join(broken, 'compose.yml'), '\n# подмена\n')
    const res = deploy(['install', broken])
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /контрольные суммы выпуска не совпали/)
    assert.equal(current(), tag, 'работает прежний выпуск')
    assert.match(https('/api/health').stdout, /osp-api/)
  })

  it('новый выпуск и возврат: том сайта переживает смену образа, rollback возвращает предыдущий', () => {
    // Файл «прежней сборки» в общем каталоге: вкладка, открытая до выкладки, должна его догрузить.
    ok(docker(['compose', '-p', PROJECT, 'exec', '-T', 'web', 'sh', '-c', 'echo "console.log(1)" > /var/www/osp/assets/old-build-abc123.js']), 'файл прежней сборки')
    const other = makeRelease(OTHER_TAG)
    const res = deploy(['install', other])
    ok(res, 'install другого выпуска')
    assert.equal(current(), OTHER_TAG)
    assert.equal(path.basename(fs.readlinkSync(path.join(home, 'previous'))), tag)
    assert.equal(inspect(containerOf('web'), '{{.Config.Image}}'), `osp-web:${OTHER_TAG}`)
    assert.equal(code(`https://osp.root.sx:${p443}/assets/old-build-abc123.js`), '200', 'файл прежней сборки на месте')
    const back = deploy(['rollback'])
    ok(back, 'rollback')
    assert.equal(current(), tag)
    assert.equal(inspect(containerOf('api'), '{{.Config.Image}}'), `osp-api:${tag}`)
    assert.match(https('/api/health').stdout, /osp-api/)
  })

  it('выпуск, не прошедший готовность, сам возвращается на прежний', () => {
    // «Плохой» образ API: контейнер запускается, но osp-api в нём нет — готовность не наступит.
    const bad = makeRelease(BAD_TAG, { apiFrom: NGINX_IMAGE })
    const res = deploy(['install', bad], { HEALTH_TRIES: '6', HEALTH_PAUSE: '1' })
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, new RegExp(`Выпуск ${BAD_TAG} не прошёл проверку`))
    assert.match(res.stdout, new RegExp(`Возвращён прежний выпуск ${tag} — работает`))
    assert.equal(current(), tag)
    assert.equal(inspect(containerOf('api'), '{{.Config.Image}}'), `osp-api:${tag}`)
    assert.match(https('/api/health').stdout, /osp-api/)
  })

  it('соседи по серверу не затронуты: общий nginx и соседний проект не перезапускались; пропажу проверка видит', () => {
    const res = neighbors('--compare')
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /OK чужих контейнеров в снимке: \d+; все на месте, работают, не перезапускались, образы прежние/)
    assert.match(res.stdout, /OK порты сервера: все \d+ из снимка слушаются/)
    assert.ok(!res.stdout.includes(PROJECT), 'контейнеры самого портала в сравнение не входят')
    assert.equal(inspect(NEIGHBOUR, '{{.State.Status}} {{.RestartCount}}'), 'running 0')
    assert.equal(inspect(INFRA, '{{.State.Status}} {{.RestartCount}}'), 'running 0')
    // Кто-то (не выкладка) остановил соседа — сравнение обязано это показать.
    ok(docker(['stop', '-t', '1', NEIGHBOUR]), 'остановка соседа')
    const lost = neighbors('--compare')
    assert.equal(lost.status, 3, lost.stdout)
    assert.match(lost.stdout, new RegExp(`FAIL чужие контейнеры остановлены: .*${NEIGHBOUR}`))
  })
})
