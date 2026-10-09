// Фронтовой адаптер своего API (src/api/ospApi.js): тот же ответ { data, error }, что у
// functions.invoke supabase-js, — сервисы s3.js и aiAssist.js работают без изменений, в том числе
// достают текст ошибки из error.context.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { callOspFunction, OSP_API_BASE } from '../../src/api/ospApi.js'
import { nextFeatures, parseFeatures, resolveFeature } from '../../src/config/features.js'
import { createOspFiles, HASH_MAX_BYTES, sha256Hex } from '../../src/api/ospFiles.js'
import { uuidv7 } from '../../src/utils/uuid.js'
import crypto from 'node:crypto'

describe('src/config/features.js — флаги: config.json и браузер', () => {
  it('по умолчанию выключено; config.json true — включено всем', () => {
    assert.equal(resolveFeature('ospApiAi', {}, {}), false)
    assert.equal(resolveFeature('ospApiAi', { ospApiAi: true }, {}), true)
  })
  it('пилот: браузер включает, пока в config.json нет значения или там true', () => {
    assert.equal(resolveFeature('ospApiAi', {}, { ospApiAi: true }), true)
    assert.equal(resolveFeature('ospApiAi', { ospApiAi: true }, { ospApiAi: false }), false, 'браузер может выключить у себя')
  })
  it('явное false в config.json — выключатель для всех, включая пилотные браузеры', () => {
    assert.equal(resolveFeature('ospApiAi', { ospApiAi: false }, { ospApiAi: true }), false)
  })
  it('значения не boolean игнорируются', () => {
    assert.equal(resolveFeature('ospApiAi', { ospApiAi: 'yes' }, { ospApiAi: 1 }), false)
  })
  it('parseFeatures: из config.json — только логические значения', () => {
    assert.deepEqual(parseFeatures({ ospApiAi: true, ospApiFiles: false, x: 'yes', y: 1 }), { ospApiAi: true, ospApiFiles: false })
    for (const bad of [null, undefined, 'str', [true], 5]) assert.deepEqual(parseFeatures(bad), {})
  })
  it('повторное чтение в открытой вкладке: false выключает; файла нет — всё выключено; сбой — прежнее', () => {
    const current = { ospApiAi: true }
    assert.deepEqual(nextFeatures(current, { status: 'ok', raw: { features: { ospApiAi: false } } }), { ospApiAi: false })
    assert.deepEqual(nextFeatures(current, { status: 'ok', raw: { supabaseUrl: 'https://x' } }), {}, 'нет поля features')
    assert.deepEqual(nextFeatures(current, { status: 'absent' }), {})
    assert.equal(nextFeatures(current, { status: 'error' }), current)
    assert.equal(nextFeatures(current, undefined), current)
  })
})

function fakeFetch(respond) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  return { impl, calls }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('src/api/ospApi.js — вызов osp-api как functions.invoke', () => {
  it('POST /api/fn/<имя>, JSON-тело, токен сессии в Authorization', async () => {
    const f = fakeFetch(() => json(200, { ok: true }))
    const res = await callOspFunction('s3-presign', { body: { action: 'download', s3_key: 'k' } }, { getToken: async () => 'tok', fetchImpl: f.impl })
    assert.deepEqual(res, { data: { ok: true }, error: null })
    assert.equal(f.calls[0].url, `${OSP_API_BASE}/fn/s3-presign`)
    assert.equal(f.calls[0].init.method, 'POST')
    assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok')
    assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { action: 'download', s3_key: 'k' })
  })

  it('без сессии — без заголовка Authorization (сервер ответит 401)', async () => {
    for (const getToken of [async () => null, async () => { throw new Error('нет сессии') }, undefined]) {
      const f = fakeFetch(() => json(401, { error: 'Unauthorized' }))
      await callOspFunction('ai-assist', { body: {} }, { getToken, fetchImpl: f.impl })
      assert.equal(f.calls[0].init.headers.Authorization, undefined)
    }
  })

  it('ответ не 2xx — error.context с телом, как у FunctionsHttpError (s3.js достаёт текст)', async () => {
    const f = fakeFetch(() => json(404, { error: 'Файл не найден' }))
    const { data, error } = await callOspFunction('s3-presign', { body: {} }, { getToken: async () => 't', fetchImpl: f.impl })
    assert.equal(data, null)
    assert.equal(error.name, 'FunctionsHttpError')
    assert.equal(error.message, 'Edge Function returned a non-2xx status code')
    // тот же разбор, что в services/s3.js и services/aiAssist.js
    const body = await error.context.clone().json()
    assert.equal(body.error, 'Файл не найден')
    assert.equal(error.context.status, 404)
  })

  it('сбой сети — error без context, понятное сообщение', async () => {
    const f = fakeFetch(() => { throw new TypeError('Failed to fetch') })
    const { data, error } = await callOspFunction('ai-assist', { body: {} }, { getToken: async () => 't', fetchImpl: f.impl })
    assert.equal(data, null)
    assert.equal(error.name, 'FunctionsFetchError')
    assert.match(error.message, /Сервер недоступен: Failed to fetch/)
    assert.equal(error.context, undefined)
  })

  it('2xx, но не JSON — ошибка, а не падение', async () => {
    const f = fakeFetch(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const { data, error } = await callOspFunction('s3-presign', { body: {} }, { getToken: async () => 't', fetchImpl: f.impl })
    assert.equal(data, null)
    assert.equal(error.name, 'FunctionsHttpError')
  })
})

describe('src/api/ospFiles.js — загрузка с ключом операции (заход Б)', () => {
  const DOC = { id: 'op-1', s3_key: 'tenders/t/op-1-a.pdf', file_name: 'a.pdf' }
  const httpError = (status, body) => ({
    data: null,
    error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { name: 'FunctionsHttpError', context: json(status, body) }),
  })
  const networkError = () => ({ data: null, error: Object.assign(new Error('Сервер недоступен: Failed to fetch'), { name: 'FunctionsFetchError' }) })

  // Сценарий сервера: на каждое действие — очередь ответов (последний повторяется).
  function setup(script, { putStatuses = [200] } = {}) {
    const calls = []
    const puts = []
    let ids = 0
    const files = createOspFiles({
      call: async (body) => {
        calls.push(body)
        const queue = script[body.action]
        const next = queue.length > 1 ? queue.shift() : queue[0]
        return typeof next === 'function' ? next(body) : next
      },
      fetchImpl: async (url, init) => {
        puts.push({ url, init })
        const status = putStatuses.length > 1 ? putStatuses.shift() : putStatuses[0]
        if (status === 'network') throw new TypeError('Failed to fetch')
        return new Response('', { status })
      },
      digest: async () => 'f'.repeat(64),
      newId: () => `op-${++ids}`,
      sleep: async () => {},
    })
    return { files, calls, puts }
  }
  const file = new Blob(['hello'], { type: 'application/pdf' })
  file.name = 'a.pdf'
  const presigned = { data: { s3_key: DOC.s3_key, presigned_url: 'https://s3.test/put', expires_in: 900 }, error: null }

  it('один ключ операции на все шаги; отпечаток с sha256; результат — строка из confirm', async () => {
    const { files, calls, puts } = setup({ upload: [presigned], confirm: [{ data: { document: DOC }, error: null }] })
    const doc = await files.upload({ file, ownerType: 'tender', ownerId: 't', category: 'vor', notes: 'n' })
    assert.deepEqual(doc, DOC)
    assert.deepEqual(calls.map((c) => c.action), ['upload', 'confirm'])
    assert.ok(calls.every((c) => c.operation_id === 'op-1'))
    assert.deepEqual(calls[0], { action: 'upload', operation_id: 'op-1', owner_type: 'tender', owner_id: 't', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 5, sha256: 'f'.repeat(64) })
    assert.equal(calls[1].category, 'vor')
    assert.equal(calls[1].notes, 'n')
    assert.equal(puts.length, 1)
    assert.equal(puts[0].init.method, 'PUT')
    assert.equal(puts[0].init.headers['Content-Type'], 'application/pdf')
  })

  it('PUT упал дважды (сеть, истёкшая ссылка) — новая ссылка на тот же ключ, третья попытка', async () => {
    const { files, calls, puts } = setup({ upload: [presigned], confirm: [{ data: { document: DOC }, error: null }] }, { putStatuses: ['network', 403, 200] })
    assert.deepEqual(await files.upload({ file, ownerType: 'tender', ownerId: 't' }), DOC)
    assert.equal(puts.length, 3)
    assert.deepEqual(calls.map((c) => c.action), ['upload', 'upload', 'upload', 'confirm'])
    assert.ok(calls.every((c) => c.operation_id === 'op-1'), 'ключ тот же')
  })

  it('PUT не прошёл три раза — ошибка, подтверждения нет', async () => {
    const { files, calls } = setup({ upload: [presigned], confirm: [] }, { putStatuses: [500] })
    await assert.rejects(files.upload({ file, ownerType: 'tender', ownerId: 't' }), /S3 PUT не удался \(500/)
    assert.ok(!calls.some((c) => c.action === 'confirm'))
  })

  it('confirm: потерянные ответы и «ещё не в хранилище» — повтор с тем же ключом, та же строка', async () => {
    const { files, calls } = setup({
      upload: [presigned],
      confirm: [networkError(), httpError(409, { error: 'Файла ещё нет', code: 'OSP_NOT_UPLOADED' }), { data: { already: true, document: DOC }, error: null }],
    })
    assert.deepEqual(await files.upload({ file, ownerType: 'tender', ownerId: 't' }), DOC)
    const confirms = calls.filter((c) => c.action === 'confirm')
    assert.equal(confirms.length, 3)
    assert.ok(confirms.every((c) => c.operation_id === 'op-1'))
  })

  it('upload вернул already — документ этой операции уже есть: без PUT и confirm', async () => {
    const { files, calls, puts } = setup({ upload: [{ data: { already: true, document: DOC }, error: null }], confirm: [] })
    assert.deepEqual(await files.upload({ file, ownerType: 'tender', ownerId: 't' }), DOC)
    assert.equal(puts.length, 0)
    assert.deepEqual(calls.map((c) => c.action), ['upload'])
  })

  it('отказ по правам, владелец не найден, чужой ключ — сразу ошибка с текстом сервера, без повторов', async () => {
    for (const [status, body] of [[403, { error: 'Нет права на файлы этого раздела' }], [404, { error: 'Владелец файла не найден' }], [409, { error: 'Этот ключ операции уже использован для другого файла', code: 'OSP_KEY_REUSE' }]]) {
      const { files, calls } = setup({ upload: [httpError(status, body)], confirm: [] })
      await assert.rejects(files.upload({ file, ownerType: 'tender', ownerId: 't' }), (err) => {
        assert.equal(err.message, body.error)
        assert.equal(err.status, status)
        return true
      })
      assert.equal(calls.length, 1, `${status}: без повтора`)
    }
  })

  it('удаление: сбой сервера — повтор (сервер идемпотентен); 403 — сразу', async () => {
    const flaky = setup({ delete: [httpError(502, { error: 'Bad gateway' }), { data: { ok: true }, error: null }] })
    assert.deepEqual(await flaky.files.remove('k'), { ok: true })
    assert.deepEqual(flaky.calls, [{ action: 'delete', s3_key: 'k' }, { action: 'delete', s3_key: 'k' }])
    const denied = setup({ delete: [httpError(403, { error: 'Нет права на файлы этого раздела' })] })
    await assert.rejects(denied.files.remove('k'), /Нет права/)
    assert.equal(denied.calls.length, 1)
  })

  it('скачивание — ссылка как у функции: download и file_name только когда заданы', async () => {
    const { files, calls } = setup({ download: [{ data: { presigned_url: 'https://s3.test/get', expires_in: 3600 }, error: null }] })
    await files.downloadUrl('k')
    await files.downloadUrl('k', { fileName: 'План.pdf', download: true })
    assert.deepEqual(calls, [{ action: 'download', s3_key: 'k' }, { action: 'download', s3_key: 'k', download: true, file_name: 'План.pdf' }])
  })

  it('файл крупнее HASH_MAX_BYTES — без sha256 (не читаем целиком в память)', async () => {
    let hashed = false
    const files = createOspFiles({
      call: async (body) => (body.action === 'upload' ? presigned : { data: { document: DOC }, error: null }),
      fetchImpl: async () => new Response('', { status: 200 }),
      digest: async () => { hashed = true; return 'f'.repeat(64) },
      newId: () => 'op-big',
      sleep: async () => {},
    })
    const big = { name: 'big.zip', type: '', size: HASH_MAX_BYTES + 1 }
    assert.deepEqual(await files.upload({ file: big, ownerType: 'tender', ownerId: 't' }), DOC)
    assert.equal(hashed, false)
  })

  it('sha256Hex — как у node:crypto', async () => {
    const blob = new Blob(['Акт сверки'])
    assert.equal(await sha256Hex(blob), crypto.createHash('sha256').update('Акт сверки').digest('hex'))
  })
})

describe('src/utils/uuid.js — uuidv7', () => {
  it('формат UUID, версия 7, вариант RFC; время — в начале, по возрастанию', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    for (const id of [a, b]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(parseInt(a.replace(/-/g, '').slice(0, 12), 16), 1_700_000_000_000)
    assert.ok(a < b)
    assert.equal(new Set(Array.from({ length: 1000 }, () => uuidv7())).size, 1000)
  })
})

