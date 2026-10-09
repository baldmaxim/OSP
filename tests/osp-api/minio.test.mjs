// s3-presign в osp-api против настоящего S3-сервера (MinIO в Docker, path-style, как cloud.ru):
// подписанные ссылки действительно работают — загрузка PUT, превью и скачивание под исходным именем,
// удаление; подделанная ссылка отклоняется. Без Docker или образа набор пропускается.
// Образ: OSP_MINIO_IMAGE (по умолчанию cgr.dev/chainguard/minio:latest).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeSupabase } from './lib/fakes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const IMAGE = process.env.OSP_MINIO_IMAGE || 'cgr.dev/chainguard/minio:latest'
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' })

function skipReason() {
  if (!fs.existsSync(path.join(SERVER, 'node_modules', 'fastify'))) return 'нет зависимостей: npm ci --prefix server/osp-api'
  if (docker(['version']).status !== 0) return 'нет Docker'
  if (docker(['image', 'inspect', IMAGE]).status !== 0) return `нет образа ${IMAGE}`
  return false
}
const skip = skipReason()

const USER = { token: 'tok-emp', id: '11111111-1111-4111-8111-111111111111' }
const TENDER = 'a0000000-0000-4000-8000-000000000001'
const ACCESS = 'ospminio'
const SECRET = 'ospminio-secret-123'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('osp-api s3-presign против MinIO (настоящая подпись S3)', { skip, timeout: 120000 }, () => {
  let container
  let endpoint
  let supa
  let state
  let app

  const call = async (body) => {
    const res = await app.inject({
      method: 'POST', url: '/api/fn/s3-presign',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${USER.token}` },
      payload: JSON.stringify(body),
    })
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }

  before(async () => {
    const run = docker(['run', '-d', '--rm', '-p', '127.0.0.1::9000', '-e', `MINIO_ROOT_USER=${ACCESS}`, '-e', `MINIO_ROOT_PASSWORD=${SECRET}`, IMAGE, 'server', '/tmp/data'])
    assert.equal(run.status, 0, run.stderr)
    container = run.stdout.trim()
    const port = docker(['port', container, '9000/tcp']).stdout.trim().split('\n')[0].split(':').pop()
    endpoint = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${endpoint}/minio/health/ready`)).ok) break } catch { /* стартует */ }
      await sleep(200)
    }
    const req = createRequire(path.join(SERVER, 'package.json'))
    const { S3Client, CreateBucketCommand } = req('@aws-sdk/client-s3')
    const admin = new S3Client({ endpoint, region: 'ru-central-1', forcePathStyle: true, credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET } })
    await admin.send(new CreateBucketCommand({ Bucket: 'osp' }))

    state = { users: { [USER.token]: { id: USER.id } }, roles: { [USER.id]: { role: 'engineer', counterparty_id: null, is_approved: true } }, docs: {}, myContracts: {}, owners: { tenders: { [TENDER]: 'all' } } }
    supa = await startFakeSupabase(state)
    const { buildApp } = await import(path.join(SERVER, 'src', 'app.js'))
    app = buildApp({
      logger: false,
      config: {
        supabaseUrl: supa.url, supabaseAnonKey: 'anon', supabaseServiceKey: 'service',
        s3: { endpoint, region: 'ru-central-1', bucket: 'osp', accessKeyId: ACCESS, secretAccessKey: SECRET },
        anthropicApiKey: '', ratesApiKeys: [],
      },
    })
    await app.ready()
  })

  after(async () => {
    await app?.close()
    await supa?.close()
    if (container) docker(['rm', '-f', container])
  })

  it('загрузка, превью, скачивание под исходным именем, удаление', async () => {
    const content = 'Акт сверки, строка 1\nстрока 2'
    const up = await call({ action: 'upload', owner_type: 'tender', owner_id: TENDER, file_name: 'Отчёт.txt', mime_type: 'text/plain; charset=utf-8' })
    const put = await fetch(up.presigned_url, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content })
    assert.equal(put.status, 200, await put.text())
    state.docs[up.s3_key] = { row: { id: 'd1', owner_type: 'tender', owner_id: TENDER }, visibleTo: 'all' }

    const preview = await call({ action: 'download', s3_key: up.s3_key })
    const got = await fetch(preview.presigned_url)
    assert.equal(got.status, 200)
    assert.equal(await got.text(), content)
    assert.equal(got.headers.get('content-disposition'), null)

    const dl = await call({ action: 'download', s3_key: up.s3_key, file_name: 'Отчёт.txt', download: true })
    const file = await fetch(dl.presigned_url)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-disposition'), `attachment; filename="Otchet.txt"; filename*=UTF-8''${encodeURIComponent('Отчёт.txt')}`)

    const tampered = new URL(dl.presigned_url)
    tampered.pathname = tampered.pathname.replace('Otchet', 'Other')
    assert.equal((await fetch(tampered)).status, 403, 'подделанная ссылка не принимается')

    assert.deepEqual(await call({ action: 'delete', s3_key: up.s3_key }), { ok: true })
    assert.equal((await fetch(preview.presigned_url)).status, 404, 'файл удалён из хранилища')
  })
})
