// Фронтовой адаптер своего API (src/api/ospApi.js): тот же ответ { data, error }, что у
// functions.invoke supabase-js, — сервисы s3.js и aiAssist.js работают без изменений, в том числе
// достают текст ошибки из error.context.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { callOspFunction, OSP_API_BASE } from '../../src/api/ospApi.js'

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
