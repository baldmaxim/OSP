// osp-api (server/osp-api): маршруты вместо Edge Functions Supabase. Проверяем, что перенос
// повторяет поведение функций (тот же запрос, ответ, коды, проверка доступа), а отличия — только
// задуманные: ai-assist — только сотрудникам; rates-api без limit / price_min / price_max работает по
// документации (в функции Number(null) = 0 давало limit 1 и фильтр «цена ≤ 0»).
//
// supabase-js в osp-api настоящий и ходит в подделку «как Supabase» (tests/osp-api/lib/fakes.mjs).
// Нужны зависимости сервера: npm ci --prefix server/osp-api — без них набор пропускается.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeSupabase, startFakeS3 } from './lib/fakes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'fastify')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const U = {
  emp: { token: 'tok-emp', id: '11111111-1111-4111-8111-111111111111' },
  admin: { token: 'tok-admin', id: '22222222-2222-4222-8222-222222222222' },
  unapproved: { token: 'tok-unapproved', id: '33333333-3333-4333-8333-333333333333' },
  contractor: { token: 'tok-contractor', id: '44444444-4444-4444-8444-444444444444' },
  contractorNoOrg: { token: 'tok-cnoorg', id: '55555555-5555-4555-8555-555555555555' },
  noRole: { token: 'tok-norole', id: '66666666-6666-4666-8666-666666666666' },
}
const CONTRACT_MINE = 'c0000000-0000-4000-8000-000000000001'
const CONTRACT_OTHER = 'c0000000-0000-4000-8000-000000000002'
const TENDER_1 = 'a0000000-0000-4000-8000-000000000001'
const TENDER_HIDDEN = 'a0000000-0000-4000-8000-000000000002'
const GDOC_1 = 'b0000000-0000-4000-8000-000000000001'
const PSDC_1 = 'd0000000-0000-4000-8000-000000000001'
const VOR_1 = 'e0000000-0000-4000-8000-000000000001'

function supabaseState() {
  return {
    users: Object.fromEntries(Object.values(U).map((u) => [u.token, { id: u.id }])),
    roles: {
      [U.emp.id]: { role: 'engineer', counterparty_id: null, is_approved: true },
      [U.admin.id]: { role: 'admin', counterparty_id: null, is_approved: true },
      [U.unapproved.id]: { role: 'engineer', counterparty_id: null, is_approved: false },
      [U.contractor.id]: { role: 'contractor', counterparty_id: 'cp-1', is_approved: true },
      [U.contractorNoOrg.id]: { role: 'contractor', counterparty_id: null, is_approved: true },
    },
    docs: {
      'tenders/t1/a-plan.pdf': { row: { id: 'd1', owner_type: 'tender', owner_id: 't1' }, visibleTo: [U.emp.id, U.admin.id] },
      [`contracts/${CONTRACT_MINE}/x.docx`]: { row: { id: 'd2', owner_type: 'contract', owner_id: CONTRACT_MINE }, visibleTo: 'all' },
      [`contracts/${CONTRACT_OTHER}/y.docx`]: { row: { id: 'd3', owner_type: 'contract', owner_id: CONTRACT_OTHER }, visibleTo: 'all' },
      'tenders/t2/shared.pdf': { row: { id: 'd4', owner_type: 'tender', owner_id: 't2' }, visibleTo: 'all' },
    },
    myContracts: { [U.contractor.id]: [CONTRACT_MINE] },
    owners: {
      tenders: { [TENDER_1]: [U.emp.id, U.admin.id], [TENDER_HIDDEN]: [U.admin.id] },
      general_documents: { [GDOC_1]: 'all' },
      psdc: { [PSDC_1]: [U.emp.id] },
      vor_requests: { [VOR_1]: [U.emp.id] },
      contracts: { [CONTRACT_MINE]: 'all' },
    },
    views: {
      kp_rates_registry: Array.from({ length: 3 }, (_, i) => ({
        id: `k${i}`, object_id: 'o1', object_name: 'Объект', counterparty_id: 'cp-1', counterparty_name: 'ООО «Тест»; филиал',
        tender_id: 't1', tender_desc: 'Описание "в кавычках"', item_type: i % 2 ? 'work' : 'material',
        item_name: `Позиция ${i}`, unit: 'м3', price: 100 + i, proposal_date: '2026-09-01', secret_col: 'не отдавать',
      })),
      supply_rates_registry: [{ id: 's0', object_id: 'o1', object_name: 'Объект', tender_id: 't1', tender_desc: 'd', item_name: 'Бетон', unit: 'м3', price: 50, rate_date: '2026-09-02' }],
    },
    viewTotal: 3,
  }
}

describe('osp-api: маршруты вместо Edge Functions', { skip }, () => {
  let buildApp
  let supa
  let s3
  let state
  let app
  let logs
  let aiCalls
  let aiResponse

  const config = (over = {}) => ({
    host: '127.0.0.1', port: 0,
    supabaseUrl: supa.url, supabaseAnonKey: 'anon-test-key', supabaseServiceKey: 'service-test-key',
    s3: { endpoint: s3.url, region: 'ru-central-1', bucket: 'osp', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' },
    anthropicApiKey: 'anthropic-test-key',
    ratesApiKeys: ['rk-one', 'rk-two'],
    ...over,
  })

  let aiGate = null // промис: ответ модели ждёт его (проверка одновременности)
  let anthropicDown = false

  async function makeApp(over = {}, { limits } = {}) {
    const { defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    const deps = {
      ...defaultDeps,
      createAnthropic: () => ({
        beta: { messages: { create: async (params) => {
          aiCalls.push(params)
          if (aiGate) await aiGate
          if (aiResponse instanceof Error) throw aiResponse
          return aiResponse
        } } },
        models: { list: async () => { if (anthropicDown) throw new Error('401 invalid x-api-key'); return { data: [] } } },
      }),
    }
    await app?.close()
    app = buildApp({ config: config(over), deps, ...(limits ? { limits } : {}), logger: { level: 'info', stream: { write: (line) => logs.push(line) } } })
    await app.ready()
    return app
  }

  const fn = (name, who, body, raw) => app.inject({
    method: 'POST', url: `/api/fn/${name}`,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) },
    payload: raw ?? JSON.stringify(body ?? {}),
  })

  before(async () => {
    ;({ buildApp } = await import(path.join(SERVER, 'src', 'app.js')))
    state = supabaseState()
    supa = await startFakeSupabase(state)
    s3 = await startFakeS3()
  })
  after(async () => {
    await app?.close()
    await supa?.close()
    await s3?.close()
  })
  beforeEach(async () => {
    logs = []
    aiCalls = []
    aiResponse = { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ПРЕДЛАГАЕМАЯ РЕДАКЦИЯ:\n1.1 …' }], usage: { input_tokens: 10, output_tokens: 20 } }
    supa.reset()
    s3.requests.length = 0
    await makeApp()
  })

  it('health: что настроено — да/нет, без значений секретов', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, service: 'osp-api', configured: { supabase: true, supabaseService: true, s3: true, anthropic: true, rates: true } })
    for (const secret of ['anon-test-key', 'service-test-key', 'secret-test', 'anthropic-test-key', 'rk-one']) {
      assert.ok(!res.body.includes(secret), secret)
    }
  })

  describe('s3-presign', () => {
    it('без токена и с чужим токеном — 401', async () => {
      assert.equal((await fn('s3-presign', null, { action: 'upload' })).statusCode, 401)
      assert.equal((await fn('s3-presign', { token: 'forged' }, { action: 'upload' })).statusCode, 401)
    })

    it('неодобренный и учётка без роли — 403', async () => {
      for (const who of [U.unapproved, U.noRole]) {
        const res = await fn('s3-presign', who, { action: 'upload', owner_type: 'tender', owner_id: 't1', file_name: 'a.pdf' })
        assert.equal(res.statusCode, 403, who.token)
        assert.deepEqual(res.json(), { error: 'Forbidden' })
      }
    })

    it('строки базы читаются под токеном пользователя (действует RLS), не служебным ключом', async () => {
      await fn('s3-presign', U.emp, { action: 'download', s3_key: 'tenders/t1/a-plan.pdf' })
      const rest = supa.requests.filter((r) => r.path.startsWith('/rest/v1/'))
      assert.ok(rest.length >= 2)
      for (const r of rest) {
        assert.equal(r.auth, `Bearer ${U.emp.token}`, r.path)
        assert.equal(r.apikey, 'anon-test-key', r.path)
      }
    })

    it('upload: ключ «каталог/владелец/uuid-имя», кириллица — латиницей, PUT на 15 минут', async () => {
      const res = await fn('s3-presign', U.emp, { action: 'upload', owner_type: 'general_document', owner_id: GDOC_1, file_name: 'Акт №5 (итог).pdf', mime_type: 'application/pdf' })
      assert.equal(res.statusCode, 200, res.body)
      const out = res.json()
      assert.match(out.s3_key, new RegExp(`^general-documents/${GDOC_1}/[0-9a-f-]{36}-Akt_5_itog_\\.pdf$`))
      assert.equal(out.expires_in, 900)
      const url = new URL(out.presigned_url)
      assert.equal(url.origin, s3.url)
      assert.equal(decodeURIComponent(url.pathname), `/osp/${out.s3_key}`)
      assert.equal(url.searchParams.get('X-Amz-Expires'), '900')
      assert.ok(url.searchParams.get('X-Amz-Signature'))
    })

    it('upload: неизвестный owner_type, нет owner_id или имени — 400 с тем же текстом', async () => {
      const cases = [
        [{ owner_type: 'secret', owner_id: 'x', file_name: 'a' }, 'Unsupported owner_type: secret'],
        [{ owner_type: 'constructor', owner_id: 'x', file_name: 'a' }, 'Unsupported owner_type: constructor'],
        [{ owner_type: 'tender', file_name: 'a' }, 'Missing owner_id'],
        [{ owner_type: 'tender', owner_id: 'x' }, 'Missing file_name'],
      ]
      for (const [body, error] of cases) {
        const res = await fn('s3-presign', U.emp, { action: 'upload', ...body })
        assert.equal(res.statusCode, 400)
        assert.deepEqual(res.json(), { error })
      }
    })

    it('download: только файл из s3_documents, видимый пользователю; GET на 60 минут', async () => {
      const hidden = await fn('s3-presign', U.emp, { action: 'download', s3_key: 'tenders/t9/guess.pdf' })
      assert.equal(hidden.statusCode, 404)
      assert.deepEqual(hidden.json(), { error: 'Файл не найден' })
      const ok = await fn('s3-presign', U.emp, { action: 'download', s3_key: 'tenders/t1/a-plan.pdf' })
      assert.equal(ok.statusCode, 200)
      const url = new URL(ok.json().presigned_url)
      assert.equal(url.searchParams.get('X-Amz-Expires'), '3600')
      assert.equal(url.searchParams.get('response-content-disposition'), null, 'превью — без attachment')
    })

    it('download с download=true — исходное имя: ASCII и UTF-8', async () => {
      const res = await fn('s3-presign', U.emp, { action: 'download', s3_key: 'tenders/t1/a-plan.pdf', file_name: 'План работ.pdf', download: true })
      const cd = new URL(res.json().presigned_url).searchParams.get('response-content-disposition')
      assert.equal(cd, `attachment; filename="Plan_rabot.pdf"; filename*=UTF-8''${encodeURIComponent('План работ.pdf')}`)
    })

    it('подрядчик: только скачивание и только файлов своих договоров', async () => {
      const up = await fn('s3-presign', U.contractor, { action: 'upload', owner_type: 'contract', owner_id: CONTRACT_MINE, file_name: 'a.pdf' })
      assert.equal(up.statusCode, 403)
      assert.deepEqual(up.json(), { error: 'Действие доступно только сотрудникам' })
      const del = await fn('s3-presign', U.contractor, { action: 'delete', s3_key: `contracts/${CONTRACT_MINE}/x.docx` })
      assert.equal(del.statusCode, 403)
      assert.equal((await fn('s3-presign', U.contractor, { action: 'download', s3_key: `contracts/${CONTRACT_MINE}/x.docx` })).statusCode, 200)
      assert.equal((await fn('s3-presign', U.contractor, { action: 'download', s3_key: `contracts/${CONTRACT_OTHER}/y.docx` })).statusCode, 404, 'чужой договор')
      assert.equal((await fn('s3-presign', U.contractor, { action: 'download', s3_key: 'tenders/t2/shared.pdf' })).statusCode, 404, 'не договор')
      assert.equal(s3.requests.length, 0)
    })

    it('delete: удаляет в S3 только видимый файл', async () => {
      const miss = await fn('s3-presign', U.emp, { action: 'delete', s3_key: 'tenders/t9/guess.pdf' })
      assert.equal(miss.statusCode, 404)
      assert.equal(s3.requests.length, 0)
      const ok = await fn('s3-presign', U.emp, { action: 'delete', s3_key: 'tenders/t1/a-plan.pdf' })
      assert.equal(ok.statusCode, 200)
      assert.deepEqual(ok.json(), { ok: true })
      assert.deepEqual(s3.requests.map((r) => `${r.method} ${r.path}`), ['DELETE /osp/tenders/t1/a-plan.pdf'])
      assert.match(s3.requests[0].auth, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//)
    })

    it('неизвестное действие и неверный JSON — 400', async () => {
      assert.deepEqual((await fn('s3-presign', U.emp, { action: 'list' })).json(), { error: 'Unknown action: list' })
      const bad = await fn('s3-presign', U.emp, null, '{oops')
      assert.equal(bad.statusCode, 400)
      assert.deepEqual(bad.json(), { error: 'Invalid JSON' })
      const notObject = await fn('s3-presign', U.emp, null, '[1,2]')
      assert.equal(notObject.statusCode, 400)
    })

    it('не настроены Supabase или S3 — 500 с тем же текстом, что у функции', async () => {
      await makeApp({ supabaseUrl: '' })
      assert.deepEqual((await fn('s3-presign', U.emp, { action: 'upload' })).json(), { error: 'Supabase env not configured' })
      await makeApp({ s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' } })
      const res = await fn('s3-presign', U.emp, { action: 'upload', owner_type: 'tender', owner_id: 't', file_name: 'a' })
      assert.equal(res.statusCode, 500)
      assert.match(res.json().error, /^S3 secrets are not configured/)
    })
  })

  describe('ai-assist', () => {
    const body = { action: 'clause_suggest', mode: 'risks', clause_label: '5.2', our_text: 'Срок 10 дней', counterparty_text: 'Срок 30 дней', counterparty_name: 'ООО Ромашка', contract: { number: 'Д-1' }, comments: [{ side: 'employee', name: 'Юрист', body: 'Не согласны' }] }

    it('только одобренный сотрудник (и администратор): иначе 401 / 403', async () => {
      assert.equal((await fn('ai-assist', null, body)).statusCode, 401)
      for (const who of [U.unapproved, U.contractor, U.contractorNoOrg, U.noRole]) {
        const res = await fn('ai-assist', who, body)
        assert.equal(res.statusCode, 403, who.token)
        assert.deepEqual(res.json(), { error: 'ИИ-помощник доступен только сотрудникам' })
      }
      for (const who of [U.emp, U.admin]) assert.equal((await fn('ai-assist', who, body)).statusCode, 200, who.token)
      assert.equal(aiCalls.length, 2, 'в модель ушли только запросы сотрудников')
    })

    it('ответ и запрос к модели — как у функции', async () => {
      const res = await fn('ai-assist', U.emp, body)
      assert.deepEqual(res.json(), { text: 'ПРЕДЛАГАЕМАЯ РЕДАКЦИЯ:\n1.1 …', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 20 } })
      const p = aiCalls[0]
      assert.equal(p.model, 'claude-opus-5')
      assert.equal(p.max_tokens, 16000)
      assert.deepEqual(p.output_config, { effort: 'medium' })
      assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01'])
      assert.equal(p.fallbacks, 'default')
      assert.match(p.system, /юрист строительной компании СУ-10/)
      const prompt = p.messages[0].content
      assert.match(prompt, /ПУНКТ: 5\.2/)
      assert.match(prompt, /РЕДАКЦИЯ ООО РОМАШКА:\nСрок 30 дней/)
      assert.match(prompt, /— СУ-10, Юрист: Не согласны/)
      assert.match(prompt, /РИСКИ:/)
    })

    it('ошибки — те же коды и тексты', async () => {
      assert.deepEqual((await fn('ai-assist', U.emp, { ...body, action: 'x' })).json(), { error: 'Unknown action: x' })
      assert.equal((await fn('ai-assist', U.emp, { ...body, our_text: '', counterparty_text: '' })).statusCode, 400)
      aiResponse = { ...aiResponse, stop_reason: 'refusal', content: [] }
      assert.equal((await fn('ai-assist', U.emp, body)).statusCode, 422)
      aiResponse = { ...aiResponse, stop_reason: 'end_turn', content: [{ type: 'text', text: '  ' }] }
      assert.equal((await fn('ai-assist', U.emp, body)).statusCode, 502)
      aiResponse = new Error('overloaded')
      const fail = await fn('ai-assist', U.emp, body)
      assert.equal(fail.statusCode, 500)
      assert.deepEqual(fail.json(), { error: 'overloaded' })
      await makeApp({ anthropicApiKey: '' })
      assert.deepEqual((await fn('ai-assist', U.emp, body)).json(), { error: 'ANTHROPIC_API_KEY не задан в секретах функции' })
    })
  })

  describe('rates-api → /api/rates', () => {
    const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers })

    it('ключ: заголовок или ?key=, неверный — 401; CORS как у функции', async () => {
      const none = await get('/api/rates/kp')
      assert.equal(none.statusCode, 401)
      assert.equal(none.headers['access-control-allow-origin'], '*')
      assert.equal((await get('/api/rates/kp', { 'x-api-key': 'rk-wrong' })).statusCode, 401)
      assert.equal((await get('/api/rates/kp', { 'x-api-key': 'rk-two' })).statusCode, 200)
      assert.equal((await get('/api/rates/kp?key=rk-one')).statusCode, 200)
      const pre = await app.inject({ method: 'OPTIONS', url: '/api/rates/kp' })
      assert.equal(pre.statusCode, 200)
      assert.equal(pre.headers['access-control-allow-headers'], 'x-api-key, content-type')
    })

    it('health и неизвестный ресурс', async () => {
      assert.deepEqual((await get('/api/rates/health?key=rk-one')).json(), { ok: true, resources: ['kp', 'supply'] })
      assert.deepEqual((await get('/api/rates?key=rk-one')).json(), { ok: true, resources: ['kp', 'supply'] })
      assert.equal((await get('/api/rates/users?key=rk-one')).statusCode, 404)
    })

    it('kp: явные колонки, фильтры, порядок, страница; служебный ключ, а не пользователь', async () => {
      const res = await get('/api/rates/kp?key=rk-one&search=бетон&type=work&counterparty=cp-1&object=o1&tender=t1&price_min=10&price_max=500&date_from=2026-01-01&date_to=2026-12-31&limit=2&offset=1')
      assert.equal(res.statusCode, 200, res.body)
      const out = res.json()
      assert.equal(out.limit, 2)
      assert.equal(out.offset, 1)
      assert.equal(out.count, 3)
      assert.equal(out.has_more, true)
      assert.ok(!('secret_col' in out.rows[0]), 'колонки — только из списка')
      const [data, head] = supa.requests
      assert.equal(data.path, '/rest/v1/kp_rates_registry')
      assert.equal(data.auth, 'Bearer service-test-key')
      const q = data.params
      assert.equal(q.get('select').replace(/\s+/g, ''), 'id,object_id,object_name,counterparty_id,counterparty_name,tender_id,tender_desc,item_type,item_name,unit,price,proposal_date')
      assert.equal(q.get('item_name'), 'ilike.%бетон%')
      assert.equal(q.get('item_type'), 'eq.work')
      assert.equal(q.get('counterparty_id'), 'eq.cp-1')
      assert.equal(q.get('object_id'), 'eq.o1')
      assert.equal(q.get('tender_id'), 'eq.t1')
      assert.deepEqual(q.getAll('price'), ['gte.10', 'lte.500'])
      assert.deepEqual(q.getAll('proposal_date'), ['gte.2026-01-01', 'lte.2026-12-31'])
      assert.equal(q.get('order'), 'item_name.asc,id.asc')
      assert.equal(q.get('offset'), '1')
      assert.equal(q.get('limit'), '2')
      assert.equal(head.method, 'HEAD')
      assert.match(head.prefer, /count=exact/)
    })

    it('без limit / price_* — 500 строк и без фильтра цены (исправление ошибки функции)', async () => {
      await get('/api/rates/kp?key=rk-one')
      const q = supa.requests[0].params
      assert.equal(q.get('limit'), '500')
      assert.equal(q.get('offset'), '0')
      assert.deepEqual(q.getAll('price'), [])
      await get('/api/rates/kp?key=rk-one&limit=5000')
      assert.equal(supa.requests.at(-2).params.get('limit'), '1000')
    })

    it('supply: дата — rate_date, тип и контрагент не применяются', async () => {
      const res = await get('/api/rates/supply?key=rk-one&type=work&counterparty=cp-1&date_from=2026-01-01')
      assert.equal(res.statusCode, 200)
      const q = supa.requests[0].params
      assert.equal(supa.requests[0].path, '/rest/v1/supply_rates_registry')
      assert.equal(q.get('item_type'), null)
      assert.equal(q.get('counterparty_id'), null)
      assert.equal(q.get('rate_date'), 'gte.2026-01-01')
    })

    it('подсчёт не уложился — count: null, строки отдаются', async () => {
      state.countFails = true
      try {
        const out = (await get('/api/rates/kp?key=rk-one')).json()
        assert.equal(out.count, null)
        assert.equal(out.rows.length, 3)
      } finally {
        state.countFails = false
      }
    })

    it('csv: BOM, «;», экранирование, имя файла', async () => {
      const res = await get('/api/rates/kp?key=rk-one&format=csv&limit=1')
      assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8')
      assert.equal(res.headers['content-disposition'], 'attachment; filename="kp_rates_registry.csv"')
      assert.ok(res.body.startsWith('﻿id;object_id;'))
      assert.match(res.body, /;"ООО «Тест»; филиал";/)
      assert.match(res.body, /;"Описание ""в кавычках""";/)
    })

    it('нет представления (42P01) — 503 с понятным текстом', async () => {
      state.missingView = true
      try {
        const res = await get('/api/rates/kp?key=rk-one')
        assert.equal(res.statusCode, 503)
        assert.deepEqual(res.json(), { error: 'Представление kp_rates_registry недоступно — не применены миграции реестра расценок' })
      } finally {
        state.missingView = false
      }
    })

    it('не настроен служебный ключ — 500 с тем же текстом', async () => {
      await makeApp({ supabaseServiceKey: '' })
      assert.deepEqual((await get('/api/rates/kp?key=rk-one')).json(), { error: 'Функция не настроена: нет SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' })
    })
  })

  describe('загрузка: владелец файла (рецензия, п. 2)', () => {
    const up = (who, ownerType, ownerId) => fn('s3-presign', who, { action: 'upload', owner_type: ownerType, owner_id: ownerId, file_name: 'a.pdf' })

    it('owner_id — только uuid', async () => {
      for (const bad of ['t1', 'x/../y', `${TENDER_1},${TENDER_HIDDEN}`, `${TENDER_1}/sub`]) {
        const res = await up(U.emp, 'tender', bad)
        assert.equal(res.statusCode, 400, bad)
        assert.deepEqual(res.json(), { error: 'Invalid owner_id' })
      }
    })

    it('сущность должна существовать и быть видна пользователю (под его токеном)', async () => {
      assert.equal((await up(U.emp, 'tender', TENDER_1)).statusCode, 200)
      for (const id of [TENDER_HIDDEN, 'a0000000-0000-4000-8000-0000000000ff']) {
        const res = await up(U.emp, 'tender', id)
        assert.equal(res.statusCode, 404, id)
        assert.deepEqual(res.json(), { error: 'Владелец файла не найден' })
      }
      assert.equal((await up(U.admin, 'tender', TENDER_HIDDEN)).statusCode, 200, 'админу видна')
      const lookups = supa.requests.filter((r) => r.path === '/rest/v1/tenders')
      assert.ok(lookups.length >= 3)
      for (const r of lookups) assert.match(r.auth, /^Bearer tok-(emp|admin)$/)
    })

    it("'general' — ПСДЦ или заявка на ВОР; 'customer' не поддерживается", async () => {
      assert.equal((await up(U.emp, 'general', PSDC_1)).statusCode, 200)
      assert.equal((await up(U.emp, 'general', VOR_1)).statusCode, 200)
      assert.equal((await up(U.emp, 'general', GDOC_1)).statusCode, 404, 'документ раздела — не владелец general')
      assert.deepEqual((await up(U.emp, 'customer', GDOC_1)).json(), { error: 'Unsupported owner_type: customer' })
    })
  })

  describe('лимиты (рецензия, п. 4)', () => {
    const tiny = {
      aiPerUser: { max: 2, windowMs: 60_000 }, aiConcurrentPerUser: 1, aiConcurrentTotal: 1,
      presignPerUser: { max: 2, windowMs: 60_000 }, ratesPerKey: { max: 2, windowMs: 60_000 }, ratesConcurrentPerKey: 1,
    }
    const aiBody = { action: 'clause_suggest', our_text: 'a', counterparty_text: 'b' }

    it('presign — частота на пользователя', async () => {
      await makeApp({}, { limits: tiny })
      const body = { action: 'download', s3_key: 'tenders/t1/a-plan.pdf' }
      assert.equal((await fn('s3-presign', U.emp, body)).statusCode, 200)
      assert.equal((await fn('s3-presign', U.emp, body)).statusCode, 200)
      const third = await fn('s3-presign', U.emp, body)
      assert.equal(third.statusCode, 429)
      assert.match(third.json().error, /подождите минуту/)
      assert.equal((await fn('s3-presign', U.admin, body)).statusCode, 200, 'у другого пользователя свой счётчик')
    })

    it('ИИ — частота на пользователя, один ответ за раз, общий предел', async () => {
      await makeApp({}, { limits: tiny })
      let open
      aiGate = new Promise((r) => { open = r })
      const first = fn('ai-assist', U.emp, aiBody)
      await new Promise((r) => setTimeout(r, 50))
      const same = await fn('ai-assist', U.emp, aiBody)
      assert.equal(same.statusCode, 429)
      assert.match(same.json().error, /уже готовит ответ/)
      const other = await fn('ai-assist', U.admin, aiBody)
      assert.equal(other.statusCode, 429)
      assert.match(other.json().error, /занят/)
      open()
      aiGate = null
      assert.equal((await first).statusCode, 200)
      assert.equal((await fn('ai-assist', U.emp, aiBody)).statusCode, 200)
      const third = await fn('ai-assist', U.emp, aiBody)
      assert.equal(third.statusCode, 429, 'третий за минуту')
      assert.equal(aiCalls.length, 2, 'в модель ушли только разрешённые запросы')
    })

    it('реестр — частота и одновременность на ключ', async () => {
      await makeApp({}, { limits: tiny })
      state.viewDelayMs = 150
      try {
        const a = app.inject({ method: 'GET', url: '/api/rates/kp?key=rk-one' })
        await new Promise((r) => setTimeout(r, 30))
        const b = await app.inject({ method: 'GET', url: '/api/rates/kp?key=rk-one' })
        assert.equal(b.statusCode, 429, 'второй одновременный')
        assert.equal((await a).statusCode, 200)
        assert.equal((await app.inject({ method: 'GET', url: '/api/rates/kp?key=rk-two' })).statusCode, 200, 'другой ключ')
        assert.equal((await app.inject({ method: 'GET', url: '/api/rates/kp?key=rk-one' })).statusCode, 429, 'третий за минуту')
      } finally {
        state.viewDelayMs = 0
      }
    })
  })

  describe('готовность /api/ready (рецензия, п. 5)', () => {
    const ready = (headers = {}) => app.inject({ method: 'GET', url: '/api/ready', headers })

    it('все настроенные зависимости отвечают — 200; S3 — запись и удаление служебного объекта', async () => {
      const res = await ready()
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual(res.json(), { ok: true, checks: { supabase: 'ok', s3: 'ok', anthropic: 'ok' }, required: ['supabase', 's3', 'anthropic'] })
      assert.deepEqual(s3.requests.map((r) => `${r.method} ${r.path}`), ['PUT /osp/osp-api/ready-check', 'DELETE /osp/osp-api/ready-check'])
    })

    it('неверный ключ или недоступная зависимость — 503 и что именно', async () => {
      anthropicDown = true
      try {
        const res = await ready()
        assert.equal(res.statusCode, 503)
        assert.deepEqual(res.json(), { ok: false, checks: { supabase: 'ok', s3: 'ok', anthropic: 'fail' }, required: ['supabase', 's3', 'anthropic'] })
      } finally {
        anthropicDown = false
      }
      await makeApp({ supabaseUrl: 'http://127.0.0.1:9' })
      const down = await ready()
      assert.equal(down.statusCode, 503)
      assert.equal(down.json().checks.supabase, 'fail')
    })

    it('обязательная не настроена — 503 (рецензия 2, п. 2); суженный явно список — 200', async () => {
      const noKeys = { anthropicApiKey: '', s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' } }
      await makeApp(noKeys)
      const res = await ready()
      assert.equal(res.statusCode, 503)
      assert.deepEqual(res.json(), { ok: false, checks: { supabase: 'ok', s3: 'not_configured', anthropic: 'not_configured' }, required: ['supabase', 's3', 'anthropic'] })
      await makeApp({ ...noKeys, required: ['supabase'] })
      assert.equal((await ready()).statusCode, 200)
      // Необязательная проверяется и видна, но не решает.
      anthropicDown = true
      try {
        await makeApp({ required: ['supabase', 's3'] })
        const partial = await ready()
        assert.equal(partial.statusCode, 200)
        assert.deepEqual(partial.json(), { ok: true, checks: { supabase: 'ok', s3: 'ok', anthropic: 'fail' }, required: ['supabase', 's3'] })
      } finally {
        anthropicDown = false
      }
    })

    it('через nginx (X-Forwarded-For) — 404', async () => {
      assert.equal((await ready({ 'x-forwarded-for': '203.0.113.5' })).statusCode, 404)
    })
  })

  describe('ответы и запросы (рецензия, прочее)', () => {
    it('Cache-Control: no-store во всех ответах', async () => {
      for (const res of [
        await app.inject({ method: 'GET', url: '/api/health' }),
        await fn('s3-presign', U.emp, { action: 'download', s3_key: 'tenders/t1/a-plan.pdf' }),
        await app.inject({ method: 'GET', url: '/api/rates/kp?key=rk-one' }),
        await app.inject({ method: 'GET', url: '/api/nope' }),
      ]) assert.equal(res.headers['cache-control'], 'no-store')
    })

    it('тело до 2 МБ принимается (длинный пункт договора), больше — 413 JSON', async () => {
      const big = 'Пункт договора. '.repeat(50_000) // ≈ 1,5 МБ в UTF-8
      const ok = await fn('ai-assist', U.emp, { action: 'clause_suggest', our_text: big, counterparty_text: 'x' })
      assert.equal(ok.statusCode, 200, ok.body.slice(0, 200))
      const tooBig = await fn('ai-assist', U.emp, { action: 'clause_suggest', our_text: big + big, counterparty_text: 'x' })
      assert.equal(tooBig.statusCode, 413)
      assert.deepEqual(tooBig.json(), { error: 'Слишком большой запрос' })
    })

    it('без устаревших опций Fastify (FSTDEP)', async () => {
      const warnings = []
      const onWarning = (w) => warnings.push(w)
      process.on('warning', onWarning)
      try {
        await makeApp()
        await new Promise((r) => setImmediate(r))
      } finally {
        process.off('warning', onWarning)
      }
      assert.deepEqual(warnings.filter((w) => String(w.code || '').startsWith('FSTDEP')).map((w) => w.code), [])
    })
  })

  it('журнал: ни ключа из ?key=, ни токена, ни текста договора', async () => {
    await app.inject({ method: 'GET', url: '/api/rates/kp?key=rk-one&search=x' })
    await fn('ai-assist', U.emp, { action: 'clause_suggest', our_text: 'КОНФИДЕНЦИАЛЬНЫЙ ПУНКТ', counterparty_text: 'x' })
    await fn('s3-presign', U.emp, null, '{oops')
    const all = logs.join('')
    assert.ok(logs.length >= 3, 'по строке на запрос')
    for (const secret of ['rk-one', U.emp.token, 'КОНФИДЕНЦИАЛЬНЫЙ', 'anon-test-key', 'service-test-key']) {
      assert.ok(!all.includes(secret), `в журнале: ${secret}`)
    }
    assert.match(all, /"route":"\/api\/rates\/\*"/)
  })
})

describe('osp-api: настройки готовности (OSP_API_REQUIRE)', () => {
  let parseRequired, loadConfig
  before(async () => {
    ({ parseRequired, loadConfig } = await import(path.join(SERVER, 'src', 'config.js')))
  })

  it('по умолчанию и пустая строка — все три', () => {
    assert.deepEqual(parseRequired(undefined), ['supabase', 's3', 'anthropic'])
    assert.deepEqual(parseRequired(''), ['supabase', 's3', 'anthropic'])
    assert.deepEqual(loadConfig({}).required, ['supabase', 's3', 'anthropic'])
  })

  it('явный список — как задан, порядок и повторы не важны', () => {
    assert.deepEqual(parseRequired(' s3 , supabase,s3'), ['supabase', 's3'])
    assert.deepEqual(loadConfig({ OSP_API_REQUIRE: 'supabase' }).required, ['supabase'])
  })

  it('опечатка или без supabase — служба не запускается', () => {
    assert.throws(() => parseRequired('supabase,anthropc'), /неизвестные зависимости anthropc/)
    assert.throws(() => parseRequired('s3,anthropic'), /supabase обязателен/)
    assert.throws(() => loadConfig({ OSP_API_REQUIRE: 'rates' }), /OSP_API_REQUIRE/)
  })
})
