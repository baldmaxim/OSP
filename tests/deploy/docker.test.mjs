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
import { coverMovesSql } from '../../migration/target/lib/extras.mjs'
import crypto from 'node:crypto'

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
// Жетон адреса клиента (web/nginx.conf): знают только запись общего nginx и контейнер сайта.
const EDGE_TOKEN = crypto.randomBytes(24).toString('hex')
const DB_NET = `osp-test-db-${P}`
const INFRA = `osp-test-infra-${P}`
const NEIGHBOUR = `osp-test-neighbour-${P}`
// Сосед с собственным API в той же общей сети. Имена «web» и «api» — самые обычные для чужого проекта.
const NEIGHBOUR_API = `osp-test-neighbour-api-${P}`
const FOREIGN = `osp-test-foreign-${P}`
const SUPABASE = `osp-test-supabase-${P}`
const SUPABASE_URL = 'http://supabase:8080'
// Хранилище S3 «как cloud.ru» (без проверки подписи): запоминает объекты, пишет в журнал каждую запись.
const S3STUB = `osp-test-s3-${P}`
const S3_SECRET = 'S3-SECRET-DOCKER-zz7'
// Обложки в общедоступном бакете object-photos «Supabase»: copy-covers читает их без ключей.
const COVERS = { 'aaaaaaaa-0000-4000-8000-000000000001.jpg': 'jpeg-обложка-1', 'aaaaaaaa-0000-4000-8000-000000000002.png': 'png-обложка-2' }
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
  const renderNginx = (args) => ok(sh('bash', [path.join(DOCKER_DIR, 'infra-nginx', 'render.sh'), ...args]), 'render.sh').stdout
  // Запись в «общем nginx» ставит тот же скрипт, что на сервере.
  const confDir = () => path.join(tmp, 'conf.d')
  const nginxInstall = (args, extra = {}) => sh('bash', [path.join(DOCKER_DIR, 'infra-nginx', 'install.sh'), ...args],
    { env: { ...process.env, INFRA_NGINX: INFRA, INFRA_CONF_DIR: confDir(), OSP_EDGE_TOKEN: EDGE_TOKEN, ...extra } })
  // Сайт соседа через общий nginx: его запись ищет контейнер по имени «web».
  const neighbourSite = () => sh('curl', ['-s', '-m', '10', '--resolve', `neighbour.test:${p80}:127.0.0.1`, `http://neighbour.test:${p80}/`]).stdout
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
    // Отпечаток образа — тем же способом, что в выпуске (не зависит от того, как Docker хранит образы).
    const id = (ref) => sh('bash', [path.join(release, 'deploy.sh'), 'fingerprint', ref]).stdout.trim()
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
    // Вместо Supabase Auth — заглушка: готовность osp-api проверяет его «здоровье». Она же — общедоступный
    // бакет обложек object-photos.
    ok(docker(['run', '-d', '--rm', '--name', SUPABASE, '--network', DB_NET, '--network-alias', 'supabase', '-e', `COVERS=${JSON.stringify(COVERS)}`, NODE_IMAGE, 'node', '-e',
      `const covers = JSON.parse(process.env.COVERS); const p = '/storage/v1/object/public/object-photos/';
       require('http').createServer((q, s) => { console.log(q.method + ' ' + q.url + ' auth=' + (q.headers.authorization ? 'yes' : 'no'));
         const name = q.url.startsWith(p) ? decodeURIComponent(q.url.slice(p.length)) : null;
         if (name !== null) { if (!(name in covers)) { s.writeHead(404); return s.end('{}') } s.writeHead(200, { 'content-type': 'image/jpeg' }); return s.end(covers[name]) }
         s.writeHead(200, { 'content-type': 'application/json' }); s.end('{}') }).listen(8080, '0.0.0.0')`]), 'заглушка входа')
    ok(docker(['run', '-d', '--rm', '--name', S3STUB, '--network', DB_NET, '--network-alias', 's3', NODE_IMAGE, 'node', '-e',
      `const m = new Map(); require('http').createServer((q, s) => { const c = []; q.on('data', (d) => c.push(d)); q.on('end', () => {
         const k = decodeURIComponent(new URL(q.url, 'http://x').pathname);
         if (q.method === 'PUT') { m.set(k, Buffer.concat(c)); console.log('PUT ' + k); s.writeHead(200); return s.end() }
         if (q.method === 'GET' || q.method === 'HEAD') { const b = m.get(k); if (!b) { s.writeHead(404, { 'content-type': 'application/xml' }); return s.end('<Error><Code>NoSuchKey</Code></Error>') }
           s.writeHead(200, { 'content-length': b.length }); return s.end(q.method === 'HEAD' ? undefined : b) }
         if (q.method === 'DELETE') { m.delete(k); s.writeHead(204); return s.end() }
         s.writeHead(200); s.end() }) }).listen(9000, '0.0.0.0')`]), 'заглушка S3')
    // Соседний проект сервера — запущен ДО установки портала. В общей сети у него обычные имена «web» и
    // «api»; его запись в общем nginx ищет сайт по имени «web».
    ok(docker(['run', '-d', '--name', NEIGHBOUR, '--network', PROXY_NET, '--network-alias', 'web', NGINX_IMAGE]), 'сосед')
    ok(docker(['run', '-d', '--name', NEIGHBOUR_API, '--network', PROXY_NET, '--network-alias', 'api', NODE_IMAGE, 'node', '-e',
      "require('http').createServer((q, s) => { console.log('HIT ' + q.url); s.end('neighbour-api') }).listen(8787, '0.0.0.0')"]), 'API соседа')
    // Общий nginx — как на сервере: каталог записей, сертификаты в /etc/letsencrypt, проверка — /var/www/certbot.
    fs.mkdirSync(confDir())
    fs.writeFileSync(path.join(confDir(), 'neighbour.conf'), `server {
    listen 80;
    server_name neighbour.test;
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $web http://web:80;
    location / { proxy_pass $web; }
}
`)
    fs.mkdirSync(path.join(tmp, 'le'))
    fs.mkdirSync(path.join(tmp, 'certbot', '.well-known', 'acme-challenge'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'certbot', '.well-known', 'acme-challenge', 'probe'), 'acme-ok')
    ok(docker(['run', '-d', '--name', INFRA, '--network', PROXY_NET, '-p', `127.0.0.1:${p443}:443`, '-p', `127.0.0.1:${p80}:80`,
      '-v', `${confDir()}:/etc/nginx/conf.d:ro`, '-v', `${path.join(tmp, 'le')}:/etc/letsencrypt/live:ro`,
      '-v', `${path.join(tmp, 'certbot')}:/var/www/certbot:ro`, NGINX_IMAGE]), 'общий nginx')

    // 3. Каталог портала на «сервере»: настройки, сертификат базы, флаги.
    fs.writeFileSync(path.join(home, 'server.env'), `OSP_PROXY_NETWORK=${PROXY_NET}\n`)
    const dbUri = `postgres://${db.owner}:${db.ownerPass}@db:5432/osp_target?sslmode=verify-full`
    fs.writeFileSync(path.join(home, 'secrets', 'osp-api.env'), [
      `SUPABASE_URL=${SUPABASE_URL}`, `SUPABASE_ANON_KEY=${projectKey('anon')}`, `SUPABASE_JWT_SECRET=${SECRET}`, 'OSP_API_REQUIRE=supabase',
      `RATES_API_KEYS=${RATES_KEY}`, `OSP_DB_URL=${dbUri}`, 'OSP_DB_POOL_MAX=2', `OSP_PGRST_JWT_SECRET=${GATEWAY_SECRET}`, `OSP_PGRST_DB_ROLE=${db.owner}`,
      'S3_ENDPOINT=http://s3:9000', 'S3_BUCKET=osp', 'S3_ACCESS_KEY_ID=ospdocker', `S3_SECRET_ACCESS_KEY=${S3_SECRET}`,
    ].join('\n') + '\n', { mode: 0o600 })
    const pgrstEnv = fs.readFileSync(path.join(ROOT, 'deploy', 'postgrest', 'postgrest.env.example'), 'utf8')
      .replace(/^PGRST_DB_URI=.*$/m, `PGRST_DB_URI=${dbUri}&sslrootcert=/etc/ssl/osp/yandex-root.crt&application_name=osp-postgrest`)
      .replace(/^PGRST_JWT_SECRET=.*$/m, `PGRST_JWT_SECRET=${GATEWAY_SECRET}`)
    fs.writeFileSync(path.join(home, 'secrets', 'postgrest.env'), pgrstEnv, { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'secrets', 'osp-web.env'), `OSP_EDGE_TOKEN=${EDGE_TOKEN}\n`, { mode: 0o600 })
    fs.copyFileSync(path.join(tls, 'ca.crt'), path.join(home, 'certs', 'yandex-root.crt'))
    fs.chmodSync(path.join(home, 'certs', 'yandex-root.crt'), 0o644)
    fs.writeFileSync(path.join(home, 'shared', 'config.json'), '{"features":{"ospDb":true},"marker":"osp-docker-test"}\n')
    for (const d of ['shared', 'state']) fs.chmodSync(path.join(home, d), 0o755)
    // Только для теста: сеть до базы-контейнера и порт сайта для клиента портала.
    fs.writeFileSync(path.join(home, 'compose.server.yml'), `services:
  osp-api: { networks: [internal, dbnet] }
  osp-postgrest: { networks: [internal, dbnet] }
  osp-web: { ports: ["127.0.0.1:${pweb}:8080"] }
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
    docker(['rm', '-fv', INFRA, NEIGHBOUR, NEIGHBOUR_API, FOREIGN, SUPABASE, S3STUB])
    docker(['volume', 'rm', `${PROJECT}_www`])
    docker(['network', 'rm', `${PROJECT}_internal`])
    db?.stop()
    docker(['network', 'rm', PROXY_NET, DB_NET])
    docker(['image', 'rm', `osp-api:${OTHER_TAG}`, `osp-web:${OTHER_TAG}`, `osp-api:${BAD_TAG}`, `osp-web:${BAD_TAG}`, ...builtHere])
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('выпуск: образы, файлы установки и контрольные суммы; в контекст сборки попадает только разрешённое', () => {
    for (const f of ['images.tar.gz', 'compose.yml', 'deploy.sh', 'neighbors.sh', 'infra-nginx/site.conf.template', 'infra-nginx/render.sh', 'infra-nginx/install.sh', 'release.env', 'MANIFEST', 'SHA256SUMS']) {
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

  // Запись портала ставится в два шага: блок HTTPS ссылается на сертификат, которого сначала нет.
  // Ставит её скрипт: общий nginx ни в какой момент не остаётся с негодными настройками.
  it('запись в общем nginx, шаг 1 — только HTTP: принимается без сертификата, отдаёт проверку Let’s Encrypt', () => {
    assert.match(neighbourSite(), /Welcome to nginx/, 'сайт соседа работает до нас')
    const http = renderNginx(['osp.root.sx', '--http-only'])
    assert.ok(!/ssl_certificate|listen 443|__[A-Z]+__|#@https/.test(http), 'в записи «только HTTP» нет ни HTTPS, ни незаполненных мест')
    // В записи только блоки server этого имени: ни общих настроек, ни форматов журнала, ни зон.
    const full = renderNginx(['osp.213-171-26-249.nip.io'])
    for (const text of [http, full]) {
      assert.ok(!/^\s*(log_format|limit_req_zone|upstream|map|proxy_cache_path|include)\b/m.test(text), 'общих настроек в записи нет')
      assert.ok(/access_log off;/.test(text) && !/access_log \//.test(text), 'в общий журнал запросы портала не пишутся')
    }
    assert.match(full, /server_name osp\.213-171-26-249\.nip\.io;/)
    assert.match(full, /ssl_certificate \/etc\/letsencrypt\/live\/osp\.213-171-26-249\.nip\.io\/fullchain\.pem;/)
    assert.notEqual(sh('bash', [path.join(DOCKER_DIR, 'infra-nginx', 'render.sh'), 'bad name;']).status, 0, 'имя сайта проверяется')

    const res = nginxInstall(['osp.root.sx', '--http-only'])
    ok(res, 'install.sh --http-only')
    assert.match(res.stdout, /OK запись osp\.root\.sx \(только HTTP\) в общем nginx, настройки перечитаны/)
    assert.equal(fs.readFileSync(path.join(confDir(), 'osp.root.sx.conf'), 'utf8'), http)
    assert.equal(curl([`http://osp.root.sx:${p80}/.well-known/acme-challenge/probe`]).stdout, 'acme-ok')
    assert.equal(code(`http://osp.root.sx:${p80}/api/health`), '403')
    assert.equal(code(`http://osp.root.sx:${p80}/`), '301')
    assert.match(neighbourSite(), /Welcome to nginx/, 'сайт соседа работает после нас')
    assert.equal(inspect(INFRA, '{{.State.Status}} {{.RestartCount}}'), 'running 0')
  })

  it('негодная запись откатывается сама: общий nginx остаётся с прежними настройками, чужая запись не трогается', () => {
    const before = fs.readFileSync(path.join(confDir(), 'osp.root.sx.conf'), 'utf8')
    const neighbourConf = fs.readFileSync(path.join(confDir(), 'neighbour.conf'), 'utf8')
    // Полная запись до выпуска сертификата: файлов сертификата ещё нет — nginx её не примет.
    const res = nginxInstall(['osp.root.sx'])
    assert.equal(res.status, 3, res.stdout + res.stderr)
    assert.match(res.stdout, /FAIL общий nginx не принял запись osp\.root\.sx/)
    assert.match(res.stdout, /Прежнее состояние возвращено, настройки общего nginx годны; перечитывания не было/)
    assert.equal(fs.readFileSync(path.join(confDir(), 'osp.root.sx.conf'), 'utf8'), before, 'на месте прежняя запись «только HTTP»')
    ok(docker(['exec', INFRA, 'nginx', '-t']), 'настройки общего nginx годны')
    assert.deepEqual(fs.readdirSync(confDir()).sort(), ['neighbour.conf', 'osp.root.sx.conf'], 'временных файлов не осталось')
    // Имя, которое уже есть в чужой записи, — отказ до любых изменений.
    const taken = nginxInstall(['neighbour.test', '--http-only'])
    assert.equal(taken.status, 1)
    assert.match(taken.stderr, /имя neighbour\.test уже есть в другой записи общего nginx: neighbour\.conf/)
    assert.equal(fs.readFileSync(path.join(confDir(), 'neighbour.conf'), 'utf8'), neighbourConf)
    assert.ok(!fs.existsSync(path.join(confDir(), 'neighbour.test.conf')))
    // Запись, которой ещё не было, после отказа не остаётся вовсе.
    const fresh = nginxInstall(['osp.example.test'])
    assert.equal(fresh.status, 3)
    assert.ok(!fs.existsSync(path.join(confDir(), 'osp.example.test.conf')))
    ok(docker(['exec', INFRA, 'nginx', '-t']), 'настройки общего nginx годны')
    assert.match(neighbourSite(), /Welcome to nginx/, 'сайт соседа всё это время работает')
    assert.equal(inspect(INFRA, '{{.State.Status}} {{.RestartCount}}'), 'running 0')
  })

  // Главное для соседей: запись портала в общем nginx не мешает ему работать, когда портал остановлен.
  it('шаг 2 — с HTTPS: общий nginx работает и без контейнеров портала, сайт ОСП — 502', () => {
    // «Сертификат выпущен»: файлы появились там, где их кладёт Let's Encrypt.
    const live = path.join(tmp, 'le', 'osp.root.sx')
    fs.mkdirSync(live)
    fs.copyFileSync(path.join(tmp, 'tls', 'site.crt'), path.join(live, 'fullchain.pem'))
    fs.copyFileSync(path.join(tmp, 'tls', 'site.key'), path.join(live, 'privkey.pem'))
    for (const f of ['fullchain.pem', 'privkey.pem']) fs.chmodSync(path.join(live, f), 0o644)
    const res = nginxInstall(['osp.root.sx'])
    ok(res, 'install.sh')
    assert.match(res.stdout, /OK запись osp\.root\.sx в общем nginx, настройки перечитаны/)
    assert.ok(!/__[A-Z]+__|#@https/.test(fs.readFileSync(path.join(confDir(), 'osp.root.sx.conf'), 'utf8')), 'в полной записи не осталось незаполненных мест')
    assert.equal(inspect(INFRA, '{{.State.Status}} {{.RestartCount}}'), 'running 0')
    assert.equal(code(`https://osp.root.sx:${p443}/`), '502')
    assert.equal(curl([`http://osp.root.sx:${p80}/.well-known/acme-challenge/probe`]).stdout, 'acme-ok', 'продление сертификата продолжит работать')
    assert.match(neighbourSite(), /Welcome to nginx/)
    ok(neighbors('--save'), 'снимок соседей')
  })

  it('первая установка — только на чистое место: проектом, томом или сетью с тем же именем выкладка не управляет', () => {
    const refused = (what) => {
      const res = deploy(['install', release])
      assert.notEqual(res.status, 0, what)
      assert.match(res.stderr, new RegExp(`на сервере уже есть ${what}`))
      assert.equal(current(), null)
    }
    ok(docker(['run', '-d', '--name', FOREIGN, '--label', `com.docker.compose.project=${PROJECT}`, NGINX_IMAGE]), 'чужой контейнер')
    refused('контейнеры проекта')
    assert.equal(inspect(FOREIGN, '{{.State.Status}}'), 'running', 'чужой контейнер не тронут')
    ok(docker(['rm', '-fv', FOREIGN]), 'убрать')
    ok(docker(['volume', 'create', `${PROJECT}_www`]), 'чужой том')
    refused('том проекта')
    ok(docker(['volume', 'rm', `${PROJECT}_www`]), 'убрать')
    ok(docker(['network', 'create', `${PROJECT}_internal`]), 'чужая сеть')
    refused('сеть')
    ok(docker(['network', 'rm', `${PROJECT}_internal`]), 'убрать')
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
    const ready = JSON.parse(docker(['compose', '-p', PROJECT, 'exec', '-T', 'osp-api', 'node', '-e',
      'fetch("http://127.0.0.1:8787/api/ready").then(async (r) => process.stdout.write(await r.text()))']).stdout)
    assert.deepEqual([ready.ok, ready.checks.db, ready.checks.gateway, ready.checks.token, ready.data], [true, 'ok', 'ok', 'ok', 'rehearsal'])
    for (const s of [GATEWAY_SECRET, SECRET, db.ownerPass]) assert.ok(!res.stdout.includes(s) && !res.stderr.includes(s), 'секрет в выводе выкладки')
  })

  it('через общий nginx: сайт, версия, флаги, /api — те же правила, что на прежнем сервере', () => {
    assert.match(https('/').stdout, /<div id="root">/)
    assert.equal(JSON.parse(https('/version.json').stdout).buildId, buildId)
    assert.equal(JSON.parse(https('/config.json').stdout).marker, 'osp-docker-test', 'флаги — файл на сервере, вне образа')
    assert.match(https('/tenders/construction').stdout, /<div id="root">/, 'адреса страниц отдают сайт')
    const asset = docker(['compose', '-p', PROJECT, 'exec', '-T', 'osp-web', 'sh', '-c', 'ls /var/www/osp/assets | head -n 1']).stdout.trim()
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
    const infraLog = docker(['logs', INFRA])
    const ownLog = docker(['compose', '-p', PROJECT, 'logs', '--no-color'])
    const logs = [infraLog, ownLog].map((r) => r.stdout + r.stderr).join('\n')
    assert.ok((ownLog.stdout + ownLog.stderr).includes('/api/rates/health'), 'запросы пишет контейнер сайта — в свой журнал')
    assert.ok(!logs.includes(RATES_KEY), 'ключ в журнале')
    for (const s of [GATEWAY_SECRET, SECRET, db.ownerPass]) assert.ok(!logs.includes(s), 'секрет в журнале')
    // Общий журнал сервера за счёт портала не растёт: его запросов там нет вовсе.
    assert.ok(!(infraLog.stdout + infraLog.stderr).includes('/api/rates'), 'запросы портала в общем журнале')
  })

  // Адрес клиента (лимиты /api/ и входа) — только от общего nginx по жетону; X-Forwarded-For к API — одним
  // адресом. Подложенные клиентом заголовки и запрос соседа из общей сети адрес не подменяют.
  it('адрес клиента: по жетону общего nginx; подложенные заголовки клиента и сосед без жетона адрес не подменяют', () => {
    https('/api/health', ['-A', 'probe-spoof', '-H', 'X-Forwarded-For: 6.6.6.6', '-H', 'X-OSP-Client-IP: 7.7.7.7', '-H', 'X-OSP-Edge: wrong'])
    docker(['exec', NEIGHBOUR, 'sh', '-c', `wget -q -T 5 -O /dev/null -U probe-neighbour --header 'X-OSP-Client-IP: 9.9.9.9' --header 'X-OSP-Edge: ${'0'.repeat(48)}' --header 'X-Forwarded-Proto: https' http://osp-web:8080/api/health`])
    const ip = (id) => docker(['inspect', id, '--format', `{{(index .NetworkSettings.Networks "${PROXY_NET}").IPAddress}}`]).stdout.trim()
    const webLog = docker(['compose', '-p', PROJECT, 'logs', '--no-color', 'osp-web'])
    const lines = (webLog.stdout + webLog.stderr).split('\n')
    const addr = (agent) => {
      const line = lines.filter((l) => l.includes(`"${agent}"`)).at(-1)
      assert.ok(line, `нет строки журнала для ${agent}`)
      return /\|\s*(\S+) - /.exec(line)?.[1] ?? line.split(' ')[0]
    }
    const spoof = addr('probe-spoof')
    assert.ok(!['6.6.6.6', '7.7.7.7'].includes(spoof), `подложенный адрес: ${spoof}`)
    assert.notEqual(spoof, ip(INFRA), 'адрес клиента не дошёл по жетону — виден адрес общего nginx')
    assert.equal(addr('probe-neighbour'), ip(NEIGHBOUR), 'сосед без жетона — его собственный адрес')
    const all = docker(['compose', '-p', PROJECT, 'logs', '--no-color'])
    assert.ok(!(all.stdout + all.stderr).includes(EDGE_TOKEN), 'жетон не попадает в журналы')
    const conf = fs.readFileSync(path.join(DOCKER_DIR, 'web', 'site.conf'), 'utf8')
    assert.ok(!conf.includes('$proxy_add_x_forwarded_for'), 'X-Forwarded-For к API — перезапись одним адресом, не дописывание')
    assert.ok(!conf.includes('$http_referer'), 'журнал без Referer')
    assert.ok(!/set_real_ip_from/.test(fs.readFileSync(path.join(DOCKER_DIR, 'web', 'nginx.conf'), 'utf8')), 'частным сетям целиком не доверяем')
  })

  // Без жетона все запросы за общим nginx приходят с одного адреса: лимит /api/ по нему стал бы одним на всех
  // (20 зап/с на весь портал). Поэтому без жетона лимит по адресу не действует, с жетоном — действует.
  // Отдельный контейнер сайта без API: запрос, прошедший лимит, ждёт API (нет ответа), сверх лимита — 429.
  it('лимит /api/ по адресу: без жетона выключен (а не один на всех), с жетоном — действует', () => {
    const flood = (env) => {
      const name = `${PROJECT}-limit-${env.length}`
      ok(docker(['run', '-d', '--name', name, ...env, `osp-web:${tag}`]), 'сайт без API')
      try {
        let up = false
        for (let i = 0; i < 40 && !up; i++) {
          up = docker(['exec', name, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/version.json']).status === 0
          if (!up) spawnSync('sleep', ['0.5'])
        }
        assert.ok(up, 'сайт не поднялся')
        const res = docker(['exec', name, 'sh', '-c',
          'for i in $(seq 80); do (wget -S -q -T 3 -O /dev/null http://127.0.0.1:8080/api/health 2>&1 | grep -q " 429" && echo 429 || echo pass) & done; wait'])
        return { limited: res.stdout.split('\n').filter((l) => l === '429').length, log: docker(['logs', name]) }
      } finally {
        docker(['rm', '-f', name])
      }
    }
    const without = flood([])
    assert.equal(without.limited, 0, 'без жетона лимит по адресу не действует')
    assert.match(without.log.stderr + without.log.stdout, /OSP_EDGE_TOKEN не задан/, 'в журнале — предупреждение')
    const withToken = flood(['-e', `OSP_EDGE_TOKEN=${EDGE_TOKEN}`])
    assert.ok(withToken.limited > 0, 'с жетоном всплеск с одного адреса получает 429')
  })

  // Имя службы Docker делает именем в каждой сети, куда она подключена. У соседа в общей сети имена
  // «web» и «api» — будь такие же у служб портала, запросы перемешались бы в обе стороны.
  it('имена в общей сети: запросы соседа не попадают в портал, запросы портала — к соседу', () => {
    const aliases = inspect(containerOf('osp-web'), `{{json (index .NetworkSettings.Networks "${PROXY_NET}").Aliases}}`)
    assert.ok(aliases.includes('"osp-web"'), aliases)
    assert.ok(!/"(web|api|postgrest)"/.test(aliases), `в общей сети у портала только свои имена: ${aliases}`)
    // Сайт соседа ищет «web»: каждый раз отвечает сосед, ни разу — сайт портала.
    for (let i = 0; i < 20; i++) {
      const page = neighbourSite()
      assert.match(page, /Welcome to nginx/, `запрос ${i}: сайт соседа`)
      assert.ok(!page.includes('<div id="root">'), `запрос ${i}: ответил сайт портала`)
    }
    // Портал ищет свой API по своему имени: каждый раз отвечает osp-api, API соседа не получил ни запроса.
    for (let i = 0; i < 20; i++) assert.match(https('/api/health').stdout, /"service":"osp-api"/, `запрос ${i}`)
    assert.ok(!docker(['logs', NEIGHBOUR_API]).stdout.includes('HIT'), 'до API соседа запросы портала не дошли')
    assert.ok(!/(?<!osp-)api:8787|http:\/\/api\b|(?<!osp-)postgrest:3001/.test(fs.readFileSync(path.join(DOCKER_DIR, 'web', 'site.conf'), 'utf8')
      + fs.readFileSync(path.join(DOCKER_DIR, 'compose.yml'), 'utf8').replace(/^\s*#.*$/gm, '')), 'в настройках портала нет обращений по общим именам')
    assert.match(fs.readFileSync(path.join(DOCKER_DIR, 'compose.yml'), 'utf8'), /^  osp-web:\n[\s\S]*^  osp-api:\n[\s\S]*^  osp-postgrest:\n/m)
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
    assert.notEqual(fromNeighbour('osp-postgrest:3001'), '0')
    assert.notEqual(fromNeighbour('osp-api:8787'), '0')
    // А свой «api» сосед находит по-прежнему — и это его контейнер, не портала.
    assert.equal(docker(['exec', NEIGHBOUR, 'sh', '-c', 'wget -q -T 3 -O - http://api:8787/']).stdout, 'neighbour-api')
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
    for (const service of ['osp-web', 'osp-api', 'osp-postgrest']) {
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
    assert.equal(docker(['compose', '-p', PROJECT, 'exec', '-T', 'osp-web', 'sh', '-c', 'id -u; touch /probe 2>/dev/null; echo $?']).stdout.trim(), '101\n1')
    assert.equal(docker(['compose', '-p', PROJECT, 'exec', '-T', 'osp-api', 'sh', '-c', 'id -u; touch /app/probe 2>/dev/null; echo $?']).stdout.trim(), '1000\n1')
    // Порты на сервере: у API и PostgREST — ни одного (порт сайта здесь открыт только правкой теста).
    for (const service of ['osp-api', 'osp-postgrest']) assert.equal(docker(['port', containerOf(service)]).stdout.trim(), '', `${service}: порт наружу`)
    assert.ok(!inspect(containerOf('osp-api'), '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').includes(PROXY_NET), 'API не в общей сети сервера')
    assert.ok(!inspect(containerOf('osp-postgrest'), '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').includes(PROXY_NET))
    // Процессор: в сумме не больше одного ядра, приоритет вдвое ниже обычного — соседи получают его первыми.
    const services = ['osp-web', 'osp-api', 'osp-postgrest']
    const cpu = services.reduce((sum, service) => sum + Number(inspect(containerOf(service), '{{.HostConfig.NanoCpus}}')), 0)
    assert.ok(cpu > 0 && cpu <= 1e9, `потолки процессора в сумме: ${cpu / 1e9} ядра`)
    const memory = services.reduce((sum, service) => sum + Number(inspect(containerOf(service), '{{.HostConfig.Memory}}')), 0)
    assert.ok(memory <= 800 * 1024 * 1024, `потолки памяти в сумме: ${Math.round(memory / 1024 / 1024)} МБ`)
    for (const service of services) assert.equal(inspect(containerOf(service), '{{.HostConfig.CpuShares}}'), '512', `${service}: приоритет`)
    // В выпуске порт сайта не публикуется: сайт доступен только общему nginx по сети.
    assert.ok(!/^\s*ports:/m.test(fs.readFileSync(path.join(release, 'compose.yml'), 'utf8')))
  })

  it('обложки: covers-copy в образе API — список из копии на стандартный ввод, журнал на сервере; повтор ничего не загружает', () => {
    const header = 'name,size,mimetype,created_at,updated_at'
    const line = ([name, body]) => `${name},${Buffer.byteLength(body)},image/jpeg,2026-09-01 10:00:00+00,2026-09-01 10:00:00+00`
    const list = path.join(tmp, 'prod-test.covers.csv')
    fs.writeFileSync(list, [header, ...Object.entries(COVERS).map(line)].join('\n') + '\n', { mode: 0o600 })
    const puts = () => docker(['logs', S3STUB]).stdout.split('\n').filter((l) => l.startsWith('PUT /osp/covers/'))

    const first = deploy(['covers-copy', list])
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stderr, /Обложек в списке: 2; сверено 2 \(загружено 2, уже были 0\); не сверено 0/)
    const file = /^Журнал: (.+)$/m.exec(first.stdout)[1]
    assert.equal(path.dirname(file), path.join(home, 'covers'))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(journal.list_sha256, crypto.createHash('sha256').update(fs.readFileSync(list)).digest('hex'))
    assert.equal(journal.source_base, `${SUPABASE_URL}/storage/v1/object/public/object-photos/`)
    assert.deepEqual(journal.files.map((f) => [f.name, f.status, f.sha256]),
      Object.entries(COVERS).map(([n, b]) => [n, 'verified', crypto.createHash('sha256').update(b).digest('hex')]))
    // Журнал принимает загрузка в базу Яндекса.
    assert.deepEqual(coverMovesSql(JSON.stringify(journal), fs.readFileSync(list, 'utf8')).summary, { listed: 2, verified: 2, failed: 0 })
    assert.deepEqual(puts(), Object.keys(COVERS).map((n) => `PUT /osp/covers/${n}`))
    for (const out of [first.stdout, first.stderr, fs.readFileSync(file, 'utf8')]) assert.ok(!out.includes(S3_SECRET), 'ключ хранилища не выводится')
    const reads = docker(['logs', SUPABASE]).stdout.split('\n').filter((l) => l.includes('/object-photos/'))
    assert.ok(reads.length === 2 && reads.every((l) => l.startsWith('GET ') && l.endsWith('auth=no')), 'Supabase только читается, без ключей')

    const again = deploy(['covers-copy', list])
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.match(again.stderr, /сверено 2 \(загружено 0, уже были 2\)/)
    assert.equal(puts().length, 2, 'повтор ничего не загружает')

    // Обложки нет в Supabase — журнал всё равно на сервере, выход 4.
    fs.appendFileSync(list, line(['aaaaaaaa-0000-4000-8000-00000000dead.jpg', 'x']) + '\n')
    const partial = deploy(['covers-copy', list])
    assert.equal(partial.status, 4, partial.stdout + partial.stderr)
    assert.match(partial.stderr, /FAIL aaaaaaaa-0000-4000-8000-00000000dead\.jpg: хранилище Supabase ответило 404/)
    assert.match(partial.stdout, /^Журнал: /m)
    assert.equal(deploy(['covers-copy', path.join(tmp, 'web-build.env')]).status, 1, 'не список обложек — отказ')
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
    ok(docker(['compose', '-p', PROJECT, 'exec', '-T', 'osp-web', 'sh', '-c', 'echo "console.log(1)" > /var/www/osp/assets/old-build-abc123.js']), 'файл прежней сборки')
    const other = makeRelease(OTHER_TAG)
    const res = deploy(['install', other])
    ok(res, 'install другого выпуска')
    assert.equal(current(), OTHER_TAG)
    assert.equal(path.basename(fs.readlinkSync(path.join(home, 'previous'))), tag)
    assert.equal(inspect(containerOf('osp-web'), '{{.Config.Image}}'), `osp-web:${OTHER_TAG}`)
    assert.equal(code(`https://osp.root.sx:${p443}/assets/old-build-abc123.js`), '200', 'файл прежней сборки на месте')
    const back = deploy(['rollback'])
    ok(back, 'rollback')
    assert.equal(current(), tag)
    assert.equal(inspect(containerOf('osp-api'), '{{.Config.Image}}'), `osp-api:${tag}`)
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
    assert.equal(inspect(containerOf('osp-api'), '{{.Config.Image}}'), `osp-api:${tag}`)
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
    // Запись портала убирается тем же скриптом; сайт соседа это не задевает.
    const removed = nginxInstall(['osp.root.sx', '--remove'])
    ok(removed, 'install.sh --remove')
    assert.ok(!fs.existsSync(path.join(confDir(), 'osp.root.sx.conf')))
    ok(docker(['exec', INFRA, 'nginx', '-t']), 'настройки общего nginx годны')
    assert.match(neighbourSite(), /Welcome to nginx/)
    assert.equal(inspect(INFRA, '{{.State.Status}} {{.RestartCount}}'), 'running 0')
    // Кто-то (не выкладка) остановил соседа — сравнение обязано это показать.
    ok(docker(['stop', '-t', '1', NEIGHBOUR]), 'остановка соседа')
    const lost = neighbors('--compare')
    assert.equal(lost.status, 3, lost.stdout)
    assert.match(lost.stdout, new RegExp(`FAIL чужие контейнеры остановлены: .*${NEIGHBOUR}`))
  })
})
