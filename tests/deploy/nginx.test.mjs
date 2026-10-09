// Блок nginx для сайта и /api/ (deploy/nginx/osp.root.sx.conf) — тот самый файл, что ставится на VPS,
// на nginx 1.24 (как в Ubuntu 24.04) в Docker, с HTTPS и файлами Certbot. Вместо osp-api — заглушка на
// 127.0.0.1:8787 в той же сетевой среде. Проверяем то, что требует рецензия: ключ из ?key= не попадает
// ни в access, ни в error log — и по HTTPS, и по HTTP (порт 80: /api/ не перенаправляется); 429 при
// всплеске; 413 больше 2 МБ; ровно один Cache-Control: no-store; X-Forwarded-For доходит до сервиса (по
// нему /api/ready закрыт снаружи); без службы /api/ — 502, а сайт работает. Без Docker, образов или
// openssl набор пропускается.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONF = path.join(ROOT, 'deploy', 'nginx', 'osp.root.sx.conf')
const NGINX_IMAGE = 'nginx:1.24.0-alpine'
const NODE_IMAGE = 'node:20.20.2-bookworm-slim'
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts })
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0

function skipReason() {
  if (!has('openssl') || !has('curl')) return 'нужны openssl и curl'
  if (docker(['version']).status !== 0) return 'нет Docker'
  for (const img of [NGINX_IMAGE, NODE_IMAGE]) if (docker(['image', 'inspect', img]).status !== 0) return `нет образа ${img}`
  return false
}
const skip = skipReason()

// Заглушка osp-api: отвечает JSON с тем, что увидела (метод, путь, X-Forwarded-For), и своим
// Cache-Control — nginx должен заменить его на no-store.
const STUB = `
require('http').createServer((req, res) => {
  let n = 0
  req.on('data', (c) => { n += c.length })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' })
    res.end(JSON.stringify({ stub: true, method: req.method, url: req.url, xff: req.headers['x-forwarded-for'] || null, bytes: n }))
  })
}).listen(8787, '127.0.0.1')
`

describe('nginx: сайт и /api/ по файлу из репозитория', { skip, timeout: 180000 }, () => {
  let tmp, nginx, stub, base, httpBase, resolve, resolve80
  const KEY = 'SECRET-RATES-KEY-123'

  const curl = (args) => spawnSync('curl', ['-sk', '--resolve', resolve, '--resolve', resolve80, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const code = (args) => curl(['-o', '/dev/null', '-w', '%{http_code}', ...args]).stdout
  const logs = (file) => docker(['exec', nginx, 'cat', `/var/log/nginx/${file}`]).stdout

  before(async () => {
    const sha = fs.readFileSync(`${CONF}.sha256`, 'utf8').split(/\s+/)[0]
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(CONF)).digest('hex'), sha, 'sha256 в репозитории = проверяемый файл')

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-nginx-'))
    const rel = path.join(tmp, 'www', 'osp', 'releases', '1000')
    fs.mkdirSync(path.join(rel, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(rel, 'index.html'), '<html>SITE OK</html>')
    fs.writeFileSync(path.join(rel, 'version.json'), '{"buildId":"1000"}')
    fs.mkdirSync(path.join(tmp, 'www', 'osp', 'assets'))
    fs.mkdirSync(path.join(tmp, 'www', 'osp', 'shared'))
    fs.symlinkSync('releases/1000', path.join(tmp, 'www', 'osp', 'current'))
    const le = path.join(tmp, 'letsencrypt')
    fs.mkdirSync(path.join(le, 'live', 'osp.root.sx'), { recursive: true })
    const ssl = (args) => assert.equal(spawnSync('openssl', args, { stdio: 'ignore' }).status, 0, args.join(' '))
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=osp.root.sx',
      '-keyout', path.join(le, 'live', 'osp.root.sx', 'privkey.pem'), '-out', path.join(le, 'live', 'osp.root.sx', 'fullchain.pem')])
    ssl(['dhparam', '-dsaparam', '-out', path.join(le, 'ssl-dhparams.pem'), '2048'])
    fs.writeFileSync(path.join(le, 'options-ssl-nginx.conf'), 'ssl_session_cache shared:le_nginx_SSL:10m;\nssl_protocols TLSv1.2 TLSv1.3;\n')
    const confD = path.join(tmp, 'conf.d')
    fs.mkdirSync(confD)
    fs.copyFileSync(CONF, path.join(confD, 'osp.root.sx.conf'))
    for (const d of ['www', 'letsencrypt', 'conf.d']) spawnSync('chmod', ['-R', 'a+rX', path.join(tmp, d)])

    const run = docker(['run', '-d', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=0', '-p', '127.0.0.1::443', '-p', '127.0.0.1::80',
      '-v', `${path.join(tmp, 'www')}:/var/www:ro`, '-v', `${confD}:/etc/nginx/conf.d:ro`, '-v', `${le}:/etc/letsencrypt:ro`, NGINX_IMAGE])
    assert.equal(run.status, 0, run.stderr)
    nginx = run.stdout.trim()
    const s = docker(['run', '-d', '--network', `container:${nginx}`, NODE_IMAGE, 'node', '-e', STUB])
    assert.equal(s.status, 0, s.stderr)
    stub = s.stdout.trim()
    const hostPort = (p) => docker(['port', nginx, p]).stdout.trim().split('\n')[0].split(':').pop()
    const port = hostPort('443/tcp')
    const port80 = hostPort('80/tcp')
    resolve = `osp.root.sx:${port}:127.0.0.1`
    resolve80 = `osp.root.sx:${port80}:127.0.0.1`
    base = `https://osp.root.sx:${port}`
    httpBase = `http://osp.root.sx:${port80}`
    for (let i = 0; i < 50 && code([`${base}/api/health`]) !== '200'; i++) await new Promise((r) => setTimeout(r, 200))
  })

  after(() => {
    for (const c of [stub, nginx]) if (c) docker(['rm', '-f', c])
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('nginx -t принимает файл', () => {
    const t = docker(['exec', nginx, 'nginx', '-t'])
    assert.match(t.stderr, /test is successful/)
  })

  it('/api/ уходит в службу (и /api/*.png тоже), X-Forwarded-For доходит; ровно один Cache-Control: no-store', () => {
    const res = curl(['-D', '-', `${base}/api/health`])
    const [head, body] = res.stdout.split('\r\n\r\n')
    assert.match(head, /^HTTP\/1\.1 200/)
    assert.deepEqual(head.match(/^cache-control:.*$/gim).map((h) => h.trim().toLowerCase()), ['cache-control: no-store'])
    const seen = JSON.parse(body)
    assert.equal(seen.stub, true)
    assert.ok(seen.xff, 'X-Forwarded-For передан')
    assert.equal(JSON.parse(curl([`${base}/api/logo.png`]).stdout).url, '/api/logo.png', 'не статика')
  })

  it('сайт по-прежнему из current', () => {
    assert.equal(curl([`${base}/`]).stdout, '<html>SITE OK</html>')
    assert.equal(curl([`${base}/tenders/5`]).stdout, '<html>SITE OK</html>')
    assert.equal(code([`${base}/config.json`]), '404')
  })

  it('ключ из ?key= не попадает в access log', () => {
    assert.equal(code([`${base}/api/rates/kp?key=${KEY}&search=x`]), '200')
    const access = logs('osp-access.log')
    assert.match(access, /"GET \/api\/rates\/kp HTTP\/1\.1" 200/)
    assert.ok(!access.includes(KEY), 'ключ в access log')
  })

  it('тело: 1,5 МБ проходит, больше 2 МБ — 413', () => {
    const f15 = path.join(tmp, 'b15')
    const f25 = path.join(tmp, 'b25')
    fs.writeFileSync(f15, Buffer.alloc(1.5 * 1024 * 1024, 'a'))
    fs.writeFileSync(f25, Buffer.alloc(2.5 * 1024 * 1024, 'a'))
    const ok = curl(['-X', 'POST', '--data-binary', `@${f15}`, `${base}/api/fn/ai-assist`])
    assert.equal(JSON.parse(ok.stdout).bytes, 1.5 * 1024 * 1024)
    assert.equal(code(['-X', 'POST', '--data-binary', `@${f25}`, `${base}/api/fn/ai-assist`]), '413')
  })

  it('всплеск запросов с одного адреса — 429, а не перегрузка службы', () => {
    const r = spawnSync('bash', ['-c',
      `for i in $(seq 1 150); do curl -sk --resolve ${resolve} -o /dev/null -w '%{http_code}\\n' ${base}/api/health & done; wait`],
    { encoding: 'utf8' })
    const codes = r.stdout.trim().split('\n')
    assert.ok(codes.filter((c) => c === '429').length > 0, `нет 429: ${[...new Set(codes)]}`)
    assert.ok(codes.filter((c) => c === '200').length >= 40, 'запас burst пропущен')
  })

  it('HTTP (порт 80): /api/ — 403 без перенаправления, журнал без ключа; сайт перенаправляется как раньше', () => {
    const api = curl(['-D', '-', '-o', '/dev/null', `${httpBase}/api/rates/kp?key=${KEY}`]).stdout
    assert.match(api, /^HTTP\/1\.1 403/)
    assert.ok(!/^location:/im.test(api), 'ключ не возвращается в Location')
    assert.equal(code([`${httpBase}/api?key=${KEY}`]), '403')
    assert.equal(code([`${base}/api?key=${KEY}`]), '404', '/api без слэша по HTTPS')
    const site = curl(['-D', '-', '-o', '/dev/null', `${httpBase}/tenders/5?x=1`]).stdout
    assert.match(site, /^HTTP\/1\.1 301/)
    assert.match(site, /^location: https:\/\/osp\.root\.sx\/tenders\/5\?x=1\r?$/im)
    // Общий журнал образа (/var/log/nginx/access.log) — это stdout контейнера.
    const out = docker(['logs', nginx])
    assert.match(out.stdout, /"GET \/api\/rates\/kp HTTP\/1\.1" 403/)
    assert.ok(!(out.stdout + out.stderr).includes(KEY), 'ключ в журнале порта 80')
    assert.match(logs('osp-access.log'), /"GET \/api HTTP\/1\.1" 404/)
    assert.ok(!logs('osp-access.log').includes(KEY), 'ключ в access log HTTPS')
  })

  it('служба остановлена — /api/ 502, ключ не попадает в error log, сайт работает', () => {
    docker(['kill', stub])
    assert.equal(code([`${base}/api/rates/kp?key=${KEY}`]), '502')
    assert.ok(!logs('osp-error.log').includes(KEY), 'ключ в error log')
    assert.ok(!logs('osp-access.log').includes(KEY), 'ключ в access log')
    assert.equal(curl([`${base}/`]).stdout, '<html>SITE OK</html>')
  })
})
