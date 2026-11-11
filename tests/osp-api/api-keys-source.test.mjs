// Ключ API из настроек сервера (RATES_API_KEYS) не оживает, когда проверить его по списку ключей нельзя
// (src/lib/apiKeys.js, режим OSP_API_KEYS_SOURCE):
//   • db (по умолчанию): нет подключения к базе, нет таблицы, база не ответила, ключа ещё нет в списке — исключение (маршрут
//     /api/rates отвечает 503), в том числе у нового процесса (после перезапуска службы) и у ключа, который отозвали;
//   • env — прежнее поведение до миграции 20261111: задаётся только явно.
// Без базы и Docker: подделка подключения (как в db-down.test.mjs).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET, projectKey } from './lib/tokens.mjs'
import { startFakeSupabase } from './lib/fakes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const depsOk = ['fastify'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = depsOk ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const ENV_KEY = 'env-key-0123456789abcdefghijklmnop'
const err = (code) => Object.assign(new Error(`db ${code}`), { code })

// Подключение, которое отвечает на поиск ключа как задано: 'missing' (нет таблицы), 'down' (база не ответила),
// { row } — строка ключа, null — ключа нет.
function fakeDb(state) {
  const run = async (_who, fn) => fn({
    query: async () => {
      if (state.lookup === 'missing') throw err('42P01')
      if (state.lookup === 'down') throw err('57P01')
      return { rows: state.lookup ? [state.lookup] : [], rowCount: state.lookup ? 1 : 0 }
    },
    mark: async () => {},
  })
  return { read: run, write: run }
}
const envRow = (extra = {}) => ({ id: '33333333-3333-4333-8333-333333333333', name: 'Ключ из настроек сервера № 1', scopes: ['kp'], source: 'env', revoked: false, expired: false, ...extra })

describe('ключ API из настроек сервера при сбое проверки', { skip }, () => {
  it('режим db: нет таблицы, сбой базы, нет подключения, ключа нет в списке — исключение (503), а не допуск', async () => {
    const { createApiKeyStore, ApiKeyError } = await import(path.join(SERVER, 'src', 'lib', 'apiKeys.js'))
    const envEntries = [{ key: ENV_KEY, resources: ['kp', 'supply'] }]
    for (const lookup of ['missing', 'down', null]) {
      // Новый процесс каждый раз: «таблицу уже видели» не помнится — решает только режим.
      const store = createApiKeyStore({ db: fakeDb({ lookup }), envEntries })
      await assert.rejects(store.resolve(ENV_KEY), (e) => e instanceof ApiKeyError || e?.code === '57P01', `поиск: ${lookup}`)
    }
    const noDb = createApiKeyStore({ db: null, envEntries })
    await assert.rejects(noDb.resolve(ENV_KEY), (e) => e instanceof ApiKeyError && e.code === 'OSP_API_KEYS_NO_DB')
    // Отозванный ключ из настроек — отказ при любом ответе базы; действующий — допуск только по строке.
    const revoked = createApiKeyStore({ db: fakeDb({ lookup: envRow({ revoked: true }) }), envEntries })
    assert.deepEqual((await revoked.resolve(ENV_KEY)).ok, false)
    const active = createApiKeyStore({ db: fakeDb({ lookup: envRow() }), envEntries })
    const found = await active.resolve(ENV_KEY)
    assert.equal(found.ok, true)
    assert.deepEqual(found.key.resources, ['kp', 'supply'], 'права ключа из настроек — из строки RATES_API_KEYS')
    // Неизвестный ключ (строки нет и в настройках его нет) — «неверный ключ» (null), не 503.
    const unknown = createApiKeyStore({ db: fakeDb({ lookup: null }), envEntries })
    assert.equal(await unknown.resolve('some-other-key'), null)
  })

  it('режим env (до миграции, только явно): ключ из настроек действует и без базы', async () => {
    const { createApiKeyStore } = await import(path.join(SERVER, 'src', 'lib', 'apiKeys.js'))
    const envEntries = [{ key: ENV_KEY, resources: ['kp'] }]
    for (const lookup of ['missing', 'down', null]) {
      const store = createApiKeyStore({ db: fakeDb({ lookup }), envEntries, source: 'env' })
      assert.equal((await store.resolve(ENV_KEY)).ok, true, `поиск: ${lookup}`)
    }
    assert.throws(() => createApiKeyStore({ db: null, source: 'other' }), /источник/)
  })

  it('маршрут /api/rates: база не ответила — 503 и запрос не идёт дальше; режим по умолчанию — db', async () => {
    const { buildApp } = await import(path.join(SERVER, 'src', 'app.js'))
    const supa = await startFakeSupabase({ users: {}, roles: {} })
    const app = buildApp({
      logger: false,
      config: {
        host: '127.0.0.1', port: 0, supabaseUrl: supa.url, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: projectKey('service_role'),
        supabaseJwtSecret: SECRET, s3: {}, anthropicApiKey: '', ratesApiKeys: [`${ENV_KEY}:kp`], required: ['supabase'],
        db: { url: 'postgres://api_login:x@127.0.0.1:1/db', poolMax: 1 },
      },
      deps: { createDb: () => ({ ...fakeDb({ lookup: 'down' }), recovery: () => null, stats: () => ({}), close: async () => {} }) },
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/api/rates/kp?limit=1', headers: { 'x-api-key': ENV_KEY } })
      assert.equal(res.statusCode, 503, res.body)
    } finally {
      await app.close()
      await supa.close()
    }
  })
})
