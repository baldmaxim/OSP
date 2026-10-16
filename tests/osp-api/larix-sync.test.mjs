// Загрузка договорных расценок из Larix.CPM (server/osp-api/src/lib/larixSync.js) на настоящем PostgreSQL с
// настоящей миграцией supabase/migrations/20261018_larix_contract_rates.sql (дважды — повтор безопасен).
// Проверяем обещанное:
//   • позиция ВОР даёт строку материалов и строку работ (цена > 0); дата договора — по Москве;
//     наш договор находится по ссылке «Путь к Larix.CPM» только при однозначном совпадении;
//   • пустой ответ и резкое падение числа позиций не стирают расценки (held), --force принимает;
//   • сбой Larix — запись в журнал с причиной, без логина и пароля; сломанный формат — invalid;
//   • одна загрузка одновременно; зависшая — снимается; повтор порции безопасен, недостающая — отказ;
//   • по расписанию — не чаще раза в день; такт пропускается при барьере записи;
//   • база прежнего портала — через PostgREST служебным ключом (настоящий supabase-js), только функции
//     загрузки; служба с LARIX_SYNC=1 сама запускает загрузку;
//   • функции загрузки в миграции Supabase и в миграции базы Яндекса — один и тот же текст.
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261018_larix_contract_rates.sql')
const YANDEX = path.join(ROOT, 'migration', 'yandex', '20261018_larix_contract_rates.sql')
const skip = !fs.existsSync(path.join(SERVER, 'node_modules', 'pg')) ? 'нет зависимостей: npm ci --prefix server/osp-api'
  : !pgAvailable() ? 'нет PostgreSQL (бинарники или Docker)' : false

const USER = 'larix-robot'
const PASS = 'Larix-Pass-sync-secret'
const TOKEN = 'larix-token-sync-secret-value'
const SERVICE_KEY = 'service-key-larix-test'
const VIEWER = '11111111-1111-4111-8111-111111111111'
const STRANGER = '22222222-2222-4222-8222-222222222222'

// Как на Supabase: роли, расширение в схеме extensions, «кто вошёл», договоры и право раздела.
const BOOT = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema extensions; create extension pg_trgm with schema extensions;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create table public.contracts(id uuid primary key default gen_random_uuid(), document_link text, deleted_at timestamptz);
create table public.rates_viewers(user_id uuid primary key);
create function public.osp_can(p_section text, p_kind text) returns boolean language sql stable security definer
  set search_path = public as $$
  select p_section = 'rates_registry' and p_kind = 'view' and exists (select 1 from public.rates_viewers where user_id = auth.uid()) $$;
insert into public.rates_viewers values ('${VIEWER}');
insert into public.contracts(id, document_link, deleted_at) values
  ('c0000000-0000-4000-8000-000000000093', 'https://cpm.su10.larix.ru/contract/93', null),
  ('c0000000-0000-4000-8000-000000000104', 'https://cpm.su10.larix.ru/contract/104', null),
  ('c0000000-0000-4000-8000-000000000105', 'https://cpm.su10.larix.ru/contract/104/', null),
  ('c0000000-0000-4000-8000-000000000007', '  http://CPM.su10.larix.ru/contract/7?tab=boq ', null),
  ('c0000000-0000-4000-8000-000000000008', 'https://cpm.su10.larix.ru/contract/8', now()),
  ('c0000000-0000-4000-8000-000000000009', '\\\\server\\share\\contract\\9', null);
`

const POS = (over = {}) => ({
  project_id: 2, project_name: 'Дом 56 + Реновация (Суб.)', contractor_id: 33, contractor_short_name: 'ООО "Стройсервис"',
  work_title: 'Газобетон Стеновой блок Bonolit D600, t=100 мм (ПЧ)', measure_title: 'м2', price_material: 807.45, price_work: 2185.5,
  materials_used: null, comment: null, object_type: 'Договор', contract_id: 93, contract_number: 'СУ2-ДОМ 56-И-Э025-3',
  contract_date: '2025-01-19T21:00:00+00:00', contract_state: 'Заключен', ...over,
})
const SAMPLE = [
  POS(),
  POS({ work_title: 'Монтаж перегородок', price_material: 0, price_work: '1 200,50', contract_id: 104, contract_number: 'N-104',
    contract_date: '2025-03-01', contract_state: 'Закрыт', contractor_id: 34, contractor_short_name: 'ООО Б' }),
  POS({ work_title: 'Кабель ВВГнг 3х2,5', measure_title: 'м', price_material: 12.3, price_work: null, contract_id: 7,
    contract_number: 'N-7', contract_date: '2024-12-31T21:00:00Z', comment: 'по факту', object_type: 'ДС', vat_rate: 20 }),
  POS({ work_title: 'Без договора у нас', contract_id: 8, contract_number: 'N-8', price_material: null, price_work: 50 }),
]

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

describe('Загрузка договорных расценок из Larix.CPM', { skip, timeout: 300000 }, () => {
  let pgdb
  let createDb
  let lib
  let db
  let larix
  let larixState = { mode: 'ok', rows: SAMPLE }
  let logs = []
  const log = { info: (o, m) => logs.push(JSON.stringify({ m, ...o })), warn: (o, m) => logs.push(JSON.stringify({ m, ...o })) }
  const q = (sql) => pgdb.exec(sql).trim()
  const client = () => lib.client.createLarixClient({ baseUrl: larix.url, username: USER, password: PASS })
  const sync = (targets, options) => lib.sync.createLarixSync({ client: client(), targets, log, secrets: [PASS, USER], options })
  const clean = () => q('delete from public.larix_contract_rates; delete from public.larix_sync_runs;')

  before(async () => {
    ;({ createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js')))
    lib = {
      sync: await import(path.join(SERVER, 'src', 'lib', 'larixSync.js')),
      client: await import(path.join(SERVER, 'src', 'lib', 'larixClient.js')),
    }
    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(BOOT)
    pgdb.applyFile(MIGRATION)
    pgdb.applyFile(MIGRATION)
    db = createDb({ url: `postgres://postgres@127.0.0.1:${pgdb.port}/psdc_test`, max: 2 })
    const server = http.createServer((req, res) => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      req.resume()
      req.on('end', () => {
        if (req.url === '/api/login') {
          return larixState.mode === 'deny' ? send(401, { message: `wrong ${USER}:${PASS}` }) : send(200, { access_token: TOKEN })
        }
        if (req.url === '/api/contract/data/project_contract_boq' && req.headers.authorization === `Bearer ${TOKEN}`) {
          return larixState.mode === 'down' ? send(503, { message: 'maintenance' }) : send(200, larixState.rows)
        }
        send(404, {})
      })
    })
    larix = { url: await listen(server), close: () => new Promise((r) => server.close(r)) }
  })
  after(async () => {
    await db?.close()
    await larix?.close()
    pgdb?.stop()
  })

  it('функции загрузки в миграции Supabase и в миграции базы Яндекса — один и тот же текст', () => {
    const fns = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/CREATE OR REPLACE FUNCTION public\.(larix_sync_\w+)[\s\S]*?\n\$\$;/g)]
      .map((m) => [m[1], m[0]])
    const supa = fns(MIGRATION)
    assert.deepEqual(supa.map(([n]) => n), ['larix_sync_begin', 'larix_sync_add_rows', 'larix_sync_finish', 'larix_sync_fail'])
    assert.deepEqual(fns(YANDEX), supa)
  })

  it('ручной запуск: материалы и работы отдельными строками, дата по Москве, наш договор — по ссылке', async () => {
    clean()
    larixState = { mode: 'ok', rows: SAMPLE }
    const out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.equal(out.results.db.status, 'ok', JSON.stringify(out))
    assert.equal(out.positions, 4)
    const rows = q(`select string_agg(concat_ws('|', item_type, item_name, price, contract_id, contract_date, coalesce(osp_contract_id::text, '-'), coalesce(vat_rate::text, '-')), E'\\n' order by id)
      from public.larix_contract_rates`).split('\n')
    assert.deepEqual(rows, [
      'material|Газобетон Стеновой блок Bonolit D600, t=100 мм (ПЧ)|807.45|93|2025-01-20|c0000000-0000-4000-8000-000000000093|-',
      'work|Газобетон Стеновой блок Bonolit D600, t=100 мм (ПЧ)|2185.5|93|2025-01-20|c0000000-0000-4000-8000-000000000093|-',
      'work|Монтаж перегородок|1200.5|104|2025-03-01|-|-',
      'material|Кабель ВВГнг 3х2,5|12.3|7|2025-01-01|c0000000-0000-4000-8000-000000000007|20',
      'work|Без договора у нас|50|8|2025-01-20|-|-',
    ], 'договор 104 — две ссылки (неоднозначно), договор 8 — удалён у нас')
    const run = JSON.parse(q(`select row_to_json(r) from (select status, started_by, positions_count, rows_count, skipped_count,
      larix_contracts, matched_contracts, response_keys, filters from public.larix_sync_runs) r`))
    assert.equal(run.status, 'ok')
    assert.equal(run.started_by, 'cli')
    assert.deepEqual([run.positions_count, run.rows_count, run.skipped_count, run.larix_contracts, run.matched_contracts], [4, 5, 0, 4, 2])
    assert.ok(run.response_keys.includes('work_title') && run.response_keys.includes('vat_rate'))
    assert.deepEqual(run.filters.states, ['Закрыт', 'Заключен'].sort())
    assert.deepEqual(run.filters.contracts.map((c) => c.id).sort((a, b) => a - b), [7, 8, 93, 104])
    assert.deepEqual(run.filters.contractors.map((c) => c.name).sort(), ['ООО "Стройсервис"', 'ООО Б'])
  })

  it('читает реестр только вошедший с правом раздела; гость и функции загрузки — закрыты', () => {
    const as = (role, uid, sql) => {
      try {
        return { ok: true, out: q(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid || ''}', false); ${sql}`).split('\n').at(-1) }
      } catch (e) { return { ok: false, error: e.message } }
    }
    assert.equal(as('authenticated', VIEWER, 'select count(*) from public.larix_contract_rates').out, '5')
    assert.equal(as('authenticated', VIEWER, 'select count(*) from public.larix_sync_runs').out, '1')
    assert.equal(as('authenticated', STRANGER, 'select count(*) from public.larix_contract_rates').out, '0')
    assert.match(as('anon', null, 'select count(*) from public.larix_contract_rates').error, /permission denied/)
    assert.match(as('authenticated', VIEWER, 'select count(*) from public.larix_sync_stage').error, /permission denied/)
    assert.match(as('authenticated', VIEWER, "select public.larix_sync_begin('cli')").error, /permission denied/)
    assert.match(as('authenticated', VIEWER, 'delete from public.larix_contract_rates').error, /permission denied/)
  })

  it('по расписанию — не чаще раза в день: после удачной загрузки сегодня такт ничего не начинает', async () => {
    const out = await sync([lib.sync.dbTarget(db)]).runOnce()
    assert.equal(out.started, 0)
    assert.equal(q('select count(*) from public.larix_sync_runs'), '1')
  })

  it('пустой ответ не стирает расценки (held), резкое падение — тоже; --force принимает', async () => {
    larixState = { mode: 'ok', rows: [] }
    let out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.equal(out.results.db.status, 'held')
    assert.equal(q('select count(*) from public.larix_contract_rates'), '5', 'прежние расценки на месте')
    assert.equal(q("select error_code || ' ' || error_text from public.larix_sync_runs order by id desc limit 1"),
      'empty Larix вернул пустой список — оставлены расценки прежней загрузки')

    // Падение ниже 30 % — когда прежних позиций достаточно (≥ 50).
    larixState = { mode: 'ok', rows: Array.from({ length: 60 }, (_, i) => POS({ work_title: `Позиция ${i}` })) }
    out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.equal(out.results.db.status, 'ok')
    larixState = { mode: 'ok', rows: SAMPLE }
    out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.equal(out.results.db.status, 'held')
    assert.equal(out.results.db.reason, 'shrink')
    assert.equal(q('select count(*) from public.larix_contract_rates'), '120')
    out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli', force: true })
    assert.equal(out.results.db.status, 'ok')
    assert.equal(q('select count(*) from public.larix_contract_rates'), '5')
  })

  it('сбой Larix: неверный логин и недоступность — запись в журнал без логина и пароля, расценки на месте', async () => {
    logs = []
    larixState = { mode: 'deny', rows: SAMPLE }
    let out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.deepEqual(out.results.db, { status: 'failed', code: 'login' })
    larixState = { mode: 'down', rows: SAMPLE }
    out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.deepEqual(out.results.db, { status: 'failed', code: 'http' })
    const journal = q("select string_agg(error_code || ': ' || error_text, E'\\n' order by id) from public.larix_sync_runs where status = 'failed'")
    assert.match(journal, /login: Larix отклонил вход/)
    assert.match(journal, /http: Larix: ВОР по договорам не получены \(HTTP 503\)/)
    for (const s of [USER, PASS, TOKEN]) {
      assert.ok(!journal.includes(s), `в журнале загрузок: ${s}`)
      assert.ok(!logs.join('\n').includes(s), `в журнале службы: ${s}`)
    }
    assert.equal(q('select count(*) from public.larix_contract_rates'), '5')
  })

  it('формат ответа сломался (больше 5 % позиций не проходят проверку) — invalid, расценки на месте', async () => {
    larixState = { mode: 'ok', rows: [...SAMPLE, { work_title: '' }, { price_material: 'дорого', work_title: 'x' }, 'строка'] }
    const out = await sync([lib.sync.dbTarget(db)]).runOnce({ startedBy: 'cli' })
    assert.deepEqual(out.results.db, { status: 'failed', code: 'invalid' })
    assert.match(q("select error_text from public.larix_sync_runs order by id desc limit 1"), /не прошли проверку 3 из 7/)
    assert.equal(q('select count(*) from public.larix_contract_rates'), '5')
  })

  it('одна загрузка одновременно; зависшая снимается; порция повторяется безопасно, недостающая — отказ', async () => {
    clean()
    const t = lib.sync.dbTarget(db)
    const a = await t.begin('cli')
    assert.ok(a)
    assert.equal(await t.begin('cli'), null, 'вторая — «занято»')
    // Зависла: начата 31 минуту назад.
    q(`update public.larix_sync_runs set started_at = now() - interval '31 minutes' where id = ${a}`)
    const b = await t.begin('cli')
    assert.ok(b && String(b) !== String(a))
    assert.equal(q(`select status || ' ' || error_code from public.larix_sync_runs where id = ${a}`), 'failed stale')
    const rows = [lib.sync.normalizeBoqRow(POS()), lib.sync.normalizeBoqRow(POS({ work_title: 'Вторая' }))]
    await t.addRows(b, 0, rows)
    await t.addRows(b, 0, rows)
    await assert.rejects(() => t.finish(b, 3, 0, [], false), /в порциях 2 позиций, отправлено 3/)
    assert.equal(q(`select status from public.larix_sync_runs where id = ${b}`), 'running', 'неудачная замена не меняет журнал')
    const done = await t.finish(b, 2, 0, [], false)
    assert.equal(done.status, 'ok')
    assert.equal(done.rows, 4)
    assert.equal(q('select count(*) from public.larix_sync_stage'), '0', 'порции убраны')
  })

  it('такт по расписанию: первый — после паузы, дальше — по интервалу; барьер записи — пропуск', async () => {
    let begins = 0
    const target = { name: 'fake', begin: async () => { begins++; return null } }
    const larixSync = lib.sync.createLarixSync({ client: { fetchBoq: async () => ({ rows: [] }) }, targets: [target], log,
      options: { firstDelayMs: 20, intervalMs: 30 } })
    let readOnly = false
    const stop = larixSync.start({ isReadOnly: () => readOnly })
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(begins >= 2, `тактов: ${begins}`)
    readOnly = true
    const seen = begins
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(begins, seen, 'при барьере записи загрузка не спрашивается')
    stop()
  })

  describe('база прежнего портала: PostgREST и служебный ключ', () => {
    let rest
    let calls = []
    // Поддельный PostgREST: только /rest/v1/rpc/<функция>, вызов — в настоящую базу под service_role.
    const TYPES = { p_run: 'bigint', p_chunk: 'integer', p_rows: 'jsonb', p_expected: 'integer', p_skipped: 'integer',
      p_keys: 'text[]', p_force: 'boolean', p_started_by: 'text', p_code: 'text', p_text: 'text' }
    before(async () => {
      const pg = (await import(path.join(SERVER, 'node_modules', 'pg', 'lib', 'index.js'))).default
      const pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${pgdb.port}/psdc_test`, max: 2 })
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body) }
          const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url)
          calls.push({ fn: m?.[1], apikey: req.headers.apikey, auth: req.headers.authorization })
          if (!m || req.method !== 'POST') return send(404, '{"code":"PGRST202","message":"not found"}')
          if (req.headers.apikey !== SERVICE_KEY || req.headers.authorization !== `Bearer ${SERVICE_KEY}`) return send(401, '{"message":"bad key"}')
          const args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const names = Object.keys(args)
          if (names.some((n) => !TYPES[n])) return send(400, '{"message":"bad arg"}')
          const sql = `select public.${m[1]}(${names.map((n, i) => `${n} => $${i + 1}::${TYPES[n]}`).join(', ')}) as r`
          const values = names.map((n) => (TYPES[n] === 'jsonb' ? JSON.stringify(args[n]) : args[n]))
          const c = await pool.connect()
          try {
            await c.query('begin; set local role service_role')
            const { rows } = await c.query(sql, values)
            await c.query('commit')
            send(200, JSON.stringify(rows[0].r))
          } catch (err) {
            await c.query('rollback').catch(() => {})
            send(400, JSON.stringify({ code: err.code, message: err.message }))
          } finally { c.release() }
        })
      })
      rest = { url: await listen(server), close: async () => { await new Promise((r) => server.close(r)); await pool.end() } }
    })
    after(() => rest?.close())

    it('через supabase-js: те же шаги, только функции загрузки, ключ — служебный', async () => {
      clean()
      calls = []
      larixState = { mode: 'ok', rows: SAMPLE }
      const { createClient } = createRequire(path.join(SERVER, 'package.json'))('@supabase/supabase-js')
      const supabase = createClient(rest.url, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      const out = await sync([lib.sync.supabaseTarget(supabase)]).runOnce({ startedBy: 'cli' })
      assert.equal(out.results.supabase.status, 'ok', JSON.stringify(out))
      assert.equal(q('select count(*) from public.larix_contract_rates'), '5')
      assert.deepEqual([...new Set(calls.map((c) => c.fn))], ['larix_sync_begin', 'larix_sync_add_rows', 'larix_sync_finish'])
      assert.ok(calls.every((c) => c.apikey === SERVICE_KEY))
    })

    it('служба с LARIX_SYNC=1 и целью supabase сама запускает загрузку; /api/health — только да/нет', async () => {
      clean()
      calls = []
      const { buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
      const { parseLarix } = await import(path.join(SERVER, 'src', 'config.js'))
      const config = {
        host: '127.0.0.1', port: 0, supabaseUrl: rest.url, supabaseAnonKey: 'anon', supabaseServiceKey: SERVICE_KEY,
        s3: {}, anthropicApiKey: '', ratesApiKeys: [],
        larix: parseLarix({ LARIX_SYNC: '1', LARIX_BASE_URL: larix.url, LARIX_USERNAME: USER, LARIX_PASSWORD: PASS, LARIX_SYNC_TARGETS: 'supabase' },
          { dbUrl: '', supabaseUrl: rest.url, supabaseServiceKey: SERVICE_KEY }),
      }
      const lines = []
      const app = buildApp({ config, deps: { ...defaultDeps, larixOptions: { firstDelayMs: 10, intervalMs: 60_000 } },
        logger: { level: 'info', stream: { write: (l) => lines.push(l) } } })
      await app.ready()
      try {
        const health = await app.inject({ method: 'GET', url: '/api/health' })
        assert.equal(health.json().configured.larix, true)
        for (const s of [USER, PASS, SERVICE_KEY]) assert.ok(!health.body.includes(s), s)
        const deadline = Date.now() + 15000
        while (q("select count(*) from public.larix_sync_runs where status <> 'running'") === '0' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        // По расписанию начинает только после 05:00 по Москве; раньше — ничего не делает, и это тоже верно.
        const due = q("select now() >= (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '5 hours') at time zone 'Europe/Moscow'") === 't'
        if (due) {
          assert.equal(q("select status || ' ' || started_by from public.larix_sync_runs"), 'ok schedule')
          assert.equal(q('select count(*) from public.larix_contract_rates'), '5')
        } else {
          assert.equal(q('select count(*) from public.larix_sync_runs'), '0')
        }
        assert.ok(calls.some((c) => c.fn === 'larix_sync_begin'), 'служба спросила базу, пора ли')
        for (const s of [USER, PASS, TOKEN, SERVICE_KEY]) assert.ok(!lines.join('\n').includes(s), `в журнале службы: ${s}`)
      } finally {
        await app.close()
      }
    })
  })
})
