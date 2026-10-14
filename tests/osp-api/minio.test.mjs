// s3-presign в osp-api против настоящего S3-сервера (MinIO в Docker, path-style, как cloud.ru):
// подписанные ссылки действительно работают — загрузка PUT, превью и скачивание под исходным именем,
// удаление; подделанная ссылка отклоняется. Загрузка с ключом операции (заход Б): повтор PUT и
// подтверждения — один объект и одна строка; чужой отпечаток — 409; удаление — строка и объект,
// повтор безопасен. Обложки объектов (src/routes/covers.js, src/lib/covers.js): ссылка на загрузку
// принимает только заявленный тип изображения, показ по /api/covers/<имя> отдаёт файл, копирование из
// хранилища Supabase сверяет каждый файл и повтор ничего не перезаписывает. Без Docker или образа набор
// пропускается.
// Образ: OSP_MINIO_IMAGE (по умолчанию cgr.dev/chainguard/minio:latest).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
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
const OP = '0190a000-0000-7000-8000-000000000001'
const ACCESS = 'ospminio'
const SECRET = 'ospminio-secret-123'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('osp-api s3-presign против MinIO (настоящая подпись S3)', { skip, timeout: 120000 }, () => {
  let container
  let endpoint
  let supa
  let state
  let app

  let listKeys
  const send = (body) => app.inject({
    method: 'POST', url: '/api/fn/s3-presign',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${USER.token}` },
    payload: JSON.stringify(body),
  })
  const call = async (body) => {
    const res = await send(body)
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
    const { ListObjectsV2Command } = req('@aws-sdk/client-s3')
    listKeys = async (prefix) => ((await admin.send(new ListObjectsV2Command({ Bucket: 'osp', Prefix: prefix }))).Contents || []).map((o) => o.Key)

    state = {
      users: { [USER.token]: { id: USER.id } },
      roles: { [USER.id]: { role: 'engineer', counterparty_id: null, is_approved: true, is_blocked: false, full_name: 'Инженер' } },
      docs: {}, myContracts: {}, can: { [USER.id]: ['tenders:view', 'objects:edit'] }, owners: { tenders: { [TENDER]: 'all' } },
    }
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

  it('загрузка с повторами, превью, скачивание под исходным именем, удаление', async () => {
    const content = 'Акт сверки, строка 1\nстрока 2'
    const file = {
      operation_id: OP, owner_type: 'tender', owner_id: TENDER, file_name: 'Отчёт.txt', mime_type: 'text/plain; charset=utf-8',
      size_bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex'),
    }
    // Повтор загрузки до подтверждения (потерян ответ PUT): тот же ключ — один объект.
    for (let i = 0; i < 2; i++) {
      const up = await call({ action: 'upload', ...file })
      const put = await fetch(up.presigned_url, { method: 'PUT', headers: { 'Content-Type': file.mime_type }, body: content })
      assert.equal(put.status, 200, await put.text())
    }
    const prefix = `tenders/${TENDER}/`
    assert.deepEqual(await listKeys(prefix), [`${prefix}${OP}-Otchet.txt`])
    const { document } = await call({ action: 'confirm', ...file })
    const up = { s3_key: document.s3_key }
    assert.equal(document.id, OP)
    assert.deepEqual(await call({ action: 'confirm', ...file }), { already: true, document }, 'повтор подтверждения')
    assert.deepEqual(await call({ action: 'upload', ...file }), { already: true, document }, 'повтор загрузки')
    const reuse = await send({ action: 'confirm', ...file, size_bytes: file.size_bytes + 1 })
    assert.equal(reuse.statusCode, 409)
    assert.equal(reuse.json().code, 'OSP_KEY_REUSE')
    assert.equal(Object.keys(state.docs).length, 1, 'одна строка')

    const preview = await call({ action: 'download', s3_key: up.s3_key })
    const got = await fetch(preview.presigned_url)
    assert.equal(got.status, 200)
    assert.equal(await got.text(), content)
    assert.equal(got.headers.get('content-disposition'), null)

    const dl = await call({ action: 'download', s3_key: up.s3_key, file_name: 'Отчёт.txt', download: true })
    const saved = await fetch(dl.presigned_url)
    assert.equal(saved.status, 200)
    assert.equal(saved.headers.get('content-disposition'), `attachment; filename="Otchet.txt"; filename*=UTF-8''${encodeURIComponent('Отчёт.txt')}`)

    const tampered = new URL(dl.presigned_url)
    tampered.pathname = tampered.pathname.replace('Otchet', 'Other')
    assert.equal((await fetch(tampered)).status, 403, 'подделанная ссылка не принимается')

    assert.deepEqual(await call({ action: 'delete', s3_key: up.s3_key }), { ok: true })
    assert.equal((await fetch(preview.presigned_url)).status, 404, 'файл удалён из хранилища')
    assert.deepEqual(state.docs, {}, 'строка удалена')
    assert.deepEqual(await listKeys(prefix), [])
    assert.deepEqual(await call({ action: 'delete', s3_key: up.s3_key }), { ok: true, already: true }, 'повтор удаления')
  })

  it('обложка: PUT по ссылке — только с заявленным типом; показ /api/covers/<имя> отдаёт файл', async () => {
    const name = '0f0e0d0c-0b0a-4908-8706-050403020100.png'
    const content = Buffer.from('png-обложка')
    const res = await app.inject({
      method: 'POST', url: '/api/fn/cover-upload',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${USER.token}` },
      payload: JSON.stringify({ name, mime_type: 'image/png', size_bytes: content.length }),
    })
    assert.equal(res.statusCode, 200, res.body)
    const { presigned_url: url } = res.json()
    const wrong = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: '<script>1</script>' })
    assert.equal(wrong.status, 403, 'другой тип файла — подпись не сходится')
    assert.deepEqual(await listKeys('covers/'), [])
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: content })
    assert.equal(put.status, 200, await put.text())
    const view = await app.inject({ method: 'GET', url: `/api/covers/${name}` })
    assert.equal(view.statusCode, 302)
    const got = await fetch(view.headers.location)
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('content-type'), 'image/png')
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(content))
  })

  it('копирование обложек из хранилища Supabase: сверка обратным скачиванием, повтор без загрузки', async () => {
    const { copyCovers } = await import(path.join(SERVER, 'src', 'lib', 'covers.js'))
    const { defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    const files = { 'bbbbbbbb-0000-4000-8000-000000000001.jpg': Buffer.from('jpeg из Supabase') }
    const fetchImpl = async (url) => {
      const body = files[decodeURIComponent(url.split('/').pop())]
      return body ? new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } }) : new Response('{}', { status: 404 })
    }
    const listBytes = Buffer.from(`name,size,mimetype,created_at,updated_at\nbbbbbbbb-0000-4000-8000-000000000001.jpg,${files['bbbbbbbb-0000-4000-8000-000000000001.jpg'].length},image/jpeg,,\n`)
    const s3 = defaultDeps.createS3({ endpoint, region: 'ru-central-1', bucket: 'osp', accessKeyId: ACCESS, secretAccessKey: SECRET })
    const first = await copyCovers({ listBytes, sourceBase: 'https://ref.supabase.co/storage/v1/object/public/object-photos/', s3, bucket: 'osp', fetchImpl })
    assert.deepEqual(first.files.map((f) => [f.status, f.uploaded, f.content_type]), [['verified', true, 'image/jpeg']])
    const again = await copyCovers({ listBytes, sourceBase: 'https://ref.supabase.co/storage/v1/object/public/object-photos/', s3, bucket: 'osp', fetchImpl })
    assert.deepEqual(again.files.map((f) => [f.status, f.uploaded]), [['verified', false]])
    assert.ok((await listKeys('covers/')).includes('covers/bbbbbbbb-0000-4000-8000-000000000001.jpg'))
  })

  it('подтверждение без загруженного объекта — 409, строки нет', async () => {
    const res = await send({ action: 'confirm', operation_id: '0190a000-0000-7000-8000-000000000002', owner_type: 'tender', owner_id: TENDER, file_name: 'a.txt', mime_type: 'text/plain', size_bytes: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().code, 'OSP_NOT_UPLOADED')
    assert.deepEqual(state.docs, {})
  })
})
