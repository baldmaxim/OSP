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
    for (const code of ['25006', '57P01', '57P02', '57P03', '08006', '08000', '08P01', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'OSP_DB_WATCHDOG', DB_UNAVAILABLE]) {
      assert.equal(dbUnavailable({ code }), true, code)
    }
    for (const message of [
      'Connection terminated unexpectedly',
      'Connection terminated due to connection timeout',
      'Connection terminated',
      'timeout exceeded when trying to connect',
      'Client has encountered a connection error and is not queryable',
      'Client was closed and is not queryable',
    ]) {
      assert.equal(dbUnavailable({ message }), true, message)
    }
    assert.equal(dbUnavailable({ message: 'Connection terminated due to connection timeout', cause: { code: 'ETIMEDOUT' } }), true)
    assert.equal(dbUnavailable({ code: '23505' }), false)
    assert.equal(dbUnavailable({ code: '57014' }), false)
    assert.equal(dbUnavailable({ code: '23505', message: 'Connection terminated unexpectedly' }), false)
    assert.equal(dbUnavailable({ message: 'duplicate key value violates unique constraint' }), false)
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

  it('обрыв связи без кода и отказ выдать соединение — 503, обычная ошибка запроса — 500', async () => {
    const { buildApp } = await import(path.join(SERVER, 'src', 'app.js'))
    const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
    let current = null
    const logs = []
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
          read: async () => { throw current },
          write: async () => { throw current },
          recovery: () => null,
          stats: () => ({ max: 1, total: 0, idle: 0, waiting: 0 }),
          close: async () => {},
        }),
      },
      logger: { level: 'info', stream: { write: (line) => logs.push(String(line)) } },
    })
    const login = () => app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'https://tender.test' },
      payload: JSON.stringify({ email: 'user@su10.ru', password: 'secret-pass' }),
    })
    try {
      await app.ready()
      const connect = [
        { code: 'ECONNREFUSED' },
        { code: 'ENOTFOUND' },
        { code: 'EAI_AGAIN' },
        { code: 'EHOSTUNREACH' },
        { code: 'ENETUNREACH' },
        { message: 'Connection terminated unexpectedly' },
        { message: 'timeout exceeded when trying to connect' },
        { message: 'Connection terminated due to connection timeout' },
        { message: 'Client has encountered a connection error and is not queryable' },
      ]
      for (const fields of connect) {
        current = Object.assign(new Error(fields.message || 'connect failed'), fields.code ? { code: fields.code } : {})
        logs.length = 0
        const res = await login()
        assert.equal(res.statusCode, 503, fields.code || fields.message)
        assert.equal(res.json().code, DB_UNAVAILABLE)
        const text = logs.join('\n')
        assert.equal(text.includes(fields.message || 'connect failed'), false)
      }
      for (const code of ['23505', '57014']) {
        current = Object.assign(new Error('query failed'), { code })
        const res = await login()
        assert.equal(res.statusCode, 500, code)
        assert.equal(res.json().error, 'Internal error')
      }
      const down = createDb({ url: 'postgres://api_login:x@127.0.0.1:1/db', max: 1, connectionTimeoutMs: 400 })
      try {
        const started = Date.now()
        await assert.rejects(down.read(null, (tx) => tx.query('select 1')), (e) => e.code === DB_UNAVAILABLE && e.statusCode === 503)
        assert.ok(Date.now() - started < 2000)
      } finally {
        await down.close()
      }
    } finally {
      await app.close()
    }
  })
})
