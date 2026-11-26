// Фронтовой адаптер своего API (src/api/ospApi.js): тот же ответ { data, error }, что у
// functions.invoke supabase-js, — сервисы s3.js и aiAssist.js работают без изменений, в том числе
// достают текст ошибки из error.context.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { callOspFunction, OSP_API_BASE } from '../../src/api/ospApi.js'
import { nextFeatures, parseFeatures, resolveFeature } from '../../src/config/features.js'
import { createOspFiles, HASH_MAX_BYTES, sha256Hex } from '../../src/api/ospFiles.js'
import { afterSentMs, createStoragePut, StorageStalledError } from '../../src/api/storagePut.js'
import { functionPath, filesPath, coversPath, coverThumbUrl, coverUrl, DATA_BOUND_FUNCTIONS, OSP_API_FLAG, OSP_FILES_FLAG } from '../../src/api/serverPath.js'
import { createOspCovers } from '../../src/api/ospCovers.js'
import { uuidv7 } from '../../src/utils/uuid.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

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

describe('src/api/serverPath.js — файлы и ИИ: свой API или функции Supabase', () => {
  const flags = (on) => (name) => on.includes(name)

  it('данные в Supabase: каждая часть — по своему флагу, как раньше', () => {
    assert.equal(functionPath('ai-assist', { ownDb: false, enabled: flags([]) }), 'supabase')
    assert.equal(functionPath('ai-assist', { ownDb: false, enabled: flags(['ospApiAi']) }), 'osp')
    assert.equal(functionPath('s3-presign', { ownDb: false, enabled: flags(['ospApiAi', OSP_FILES_FLAG]) }), 'supabase', 'прежний протокол файлов — функция')
    assert.equal(filesPath({ ownDb: false, enabled: flags([]), hasDigest: true }), 'supabase')
    assert.equal(filesPath({ ownDb: false, enabled: flags([OSP_FILES_FLAG]), hasDigest: true }), 'osp')
    assert.equal(filesPath({ ownDb: false, enabled: flags([OSP_FILES_FLAG]), hasDigest: false }), 'supabase', 'без SubtleCrypto — прежний путь')
  })

  // Функция файлов Supabase удаляет объект из хранилища по строке СВОЕЙ базы: при данных в базе Яндекса
  // это был бы файл, на который ссылается другая база. Поэтому при ospDb файлы — только через свой API.
  it('данные в базе Яндекса (ospDb): функция файлов Supabase не вызывается ни при каких флагах', () => {
    assert.deepEqual(DATA_BOUND_FUNCTIONS, ['s3-presign'])
    for (const on of [[], ['ospApiAi'], [OSP_FILES_FLAG], ['ospApiAi', OSP_FILES_FLAG]]) {
      for (const hasDigest of [true, false]) assert.equal(filesPath({ ownDb: true, enabled: flags(on), hasDigest }), 'osp')
      // Прежний протокол файлов (в т.ч. удаление объекта после неудачной вставки строки) — отказ.
      assert.equal(functionPath('s3-presign', { ownDb: true, enabled: flags(on) }), 'refuse')
    }
  })

  // ИИ базу не читает и хранилище не трогает: недоступен Anthropic с сервера портала — ИИ остаётся на
  // функции Supabase и после переноса данных.
  it('ИИ идёт по своему флагу и при данных в базе Яндекса', () => {
    assert.equal(functionPath('ai-assist', { ownDb: true, enabled: flags([]) }), 'supabase')
    assert.equal(functionPath('ai-assist', { ownDb: true, enabled: flags([OSP_FILES_FLAG]) }), 'supabase')
    assert.equal(functionPath('ai-assist', { ownDb: true, enabled: flags(['ospApiAi']) }), 'osp')
  })

  it('имя функции — не ключ объекта: служебные имена не дают «свой API»', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(functionPath(name, { ownDb: false, enabled: () => true }), 'supabase', name)
    }
    assert.deepEqual(Object.keys(OSP_API_FLAG), ['ai-assist'])
  })

  // Правило выше работает, только если мимо него функцию Supabase вызвать нельзя.
  it('функции Supabase вызываются в одном месте портала — после решения serverPath', () => {
    const files = fs.readdirSync(SRC, { recursive: true }).filter((f) => /\.(js|jsx)$/.test(f)).map((f) => f.split(path.sep).join('/'))
    const callers = files.filter((f) => /\.functions\b/.test(fs.readFileSync(path.join(SRC, f), 'utf8')))
    assert.deepEqual(callers, ['api/functions.js'])
    const code = fs.readFileSync(path.join(SRC, 'api', 'functions.js'), 'utf8')
    assert.equal(code.split('supabase.functions').length - 1, 1, 'один вызов')
    assert.match(code, /functionPath\(name, \{ ownDb: ownDbEnabled\(\), enabled: isFeatureEnabled \}\)/)
    assert.match(code, /filesPath\(\{\s*ownDb: ownDbEnabled\(\),/)
    assert.ok(code.indexOf("path === 'refuse'") < code.indexOf('supabase.functions'), 'отказ решается до вызова функции')
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

  // 19.11.2026: загрузка в «Должную осмотрительность» «зависала» — шаги загрузки ждут ответа не дольше timeoutMs.
  it('timeoutMs: сервер молчит — запрос обрывается сбоем сети (загрузка его повторит); без него — сигнала нет', async () => {
    let seen = null
    const hang = async (_url, init) => {
      seen = init.signal
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    const { data, error } = await callOspFunction('s3-presign', { body: {}, timeoutMs: 30 }, { getToken: async () => 't', fetchImpl: hang })
    assert.equal(data, null)
    assert.equal(error.name, 'FunctionsFetchError')
    assert.equal(error.message, 'Сервер не ответил за 0 с')
    assert.equal(error.context, undefined, 'как сбой сети — ospFiles повторяет')
    assert.equal(seen.aborted, true)
    const f = fakeFetch(() => json(200, { ok: true }))
    assert.deepEqual(await callOspFunction('ai-assist', { body: {} }, { getToken: async () => 't', fetchImpl: f.impl }), { data: { ok: true }, error: null })
    assert.equal(f.calls[0].init.signal, undefined)
    // Повисло и получение токена (продление сессии) — тоже в пределе; запрос не уходит.
    const g = fakeFetch(() => json(200, { ok: true }))
    const stuck = await callOspFunction('s3-presign', { body: {}, timeoutMs: 30 }, { getToken: () => new Promise(() => {}), fetchImpl: g.impl })
    assert.equal(stuck.error.message, 'Сервер не ответил за 0 с')
    assert.equal(g.calls.length, 0)
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
    assert.deepEqual(calls[0], { action: 'upload', operation_id: 'op-1', owner_type: 'tender', owner_id: 't', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 5, sha256: 'f'.repeat(64), category: 'vor' })
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

  it('переименование: ответ — строка документа; сбой сервера — повтор; отказ по правам — сразу', async () => {
    const row = { id: 'd1', file_name: 'Новое.pdf' }
    const flaky = setup({ rename: [httpError(502, { error: 'Bad gateway' }), { data: { document: row }, error: null }] })
    assert.deepEqual(await flaky.files.rename('k', 'Новое.pdf'), row)
    assert.deepEqual(flaky.calls[1], { action: 'rename', s3_key: 'k', file_name: 'Новое.pdf' })
    const denied = setup({ rename: [httpError(403, { error: 'Нет права на файлы этого раздела' })] })
    await assert.rejects(denied.files.rename('k', 'Новое.pdf'), /Нет права/)
    assert.equal(denied.calls.length, 1)
  })

  it('описание файла: ответ — строка документа; сбой сервера — повтор; отказ по правам — сразу', async () => {
    const row = { id: 'd1', notes: 'КП' }
    const flaky = setup({ describe: [httpError(502, { error: 'Bad gateway' }), { data: { document: row }, error: null }] })
    assert.deepEqual(await flaky.files.describe('k', 'КП'), row)
    assert.deepEqual(flaky.calls[1], { action: 'describe', s3_key: 'k', notes: 'КП' })
    const denied = setup({ describe: [httpError(403, { error: 'Нет права на файлы этого раздела' })] })
    await assert.rejects(denied.files.describe('k', 'КП'), /Нет права/)
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

  it('ход загрузки: подготовка → отправка (через putImpl) → подтверждение; папка с датой — в confirm', async () => {
    const calls = []
    const stages = []
    const files = createOspFiles({
      call: async (body) => {
        calls.push(body)
        return body.action === 'upload' ? presigned : { data: { document: DOC }, error: null }
      },
      fetchImpl: async () => { throw new Error('fetch не должен вызываться — есть putImpl') },
      putImpl: async (url, { body, contentType, onProgress }) => {
        assert.equal(url, 'https://s3.test/put')
        assert.equal(contentType, 'application/pdf')
        onProgress(2)
        onProgress(body.size)
        return { ok: true, status: 200, statusText: 'OK' }
      },
      digest: async () => 'f'.repeat(64),
      newId: () => 'op-1',
      sleep: async () => {},
    })
    await files.upload({ file, ownerType: 'counterparty', ownerId: 'c', category: 'other', folderDate: '2025-03-14', onProgress: (p) => stages.push([p.stage, p.loaded, p.total]) })
    assert.deepEqual(stages, [['prepare', 0, 5], ['send', 0, 5], ['send', 2, 5], ['send', 5, 5], ['save', 5, 5]])
    assert.equal(calls[1].folder_date, '2025-03-14')
    assert.equal('folder_date' in calls[0], false, 'ссылка на загрузку — без папки')
    await files.upload({ file, ownerType: 'counterparty', ownerId: 'c' })
    assert.equal('folder_date' in calls[3], false, 'без папки поле не отправляется (прежний сервер)')
  })

  it('версии (20270307): version_of — только в подтверждении и только если выбран; version — файл и версия чего (null — самостоятельный)', async () => {
    const calls = []
    const files = createOspFiles({
      call: async (body) => {
        calls.push(body)
        return body.action === 'upload' ? presigned : { data: { document: DOC }, error: null }
      },
      fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK' }),
      digest: async () => 'f'.repeat(64),
      newId: () => 'op-1',
      sleep: async () => {},
    })
    await files.upload({ file, ownerType: 'tender', ownerId: 't', category: 'vor_statement', versionOf: 'doc-prev' })
    assert.deepEqual(calls.map((c) => c.action), ['upload', 'confirm'])
    assert.equal('version_of' in calls[0], false, 'ссылка на загрузку — без версии')
    assert.equal(calls[1].version_of, 'doc-prev')
    await files.upload({ file, ownerType: 'tender', ownerId: 't', category: 'vor_statement' })
    assert.equal('version_of' in calls[3], false, 'без версии поле не отправляется (прежний сервер)')
    calls.length = 0
    assert.deepEqual(await files.version('doc-a', 'doc-b'), DOC)
    assert.deepEqual(await files.version('doc-a', null), DOC)
    assert.deepEqual(calls, [
      { action: 'version', document_id: 'doc-a', version_of: 'doc-b' },
      { action: 'version', document_id: 'doc-a', version_of: null },
    ])
  })

  it('отправка встала (сторож) — новая ссылка и повтор; после попыток — «Хранилище не отвечает»', async () => {
    const calls = []
    let puts = 0
    const stalled = () => Object.assign(new Error('Хранилище не отвечает: отправка стоит больше 60 с'), { name: 'StorageStalledError', network: true })
    const make = (okAt) => createOspFiles({
      call: async (body) => { calls.push(body.action); return body.action === 'upload' ? presigned : { data: { document: DOC }, error: null } },
      fetchImpl: async () => { throw new Error('не вызывается') },
      putImpl: async () => { puts++; if (puts < okAt) throw stalled(); return { ok: true, status: 200, statusText: 'OK' } },
      digest: async () => 'f'.repeat(64),
      newId: () => 'op-1',
      sleep: async () => {},
    })
    const sends = []
    assert.deepEqual(await make(2).upload({ file, ownerType: 'tender', ownerId: 't', onProgress: (p) => { if (p.stage === 'send') sends.push(`${p.attempt}/${p.attempts}`) } }), DOC)
    assert.deepEqual(calls, ['upload', 'upload', 'confirm'])
    assert.deepEqual(sends, ['1/3', '2/3'], 'номер попытки — на кнопку («попытка 2 из 3»)')
    puts = 0
    calls.length = 0
    await assert.rejects(make(99).upload({ file, ownerType: 'tender', ownerId: 't' }), /Хранилище не отвечает: отправка стоит больше 60 с/)
    assert.equal(puts, 3)
    assert.deepEqual(calls, ['upload', 'upload', 'upload'], 'подтверждения нет')
  })

  it('sha256Hex — как у node:crypto', async () => {
    const blob = new Blob(['Акт сверки'])
    assert.equal(await sha256Hex(blob), crypto.createHash('sha256').update('Акт сверки').digest('hex'))
  })
})

describe('src/api/storagePut.js — отправка в хранилище с ходом и сторожем', () => {
  // Поддельный XMLHttpRequest: тест сам решает, когда прийти ходу и ответу. Таймеры — ручные.
  function setup() {
    const timers = new Map()
    let nextTimer = 0
    const xhrs = []
    class FakeXHR {
      constructor() { this.upload = {}; this.headers = {}; this.aborted = false; xhrs.push(this) }
      open(method, url) { this.method = method; this.url = url }
      setRequestHeader(k, v) { this.headers[k] = v }
      send(body) { this.body = body }
      abort() { this.aborted = true; this.onabort?.() }
    }
    const put = createStoragePut({
      XHR: FakeXHR,
      setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id },
      clearTimer: (id) => timers.delete(id),
    })
    const fire = () => { const [id, t] = [...timers.entries()].at(-1); timers.delete(id); t.fn() }
    return { put, xhrs, timers, fire }
  }
  const body = new Blob(['hello world'])

  it('PUT с типом файла; ход — от 0 до размера; ответ — { ok, status, statusText }', async () => {
    const { put, xhrs, timers } = setup()
    const seen = []
    const p = put('https://s3.test/put', { body, contentType: 'application/pdf', onProgress: (l, t) => seen.push([l, t]) })
    const x = xhrs[0]
    assert.equal(x.method, 'PUT')
    assert.equal(x.headers['Content-Type'], 'application/pdf')
    assert.equal(x.body, body)
    x.upload.onprogress({ loaded: 6, total: 11, lengthComputable: true })
    Object.assign(x, { status: 200, statusText: 'OK' })
    x.onload()
    assert.deepEqual(await p, { ok: true, status: 200, statusText: 'OK' })
    assert.deepEqual(seen, [[0, 11], [6, 11]])
    assert.equal(timers.size, 0, 'сторож снят')
  })

  it('нет движения stallMs — обрыв: StorageStalledError с network (повторяется), запрос прерван', async () => {
    const { put, xhrs, timers, fire } = setup()
    const p = put('https://s3.test/put', { body, stallMs: 90000 })
    assert.equal([...timers.values()].at(-1).ms, 90000)
    xhrs[0].upload.onprogress({ loaded: 3, total: 11, lengthComputable: true })
    assert.equal(timers.size, 1, 'ход переставляет сторожа, а не копит')
    fire()
    await assert.rejects(p, (e) => e instanceof StorageStalledError && e.network === true && /больше 90 с/.test(e.message))
    assert.equal(xhrs[0].aborted, true)
  })

  it('файл отправлен целиком — ответа ждём дольше: не меньше stallMs и секунда на 256 КБ (прокси может держать файл)', async () => {
    const { put, xhrs, timers } = setup()
    const big = { size: 100 * 1024 * 1024 }
    put('https://s3.test/put', { body: big, stallMs: 60000 })
    xhrs[0].upload.onprogress({ loaded: 50 * 1024 * 1024, total: big.size, lengthComputable: true })
    assert.equal([...timers.values()].at(-1).ms, 60000, 'пока идёт — обычный сторож')
    xhrs[0].upload.onprogress({ loaded: big.size, total: big.size, lengthComputable: true })
    assert.equal([...timers.values()].at(-1).ms, 400000, '100 МБ — 400 с')
    assert.equal(afterSentMs(1024, 60000), 60000, 'маленький файл — не меньше stallMs')
  })

  it('сбой сети и ответ 403 — как у fetch: ошибка с network и { ok: false }', async () => {
    const { put, xhrs } = setup()
    const failed = put('https://s3.test/put', { body })
    xhrs[0].onerror()
    await assert.rejects(failed, (e) => e.network === true)
    const denied = put('https://s3.test/put', { body })
    Object.assign(xhrs[1], { status: 403, statusText: 'Forbidden' })
    xhrs[1].onload()
    assert.deepEqual(await denied, { ok: false, status: 403, statusText: 'Forbidden' })
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

describe('src/api/ospCovers.js и files.js — обложки объектов', () => {
  const NAME = '0f0e0d0c-0b0a-4908-8706-050403020100.jpg'
  const file = { name: 'фото.JPG', type: 'image/jpeg', size: 1234 }
  const httpError = (status, body) => {
    const error = new Error('Edge Function returned a non-2xx status code')
    error.context = new Response(JSON.stringify(body), { status })
    return { data: null, error }
  }

  it('миниатюра — только у обложек своего API; адрес бакета Supabase и пустой не меняются', () => {
    assert.equal(coverThumbUrl(coverUrl(NAME)), `/api/covers/${NAME}/thumb`)
    const supabase = `https://x.supabase.co/storage/v1/object/public/object-photos/${NAME}`
    assert.equal(coverThumbUrl(supabase), supabase)
    assert.equal(coverThumbUrl(''), '')
    assert.equal(coverThumbUrl(null), null)
    assert.equal(coverThumbUrl('/api/covers/'), '/api/covers/')
    assert.equal(coverThumbUrl(`/api/covers/${NAME}/thumb`), `/api/covers/${NAME}/thumb`, 'дважды не дописывается')
  })

  it('данные в базе Яндекса — обложки через свой API, адрес /api/covers/<имя>; в Supabase — прежний бакет', () => {
    assert.equal(coversPath({ ownDb: true }), 'osp')
    assert.equal(coversPath({ ownDb: false }), 'supabase')
    assert.equal(coverUrl(NAME), `/api/covers/${NAME}`)
    // Адаптер помнит, куда ушла загрузка: адрес — того же хранилища, даже если флаг сменился.
    const adapter = fs.readFileSync(path.join(SRC, 'api', 'files.js'), 'utf8')
    assert.match(adapter, /uploadedTo\.set\(path, where\)/)
    assert.match(adapter, /uploadedTo\.get\(path\) \|\| coversPath/)
    // Страница объектов работает только через адаптер — её код не меняется.
    const page = fs.readFileSync(path.join(SRC, 'pages', 'ObjectsPage.jsx'), 'utf8')
    assert.match(page, /objectPhotos\.upload\(fileName, file/)
    assert.match(page, /objectPhotos\.publicUrl\(fileName\)/)
  })

  it('загрузка: ссылка → PUT с типом файла; ответ как у storage.upload', async () => {
    const calls = []
    const puts = []
    const covers = createOspCovers({
      call: async (body) => { calls.push(body); return { data: { presigned_url: 'https://s3.test/osp/covers/x?sig', url: `/api/covers/${NAME}` }, error: null } },
      fetchImpl: async (url, init) => { puts.push({ url, init }); return new Response('', { status: 200 }) },
      sleep: async () => {},
    })
    assert.deepEqual(await covers.upload(NAME, file), { data: { path: NAME }, error: null })
    assert.deepEqual(calls, [{ name: NAME, mime_type: 'image/jpeg', size_bytes: 1234 }])
    assert.equal(puts[0].init.method, 'PUT')
    assert.equal(puts[0].init.headers['Content-Type'], 'image/jpeg')
  })

  it('сбой хранилища — новая ссылка и повтор; ответ PUT потерян, а имя уже занято — загрузка состоялась', async () => {
    let n = 0
    const covers = createOspCovers({
      call: async () => (++n === 3 ? httpError(409, { error: 'занято', code: 'OSP_COVER_EXISTS' }) : { data: { presigned_url: 'https://s3.test/p' }, error: null }),
      fetchImpl: async () => (n === 1 ? new Response('', { status: 503 }) : Promise.reject(new TypeError('сеть'))),
      sleep: async () => {},
    })
    assert.deepEqual(await covers.upload(NAME, file), { data: { path: NAME }, error: null })
    assert.equal(n, 3)
  })

  it('отказ по правам — сразу ошибка с текстом сервера, без повторов', async () => {
    let n = 0
    const covers = createOspCovers({
      call: async () => { n++; return httpError(403, { error: 'Нет права на правку объектов' }) },
      fetchImpl: async () => { throw new Error('PUT не должен вызываться') },
      sleep: async () => {},
    })
    const res = await covers.upload(NAME, file)
    assert.equal(res.data, null)
    assert.equal(res.error.message, 'Нет права на правку объектов')
    assert.equal(n, 1)
  })
})
