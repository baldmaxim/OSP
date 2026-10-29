// «Администрирование» → «Доступ к API»: ключи для смежных систем на настоящем PostgreSQL — схема как в базе Яндекса
// под одной учёткой (правила по строкам на владельце, пропуск служебных операций), поверх — настоящая миграция
// migration/yandex/20261111_api_keys.sql (дважды: повтор безопасен) и её проверка. Проверяем обещанное:
//   • ключ выпускает только администратор; сам ключ — только в ответе выпуска: в базе — sha256 и первые знаки,
//     в списке и в журнале службы ключа нет;
//   • права ключа — ресурсы /api/rates/*: чужой ресурс — 403; правка прав действует со следующего запроса;
//   • срок — по Москве, прошедшую дату не выпустить; истёкший, отозванный и удалённый ключ — 401 с причиной;
//   • ключи из настроек сервера (RATES_API_KEYS) заносятся в список: права — из строки, отозвать можно в портале,
//     убранный из строки — не действует, права из портала у них не меняются;
//   • журнал вызовов: ресурс, код, строк, причина отказа; фильтр по ключу и «только ошибки»; старше 90 дней — чистится;
//   • без пропуска служебных операций таблицы ключей не читаются даже владельцем.
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { SECRET, userToken, projectKey } from './lib/tokens.mjs'
import { startFakeSupabase } from './lib/fakes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const MIGRATION = path.join(ROOT, 'migration', 'yandex', '20261111_api_keys.sql')
const CHECK = path.join(ROOT, 'migration', 'yandex', '20261111_api_keys.check.sql')
const depsOk = ['pg', 'fastify'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)'

const DB_PASSWORD = 'api-keys-test-db-password'
const ADMIN = '22222222-2222-4222-8222-222222222222'
const ENGINEER = '11111111-1111-4111-8111-111111111111'
const MISSING_ID = '0f0e0d0c-0b0a-4908-8706-050403020100'

// База — как в Яндексе под одной учёткой: всё принадлежит api_login, правила по строкам действуют и на неё.
const SETUP_SQL = `
create role api_login login password '${DB_PASSWORD}';
grant create, connect on database psdc_test to api_login;
grant create on schema public to api_login;
set role api_login;
${fs.readFileSync(path.join(ROOT, 'migration', 'target', 'compat', 'auth.sql'), 'utf8')}
create schema osp_private;
create function osp_private.bypass() returns boolean language sql stable
  as $$ select coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' or coalesce(auth.role(), '') = 'service_role' $$;
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null,
  is_approved boolean not null default false, is_blocked boolean not null default false, counterparty_id uuid, full_name text);
alter table public.user_roles enable row level security; alter table public.user_roles force row level security;
create policy osp_internal on public.user_roles for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
${fs.readFileSync(MIGRATION, 'utf8')}
${fs.readFileSync(MIGRATION, 'utf8')}
`

describe('ключи API на настоящей базе', { skip, timeout: 600000 }, () => {
  let pgdb
  let dbUrl
  let supa
  let buildApp
  let lib
  let app
  let logs = []

  const sql = (text) => pgdb.exec(`set role api_login;\n${text}`).trim()
  const internal = (text) => sql(`set application_name = 'osp:internal';\n${text}`).split('\n').filter(Boolean).at(-1) ?? ''

  async function makeApp(ratesApiKeys = []) {
    await app?.close()
    logs = []
    app = buildApp({
      config: {
        host: '127.0.0.1', port: 0,
        supabaseUrl: supa.url, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: 'service-test-key', supabaseJwtSecret: SECRET,
        s3: {}, anthropicApiKey: '', ratesApiKeys,
        db: { url: dbUrl, caFile: '', poolMax: 3, secondLockRole: '' }, userStatusTtlMs: 0,
      },
      logger: { level: 'info', stream: { write: (line) => logs.push(line) } },
    })
    await app.ready()
    return app
  }

  const as = (userId) => ({ authorization: `Bearer ${userToken(supa.url, userId)}` })
  const adminGet = (url, userId = ADMIN) => app.inject({ method: 'GET', url, headers: as(userId) })
  const adminPost = (url, payload = {}, userId = ADMIN) => app.inject({ method: 'POST', url, payload, headers: as(userId) })
  const rates = (resource, key) => app.inject({ method: 'GET', url: `/api/rates/${resource}`, headers: { 'x-api-key': key } })
  const list = async () => {
    const res = await adminGet('/api/admin/api-keys')
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const calls = async (query = '') => {
    await app.apiKeys.idle()
    const res = await adminGet(`/api/admin/api-keys/calls${query}`)
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const issue = async (body) => {
    const res = await adminPost('/api/admin/api-keys', body)
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }

  before(async () => {
    ;({ buildApp } = await import(path.join(SERVER, 'src', 'app.js')))
    lib = await import(path.join(SERVER, 'src', 'lib', 'apiKeys.js'))
    supa = await startFakeSupabase({
      users: {}, roles: {}, docs: {}, can: {}, myContracts: {}, owners: {},
      views: {
        kp_rates_registry: Array.from({ length: 3 }, (_, i) => ({ id: `k${i}`, object_id: 'o1', object_name: 'Объект', counterparty_id: 'cp-1',
          counterparty_name: 'ООО', tender_id: 't1', tender_desc: 'd', item_type: 'material', item_name: `Бетон ${i}`, unit: 'м3', price: 10 + i, proposal_date: '2026-09-01' })),
        supply_rates_registry: [{ id: 's0', object_id: 'o1', object_name: 'Объект', tender_id: 't1', tender_desc: 'd', item_name: 'Бетон', unit: 'м3', price: 50, rate_date: '2026-09-02' }],
      },
      viewTotal: 3,
    })
    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP_SQL)
    dbUrl = `postgres://api_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`
    internal(`insert into public.user_roles (user_id, role, is_approved, full_name) values
      ('${ADMIN}', 'admin', true, 'Админов Админ Админович'), ('${ENGINEER}', 'engineer', true, 'Инженер');`)
    await makeApp()
  })

  after(async () => {
    await app?.close()
    await supa?.close()
    pgdb?.stop()
  })

  it('миграция: проверка проходит, перечень ресурсов — тот же, что у сервера; без пропуска ключи не читаются', async () => {
    const lines = sql(`set application_name = 'osp:internal';\n${fs.readFileSync(CHECK, 'utf8')}`).split('\n').filter(Boolean)
    assert.ok(lines.length >= 7, lines.join('\n'))
    for (const line of lines) assert.match(line, /^OK /, line)
    const listed = /scopes <@ ARRAY\[([^\]]+)\]/.exec(fs.readFileSync(MIGRATION, 'utf8'))[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1))
    assert.deepEqual(listed, lib.RESOURCE_CODES, 'новый ресурс API — новая миграция с тем же списком')

    await issue({ name: 'Проверка правил', scopes: ['kp'] })
    assert.notEqual(internal('select count(*) from osp_private.api_keys'), '0')
    assert.equal(sql(`set application_name = 'osp-api';\nselect count(*) from osp_private.api_keys`).split('\n').at(-1), '0', 'вошедшему без пропуска — ни строки')
    assert.equal(sql(`set application_name = 'osp:auth';\nselect count(*) from osp_private.api_key_calls`).split('\n').at(-1), '0')
  })

  it('выпуск: ключ — только в ответе; в базе — отпечаток и первые знаки, в списке и журнале службы ключа нет', async () => {
    const { key, secret } = await issue({ name: '  Сметный отдел  ', scopes: ['larix', 'kp'], note: 'Иванов, доб. 214' })
    assert.match(secret, /^osp_[A-Za-z0-9_-]{43}$/)
    assert.equal(key.name, 'Сметный отдел')
    assert.equal(key.prefix, secret.slice(0, 12))
    assert.deepEqual(key.scopes, ['kp', 'larix'], 'порядок — как в перечне ресурсов')
    assert.deepEqual([key.source, key.status, key.expiresOn, key.createdByName, key.note], ['portal', 'active', null, 'Админов Админ Админович', 'Иванов, доб. 214'])

    const hash = crypto.createHash('sha256').update(secret).digest('hex')
    assert.equal(internal(`select count(*) from osp_private.api_keys where key_hash = '${hash}'`), '1')
    assert.equal(internal(`select count(*) from osp_private.api_keys k where k::text like '%${secret.slice(12)}%'`), '0', 'ключа в строке нет')
    const body = (await adminGet('/api/admin/api-keys')).body
    assert.ok(!body.includes(hash) && !body.includes(secret), 'в списке ни ключа, ни отпечатка')
    assert.ok(!logs.join('\n').includes(secret.slice(12)), 'ключа нет в журнале службы')
    const shown = (await list()).keys.find((k) => k.id === key.id)
    assert.equal(shown.prefix, secret.slice(0, 12))

    // Тело не по схеме и прошедший срок — отказ.
    assert.equal((await adminPost('/api/admin/api-keys', { name: 'x', scopes: [] })).statusCode, 400)
    assert.equal((await adminPost('/api/admin/api-keys', { name: 'x', scopes: ['users'] })).statusCode, 400)
    assert.equal((await adminPost('/api/admin/api-keys', { name: '', scopes: ['kp'] })).statusCode, 400)
    assert.equal((await adminPost('/api/admin/api-keys', { name: 'x', scopes: ['kp'], expiresOn: '2026-02-30' })).statusCode, 400)
    const past = await adminPost('/api/admin/api-keys', { name: 'x', scopes: ['kp'], expiresOn: '2020-01-01' })
    assert.equal(past.statusCode, 400)
    assert.equal(past.json().code, 'OSP_API_KEY_DATE')
  })

  it('выдаёт и видит ключи только администратор', async () => {
    for (const res of [
      await adminGet('/api/admin/api-keys', ENGINEER),
      await adminPost('/api/admin/api-keys', { name: 'Себе', scopes: ['kp'] }, ENGINEER),
      await adminGet('/api/admin/api-keys/calls', ENGINEER),
    ]) assert.equal(res.statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/api-keys' })).statusCode, 401)
    assert.equal((await adminPost(`/api/admin/api-keys/${MISSING_ID}/revoke`)).statusCode, 404)
    assert.equal((await adminPost('/api/admin/api-keys/not-a-uuid', { name: 'x' })).statusCode, 404)
  })

  it('права: открытые ресурсы работают, чужой — 403; правка прав — со следующего запроса; журнал вызовов', async () => {
    const { key, secret } = await issue({ name: 'Тендерный отдел', scopes: ['kp'] })
    assert.deepEqual((await rates('health', secret)).json(), { ok: true, resources: ['kp'] })
    const kp = await rates('kp', secret)
    assert.equal(kp.statusCode, 200, kp.body)
    assert.equal(kp.json().rows.length, 3)
    const supply = await rates('supply', secret)
    assert.equal(supply.statusCode, 403)
    assert.match(supply.json().error, /не открыт/)
    assert.equal((await app.inject({ method: 'GET', url: `/api/rates/kp?key=${secret}` })).statusCode, 200, 'ключ в адресе — для Excel')
    assert.equal((await rates('kp', `${secret}x`)).statusCode, 401)

    const journal = await calls(`?key=${key.id}`)
    assert.deepEqual(journal.calls.map((c) => [c.resource, c.status, c.rows, c.reason]),
      [['kp', 200, 3, ''], ['supply', 403, null, 'forbidden_resource'], ['kp', 200, 3, ''], ['health', 200, null, '']])
    assert.equal(journal.calls[0].keyName, 'Тендерный отдел')
    assert.ok(journal.calls.every((c) => typeof c.ms === 'number' && c.ip))
    assert.deepEqual((await calls(`?key=${key.id}&errors=1`)).calls.map((c) => c.status), [403])
    const page = await calls(`?key=${key.id}&limit=2`)
    assert.equal(page.hasMore, true)
    assert.deepEqual((await calls(`?key=${key.id}&limit=2&before=${page.calls[1].id}`)).calls.map((c) => c.resource), ['kp', 'health'])
    const row = (await list()).keys.find((k) => k.id === key.id)
    assert.deepEqual([row.callsDay, row.errorsDay], [4, 1])
    assert.ok(row.lastUsedAt)

    const upd = await adminPost(`/api/admin/api-keys/${key.id}`, { name: 'Тендерный отдел (снабжение)', scopes: ['supply'] })
    assert.equal(upd.statusCode, 200, upd.body)
    assert.deepEqual([upd.json().key.name, upd.json().key.scopes, upd.json().key.updatedByName], ['Тендерный отдел (снабжение)', ['supply'], 'Админов Админ Админович'])
    assert.equal((await rates('supply', secret)).statusCode, 200)
    assert.equal((await rates('kp', secret)).statusCode, 403)
  })

  it('срок, отзыв, удаление: отказ 401 с причиной, в журнале — причина', async () => {
    const { key, secret } = await issue({ name: 'Подрядный отдел', scopes: ['kp'], expiresOn: '2099-12-31' })
    assert.equal(key.expiresOn, '2099-12-31')
    assert.equal((await rates('health', secret)).statusCode, 200)
    // Последний день действия — сегодня по Москве: ещё действует.
    const today = (await list()).today
    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}`, { expiresOn: today })).statusCode, 200)
    assert.equal((await rates('health', secret)).statusCode, 200)
    // Вчера: истёк (выпустить так нельзя — пишем в базу напрямую).
    internal(`update osp_private.api_keys set expires_on = (now() at time zone 'Europe/Moscow')::date - 1 where id = '${key.id}'`)
    const expired = await rates('kp', secret)
    assert.equal(expired.statusCode, 401)
    assert.equal(expired.json().code, 'OSP_API_KEY_EXPIRED')
    assert.equal((await list()).keys.find((k) => k.id === key.id).status, 'expired')
    // Продлить можно — и ключ снова действует.
    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}`, { expiresOn: null })).statusCode, 200)
    assert.equal((await rates('health', secret)).statusCode, 200)

    const revoked = await adminPost(`/api/admin/api-keys/${key.id}/revoke`, { reason: 'Ключ попал в общий чат' })
    assert.equal(revoked.statusCode, 200, revoked.body)
    assert.deepEqual([revoked.json().key.status, revoked.json().key.revokeReason, revoked.json().key.revokedByName],
      ['revoked', 'Ключ попал в общий чат', 'Админов Админ Админович'])
    const refused = await rates('kp', secret)
    assert.equal(refused.statusCode, 401)
    assert.equal(refused.json().code, 'OSP_API_KEY_REVOKED')
    assert.match(refused.json().error, /отозван/)
    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}/revoke`)).json().key.revokeReason, 'Ключ попал в общий чат', 'повторный отзыв ничего не меняет')
    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}`, { scopes: ['kp', 'supply'] })).statusCode, 409, 'права отозванного не меняются')
    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}`, { note: 'заменён ключом «Подрядный отдел 2»' })).statusCode, 200)

    const journal = await calls(`?key=${key.id}&errors=1`)
    assert.deepEqual(journal.calls.map((c) => [c.status, c.reason]), [[401, 'revoked'], [401, 'expired']])

    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}/delete`)).statusCode, 200)
    assert.ok(!(await list()).keys.some((k) => k.id === key.id), 'удалённого в списке нет')
    assert.equal((await rates('kp', secret)).json().code, 'OSP_API_KEY_REVOKED', 'удалённый ключ — отозван, а не неизвестен')
    assert.ok((await calls(`?key=${key.id}`)).calls.every((c) => c.keyDeleted), 'журнал удалённого остаётся')
    assert.equal((await adminPost(`/api/admin/api-keys/${key.id}/delete`)).statusCode, 404)

    // Удалить можно и действующий: он отзывается тем же действием.
    const live = await issue({ name: 'Временный', scopes: ['kp'] })
    assert.equal((await adminPost(`/api/admin/api-keys/${live.key.id}/delete`)).statusCode, 200)
    assert.equal((await rates('health', live.secret)).statusCode, 401)
  })

  it('ключи из настроек сервера: в списке, права — из строки, отозвать можно, убранный из строки — не действует', async () => {
    await makeApp(['rk-env-one:kp+larix', 'rk-env-two', 'rk-env-three:supply'])
    // До занесения в список (и без таблиц) ключ из настроек работает как раньше.
    assert.deepEqual((await rates('health', 'rk-env-one')).json(), { ok: true, resources: ['kp', 'larix'] })
    // Служба заносит их сама при запуске (фоном); повтор безопасен — здесь дожидаемся результата.
    assert.equal((await app.apiKeys.syncEnv()).registered, 3)
    const env = (await list()).keys.filter((k) => k.source === 'env').sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(env.map((k) => [k.name, k.prefix, k.scopes, k.status]), [
      ['Ключ из настроек сервера № 1', 'rk-e', ['kp', 'larix'], 'active'],
      ['Ключ из настроек сервера № 2', 'rk-e', ['kp', 'supply'], 'active'],
      ['Ключ из настроек сервера № 3', 'rk-e', ['supply'], 'active'],
    ])
    const [one, two, three] = env
    assert.ok(!internal('select string_agg(key_prefix, \',\') from osp_private.api_keys').includes('rk-env'), 'ключ целиком не хранится')

    assert.equal((await rates('kp', 'rk-env-one')).statusCode, 200)
    assert.equal((await rates('supply', 'rk-env-one')).statusCode, 403)
    const journal = await calls(`?key=${one.id}`)
    assert.deepEqual(journal.calls.map((c) => [c.resource, c.status]), [['supply', 403], ['kp', 200]])

    // Переименовать — можно, права и срок — только строкой на сервере.
    assert.equal((await adminPost(`/api/admin/api-keys/${one.id}`, { name: 'Тендерный отдел (старый ключ)' })).statusCode, 200)
    const env409 = await adminPost(`/api/admin/api-keys/${one.id}`, { scopes: ['kp', 'supply', 'larix'] })
    assert.equal(env409.statusCode, 409)
    assert.equal(env409.json().code, 'OSP_API_KEY_ENV')
    assert.equal((await adminPost(`/api/admin/api-keys/${one.id}`, { expiresOn: '2099-01-01' })).statusCode, 409)

    // Отозванный в портале не действует, хотя остался в строке.
    assert.equal((await adminPost(`/api/admin/api-keys/${two.id}/revoke`)).statusCode, 200)
    assert.equal((await rates('kp', 'rk-env-two')).json().code, 'OSP_API_KEY_REVOKED')

    // Перезапуск с другой строкой: права первого — из новой строки, третий убран — не действует.
    await makeApp(['rk-env-one:kp', 'rk-env-two'])
    assert.equal((await app.apiKeys.syncEnv()).registered, 2)
    const after = Object.fromEntries((await list()).keys.filter((k) => k.source === 'env').map((k) => [k.id, k]))
    assert.deepEqual([after[one.id].name, after[one.id].scopes, after[one.id].status], ['Тендерный отдел (старый ключ)', ['kp'], 'active'])
    assert.equal(after[two.id].status, 'revoked', 'возврат в строку отозванный ключ не оживляет')
    assert.equal(after[three.id].status, 'removed')
    assert.deepEqual((await rates('health', 'rk-env-one')).json(), { ok: true, resources: ['kp'] })
    const removed = await rates('health', 'rk-env-three')
    assert.equal(removed.statusCode, 401)
    assert.equal(removed.json().code, 'OSP_API_KEY_REMOVED')
    assert.equal((await rates('health', 'rk-env-two')).statusCode, 401)
  })

  it('журнал старше 90 дней чистится', async () => {
    const { key } = await issue({ name: 'Старый журнал', scopes: ['kp'] })
    internal(`insert into osp_private.api_key_calls (key_id, at, resource, status) values
      ('${key.id}', now() - interval '91 days', 'kp', 200), ('${key.id}', now() - interval '89 days', 'kp', 200)`)
    assert.equal(await app.apiKeys.cleanup(), 1)
    assert.equal(internal(`select count(*) from osp_private.api_key_calls where key_id = '${key.id}'`), '1')
  })
})
