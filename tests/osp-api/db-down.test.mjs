// Недоступная база и реплика: общий обработчик отдаёт 503, в журнал — код, не текст запроса.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbUnavailable, DB_UNAVAILABLE, DB_UNAVAILABLE_TEXT } from '../../server/osp-api/src/lib/db.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'fastify')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'
const KEY = crypto.randomBytes(32).toString('base64')

describe('osp-api: база недоступна или не мастер — 503', { skip }, () => {
  it('классификатор узнаёт коды сбоя и не трогает обычную ошибку запроса', () => {
    for (const code of ['25006', '57P01', '57P02', '57P03', '08006', '08000', '08P01', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'OSP_DB_WATCHDOG', DB_UNAVAILABLE]) {
      assert.equal(dbUnavailable({ code }), true, code)
    }
    assert.equal(dbUnavailable({ code: '23505' }), false)
    assert.equal(dbUnavailable({ code: '57014' }), false)
    assert.equal(dbUnavailable(null), false)
  })

  it('вход и выход при ошибке реплики отвечают 503, текст запроса в журнал не попадает', async () => {
    const { buildApp } = await import(path.join(SERVER, 'src', 'app.js'))
    const logs = []
    const boom = () => {
      const err = new Error('cannot execute INSERT in a read-only transaction')
      err.code = '25006'
      throw err
    }
    const app = buildApp({
      config: {
        host: '127.0.0.1', port: 0,
        authMode: 'own',
        auth: { keys: `t1:${KEY}`, publicOrigin: 'https://tender.test' },
        db: { url: 'postgres://api_login:x@127.0.0.1:1/db', poolMax: 1 },
        dbGateway: { upstream: 'http://127.0.0.1:9', secret: 'gateway-secret-0123456789-abcdefghij', dbRole: 'api_login' },
      },
      deps: {
        createDb: () => ({
          read: async () => boom(),
          write: async () => boom(),
          recovery: () => null,
          stats: () => ({ max: 1, total: 0, idle: 0, waiting: 0 }),
          close: async () => {},
        }),
      },
      logger: { level: 'info', stream: { write: (line) => logs.push(String(line)) } },
    })
    try {
      await app.ready()
      const login = await app.inject({
        method: 'POST', url: '/api/auth/login',
        headers: { 'content-type': 'application/json', origin: 'https://tender.test' },
        payload: JSON.stringify({ email: 'user@su10.ru', password: 'secret-pass' }),
      })
      assert.equal(login.statusCode, 503)
      assert.deepEqual(login.json(), { error: DB_UNAVAILABLE_TEXT, code: DB_UNAVAILABLE })
      const logout = await app.inject({
        method: 'POST', url: '/api/auth/logout',
        headers: { 'content-type': 'application/json', cookie: '__Host-osp_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        payload: '{}',
      })
      assert.equal(logout.statusCode, 503)
      assert.equal(logout.json().code, DB_UNAVAILABLE)
      const text = logs.join('\n')
      assert.match(text, /25006/)
      assert.equal(text.includes('INSERT'), false)
    } finally {
      await app.close()
    }
  })
})
