// Клиентская часть переноса данных: второй путь за src/api/db.js (ownDb.js) и опрос вместо Realtime
// (tablePolling.js). Проверяем, что портал шлёт в свой шлюз те же запросы, что слал в Supabase, с
// токеном входа и без ключа проекта, и что по разнице снимков получаются те же события, что слал Realtime.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOwnDb, OSP_DB_FLAG, OSP_DB_PATH } from '../../src/api/ownDb.js'
import { diffSnapshots, parseFilter, fetchTableRows, createTablePoller } from '../../src/api/tablePolling.js'

function fakeFetch(respond = () => ({})) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const call = { method: init.method || 'GET', path: url.pathname, params: url.searchParams, headers: new Headers(init.headers), body: init.body ?? null }
    calls.push(call)
    const r = respond(call)
    return new Response(r.body ?? '[]', { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } })
  }
  return { calls, fetchImpl }
}

describe('Портал → свой шлюз данных: тот же построитель запросов', () => {
  it('флаг и адрес', () => {
    assert.equal(OSP_DB_FLAG, 'ospDb')
    assert.equal(OSP_DB_PATH, '/api/db')
  })

  it('чтение: таблица, связи, фильтры, порядок, страница, счётчик — как у supabase-js', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 206, headers: { 'content-range': '0-9/774' }, body: '[{"id":1}]' }))
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => 'user-token', fetchImpl })
    const res = await db.from('tenders').select('*, objects(name), winner:counterparties!winner_counterparty_id(id, name)', { count: 'exact' })
      .eq('department', 'construction').in('status', ['a', 'b']).order('created_at', { ascending: false }).range(0, 9)
    assert.deepEqual([res.error, res.count, res.data], [null, 774, [{ id: 1 }]])
    const c = calls[0]
    assert.equal(c.method, 'GET')
    assert.equal(c.path, '/api/db/tenders')
    assert.equal(c.params.get('select'), '*,objects(name),winner:counterparties!winner_counterparty_id(id,name)')
    assert.equal(c.params.get('department'), 'eq.construction')
    assert.equal(c.params.get('status'), 'in.(a,b)')
    assert.equal(c.params.get('order'), 'created_at.desc')
    assert.deepEqual([c.params.get('offset'), c.params.get('limit')], ['0', '10'])
    assert.equal(c.headers.get('authorization'), 'Bearer user-token')
    assert.equal(c.headers.get('apikey'), null, 'ключ проекта Supabase в свой шлюз не уходит')
    assert.match(c.headers.get('prefer'), /count=exact/)
  })

  it('запись и функции: вставка с возвратом строк, изменение, удаление, вызов функции', async () => {
    const { calls, fetchImpl } = fakeFetch((c) => (c.method === 'POST' && !c.path.includes('/rpc/') ? { status: 201, body: '{"id":"n1","title":"x"}' } : { status: 200, body: c.path.includes('/rpc/') ? '{"ok":true}' : '[]' }))
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => 'user-token', fetchImpl })
    const created = await db.from('tasks').insert({ title: 'x' }).select('*').single()
    assert.deepEqual(created.data, { id: 'n1', title: 'x' })
    await db.from('tasks').update({ title: 'y' }).eq('id', 'n1')
    await db.from('tasks').delete().eq('id', 'n1')
    const rpc = await db.rpc('psdc_validate', { p_psdc_id: 'p1' })
    assert.deepEqual(rpc.data, { ok: true })
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /api/db/tasks', 'PATCH /api/db/tasks', 'DELETE /api/db/tasks', 'POST /api/db/rpc/psdc_validate'])
    assert.equal(calls[0].body, '{"title":"x"}')
    assert.match(calls[0].headers.get('prefer'), /return=representation/)
    assert.equal(calls[1].params.get('id'), 'eq.n1')
    assert.equal(calls[3].body, '{"p_psdc_id":"p1"}')
  })

  it('без входа заголовка нет (шлюз считает анонимом); токен берётся заново на каждый запрос', async () => {
    const { calls, fetchImpl } = fakeFetch()
    let token = null
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => token, fetchImpl })
    await db.from('tenders').select('id')
    token = 'fresh-1'
    await db.from('tenders').select('id')
    token = 'fresh-2'
    await db.from('tenders').select('id')
    assert.deepEqual(calls.map((c) => c.headers.get('authorization')), [null, 'Bearer fresh-1', 'Bearer fresh-2'])
  })

  it('отказы приходят так же: код базы и PostgREST в error.code, данные — null', async () => {
    const { fetchImpl } = fakeFetch((c) => (c.path.endsWith('/counterparties')
      ? { status: 409, body: '{"code":"23505","details":null,"hint":null,"message":"duplicate key value"}' }
      : { status: 403, body: '{"code":"42501","details":null,"hint":null,"message":"permission denied for table psdc_rows"}' }))
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => 't', fetchImpl })
    const dup = await db.from('counterparties').insert({ name: 'x' })
    assert.deepEqual([dup.data, dup.error.code, dup.status], [null, '23505', 409])
    const denied = await db.from('psdc_rows').insert({ a: 1 })
    assert.deepEqual([denied.error.code, denied.status], ['42501', 403])
  })
})

describe('Онлайн-обновления опросом: те же события, что слал Realtime', () => {
  it('разница снимков: появилась, изменилась, пропала', () => {
    const first = diffSnapshots(null, [{ id: 1, status: 'a' }, { id: 2, status: 'b' }])
    assert.deepEqual(first.events, [], 'первый снимок — точка отсчёта, событий нет')
    const second = diffSnapshots(first.snapshot, [{ id: 1, status: 'a' }, { id: 2, status: 'c' }, { id: 3, status: 'n' }])
    assert.deepEqual(second.events, [
      { eventType: 'UPDATE', new: { id: 2, status: 'c' }, old: { id: 2, status: 'b' } },
      { eventType: 'INSERT', new: { id: 3, status: 'n' }, old: {} },
    ])
    const third = diffSnapshots(second.snapshot, [{ id: 2, status: 'c' }, { id: 3, status: 'n' }])
    assert.deepEqual(third.events, [{ eventType: 'DELETE', new: {}, old: { id: 1, status: 'a' } }])
    assert.deepEqual(diffSnapshots(third.snapshot, [{ id: 3, status: 'n' }, { id: 2, status: 'c' }]).events, [], 'порядок строк — не изменение')
  })

  it('фильтр подписки и постраничное чтение', async () => {
    assert.equal(parseFilter(null), null)
    assert.deepEqual(parseFilter('contract_id=eq.c0000000-0000-4000-8000-000000000001'), { column: 'contract_id', value: 'c0000000-0000-4000-8000-000000000001' })
    assert.throws(() => parseFilter('status=in.(a,b)'), /не поддерживается/)
    const all = Array.from({ length: 2300 }, (_, i) => ({ id: i }))
    const { calls, fetchImpl } = fakeFetch((c) => {
      const offset = Number(c.params.get('offset'))
      return { body: JSON.stringify(all.slice(offset, offset + Number(c.params.get('limit')))) }
    })
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => 't', fetchImpl })
    const rows = await fetchTableRows(db, { table: 'tender_counterparties', filter: 'tender_id=eq.t1' })
    assert.equal(rows.length, 2300)
    assert.deepEqual(calls.map((c) => c.params.get('offset')), ['0', '1000', '2000'])
    assert.ok(calls.every((c) => c.params.get('tender_id') === 'eq.t1' && c.params.get('order') === 'id.asc'))
  })

  it('опрос: первый шаг — «подписан», дальше события; выключенный флаг и скрытая вкладка — без запросов', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let rows = [{ id: 1, v: 'a' }]
    let active = true
    let visible = true
    let fetches = 0
    let fail = false
    const events = []
    const statuses = []
    const poller = createTablePoller({
      fetchRows: async () => { fetches++; if (fail) throw new Error('сеть'); return rows },
      onChange: (e) => events.push(e), onStatus: (s) => statuses.push(s), active: () => active, visible: () => visible, intervalMs: 1000,
    })
    const step = async () => { t.mock.timers.tick(1000); await new Promise((r) => setImmediate(r)) }
    await new Promise((r) => setImmediate(r))
    assert.deepEqual([fetches, statuses, events], [1, ['SUBSCRIBED'], []])
    rows = [{ id: 1, v: 'b' }, { id: 2, v: 'n' }]
    await step()
    assert.deepEqual(events.map((e) => e.eventType), ['UPDATE', 'INSERT'])
    // Сбой чтения — не «всё удалено»: событий нет, следующий шаг сверяет с прежним снимком.
    fail = true
    await step()
    fail = false
    rows = [{ id: 1, v: 'b' }]
    await step()
    assert.deepEqual(events.map((e) => e.eventType), ['UPDATE', 'INSERT', 'DELETE'])
    // Вкладка скрыта — не опрашиваем.
    visible = false
    const before = fetches
    await step()
    await step()
    assert.equal(fetches, before)
    // Флаг выключили (откат на Supabase): запросов нет; включили снова — новый отсчёт, без ложных событий.
    visible = true
    active = false
    await step()
    assert.equal(fetches, before)
    active = true
    rows = [{ id: 7, v: 'x' }]
    await step()
    assert.deepEqual(events.length, 3, 'после возврата флага первый снимок событий не даёт')
    poller.stop()
    await step()
    assert.equal(fetches, before + 1, 'после отписки опроса нет')
  })
})
