// Клиентская часть переноса данных: второй путь за src/api/db.js (ownDb.js) и опрос вместо Realtime
// (tablePolling.js). Проверяем, что портал шлёт в свой шлюз те же запросы, что слал в Supabase, с
// токеном входа и без ключа проекта, и что по разнице снимков получаются те же события, что слал Realtime.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOwnDb, OSP_DB_FLAG, OSP_DB_PATH } from '../../src/api/ownDb.js'
import { diffSnapshots, parseFilter, fetchTableRows, createTablePoller, createTableReader, stampColumn } from '../../src/api/tablePolling.js'

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

describe('Опрос по отметке времени: дешёвый такт, те же события', () => {
  const T0 = Date.parse('2026-11-03T10:00:00.000Z')
  const at = (ms) => new Date(T0 + ms).toISOString()

  // Таблица в памяти: читать целиком, отметки с момента, строки по id, число строк, список id. Счётчики — сколько чего читали.
  function fakeTable(rows, { column = 'updated_at' } = {}) {
    const state = { rows, full: 0, stamps: 0, byIds: 0, count: 0, ids: 0, since: [], fail: null }
    const guard = (name) => { if (state.fail === name) throw new Error(`сбой ${name}`) }
    return {
      state,
      fetchRows: async () => { state.full++; guard('full'); return state.rows },
      delta: {
        column,
        stamps: async (since) => {
          state.stamps++; state.since.push(since); guard('stamps')
          return state.rows.filter((r) => r[column] && Date.parse(r[column]) >= Date.parse(since)).map((r) => ({ id: r.id, [column]: r[column] }))
        },
        byIds: async (ids) => { state.byIds++; guard('byIds'); return state.rows.filter((r) => ids.includes(r.id)) },
        count: async () => { state.count++; guard('count'); return state.rows.length },
        ids: async () => { state.ids++; guard('ids'); return state.rows.map((r) => r.id) },
      },
    }
  }
  function start(table, options = {}) {
    let clock = T0 + 60_000
    const events = []
    const poller = createTablePoller({ fetchRows: table.fetchRows, delta: table.delta, onChange: (e) => events.push(e), active: () => true,
      now: () => clock, intervalMs: 3_600_000, countEvery: 1, ...options })
    return { poller, events, advance: (ms) => { clock += ms }, ready: new Promise((r) => setImmediate(r)) }
  }

  it('за такт без изменений — только сверка отметок: строки не читаются', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(0) }, { id: 'b', v: 1, updated_at: at(1000) }])
    const { poller, events, ready } = start(table)
    await ready
    assert.equal(table.state.full, 1, 'снимок целиком — один раз')
    for (let i = 0; i < 5; i++) await poller.tick()
    assert.equal(table.state.full, 1)
    assert.equal(table.state.byIds, 0)
    assert.equal(table.state.stamps, 5)
    assert.deepEqual(events, [])
    poller.stop()
  })

  it('правка: читается одна строка, old — прежняя строка целиком (как при чтении всей таблицы)', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(0) }, { id: 'b', v: 1, updated_at: at(1000) }])
    const { poller, events, ready } = start(table)
    await ready
    table.state.rows = [{ id: 'a', v: 2, updated_at: at(90_000) }, { id: 'b', v: 1, updated_at: at(1000) }]
    await poller.tick()
    assert.deepEqual(events, [{ eventType: 'UPDATE', new: { id: 'a', v: 2, updated_at: at(90_000) }, old: { id: 'a', v: 1, updated_at: at(0) } }])
    assert.equal(table.state.full, 1)
    await poller.tick()
    assert.equal(events.length, 1, 'та же правка второй раз событием не становится')
    poller.stop()
  })

  it('окно: первые минуты после отметки — шире (поздняя транзакция), потом — от самой отметки', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(100_000) }])
    const { poller, events, advance, ready } = start(table, { overlapMs: 300_000 })
    await ready
    await poller.tick()
    assert.equal(table.state.since.at(-1), at(100_000 - 300_000), 'сразу после отметки окно шире на перекрытие')
    // Транзакция началась раньше отметки, а закоммитилась позже: строка вошла в окно и не потерялась.
    table.state.rows = [{ id: 'a', v: 1, updated_at: at(100_000) }, { id: 'late', v: 1, updated_at: at(40_000) }]
    await poller.tick()
    assert.equal(events.at(-1).eventType, 'INSERT')
    assert.equal(events.at(-1).new.id, 'late')
    advance(300_001)
    await poller.tick()
    assert.equal(table.state.since.at(-1), at(100_000), 'перекрытие прошло — только новее отметки')
    poller.stop()
  })

  it('удаление видно по числу строк, новая строка со старой отметкой — тоже; сверка числа — раз в несколько тактов', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(0) }, { id: 'b', v: 1, updated_at: at(1000) }])
    const { poller, events, advance, ready } = start(table, { countEvery: 3, overlapMs: 1000 })
    await ready
    advance(2000)
    table.state.rows = [{ id: 'b', v: 1, updated_at: at(1000) }]
    await poller.tick()
    await poller.tick()
    assert.deepEqual(events, [], 'число строк сверяется не на каждом такте')
    await poller.tick()
    assert.equal(table.state.count, 1)
    assert.deepEqual(events, [{ eventType: 'DELETE', new: {}, old: { id: 'a', v: 1, updated_at: at(0) } }])
    table.state.rows = [{ id: 'b', v: 1, updated_at: at(1000) }, { id: 'old-stamp', v: 1, updated_at: at(-999_999) }]
    await poller.tick()
    await poller.tick()
    await poller.tick()
    assert.equal(events.at(-1).eventType, 'INSERT', 'строка не попала в окно отметок, но число разошлось')
    assert.equal(events.at(-1).new.id, 'old-stamp')
    poller.stop()
  })

  it('сбой любого чтения — ни событий, ни потерь: следующий такт сверит заново', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(0) }])
    const { poller, events, ready } = start(table)
    await ready
    table.state.rows = [{ id: 'a', v: 2, updated_at: at(90_000) }]
    for (const name of ['stamps', 'byIds', 'count']) {
      table.state.fail = name
      await poller.tick()
      assert.deepEqual(events, [], `сбой ${name}`)
    }
    table.state.fail = null
    await poller.tick()
    assert.equal(events.length, 1)
    assert.equal(events[0].old.v, 1, 'снимок не сдвинулся, пока шёл сбой')
    poller.stop()
  })

  it('раз в полчаса — чтение целиком: страховка; у оставленной вкладки — нет', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(0) }])
    let idle = false
    const { poller, events, advance, ready } = start(table, { resyncMs: 1_800_000, idle: () => idle, idleEvery: 1 })
    await ready
    advance(1_800_000)
    // Правка мимо отметки (например, триггер был выключен при загрузке): её найдёт только полное чтение.
    table.state.rows = [{ id: 'a', v: 9, updated_at: at(0) }]
    idle = true
    await poller.tick()
    assert.equal(table.state.full, 1, 'пользователя нет — страховка подождёт')
    idle = false
    await poller.tick()
    assert.equal(table.state.full, 2)
    assert.equal(events.at(-1).eventType, 'UPDATE')
    poller.stop()
  })

  it('пользователь ушёл — опрашиваем реже, и первый снимок это не задерживает', async () => {
    const table = fakeTable([{ id: 'a', v: 1, updated_at: at(0) }])
    const { poller, ready } = start(table, { idle: () => true, idleEvery: 5 })
    await ready
    assert.equal(table.state.full, 1, 'снимок — сразу')
    for (let i = 0; i < 10; i++) await poller.tick()
    assert.equal(table.state.stamps, 2, 'из десяти тактов — два')
    poller.stop()
  })

  it('нет колонки отметки — чтение целиком на каждом такте, как раньше; появилась — сверка', async () => {
    const table = fakeTable([{ id: 'a', v: 1 }])
    const { poller, ready } = start(table)
    await ready
    await poller.tick()
    await poller.tick()
    assert.equal(table.state.full, 3)
    assert.equal(table.state.stamps, 0)
    table.state.rows = [{ id: 'a', v: 1, updated_at: at(0) }]
    await poller.tick()
    await poller.tick()
    assert.equal(table.state.full, 4)
    assert.equal(table.state.stamps, 1)
    poller.stop()
  })

  it('запросы шлюзу: только id и отметка, id частями, число — HEAD; фильтр подписки — в каждом', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    const { calls, fetchImpl } = fakeFetch((c) => (c.method === 'HEAD'
      ? { status: 200, headers: { 'content-range': '*/7' }, body: null }
      : { body: '[]' }))
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => 't', fetchImpl })
    const reader = createTableReader(() => db, { table: 'contract_clause_disputes', filter: 'contract_id=eq.c1' })
    await reader.delta.stamps('2026-11-03T10:00:00.000Z')
    const stamps = calls.at(-1)
    assert.equal(stamps.params.get('select'), 'id,updated_at')
    assert.equal(stamps.params.get('updated_at'), 'gte.2026-11-03T10:00:00.000Z')
    assert.equal(stamps.params.get('order'), 'updated_at.asc,id.asc')
    assert.equal(stamps.params.get('contract_id'), 'eq.c1')
    assert.equal(await reader.delta.count(), 7)
    const count = calls.at(-1)
    assert.equal(count.method, 'HEAD')
    assert.match(count.headers.get('prefer'), /count=exact/)
    assert.equal(count.params.get('contract_id'), 'eq.c1')
    calls.length = 0
    await reader.delta.byIds(ids)
    assert.equal(calls.length, 3, 'по 100 id: адрес не длиннее предела шлюза')
    assert.ok(calls.every((c) => c.params.get('select') === '*' && c.params.get('contract_id') === 'eq.c1'))
    assert.ok(calls.every((c) => decodeURIComponent(c.params.toString()).length < 8000))
  })

  it('сообщения обсуждения не правятся — отметка created_at; узкий список — с отметкой, а без колонки — без неё', async () => {
    assert.equal(stampColumn('contract_clause_comments'), 'created_at')
    assert.equal(stampColumn('tenders'), 'updated_at')
    const { calls, fetchImpl } = fakeFetch((c) => (c.params.get('select')?.includes('updated_at')
      ? { status: 400, body: '{"code":"42703","details":null,"hint":null,"message":"column does not exist"}' }
      : { body: '[{"id":"a","status":"x","tender_id":"t"}]' }))
    const db = createOwnDb({ baseUrl: 'https://osp.example/api/db', getToken: async () => 't', fetchImpl })
    const reader = createTableReader(() => db, { table: 'tender_counterparties', columns: 'id,tender_id,status' })
    assert.deepEqual(await reader.all(), [{ id: 'a', status: 'x', tender_id: 't' }])
    assert.deepEqual(calls.map((c) => c.params.get('select')), ['id,tender_id,status,updated_at', 'id,tender_id,status'])
    calls.length = 0
    await reader.all()
    assert.deepEqual(calls.map((c) => c.params.get('select')), ['id,tender_id,status'], 'раз колонки нет — больше не просим')
  })
})
