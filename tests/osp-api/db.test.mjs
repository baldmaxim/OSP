// Обёртка транзакции osp-api (server/osp-api/src/lib/db.js) на настоящем PostgreSQL.
// Проверяем гарантии, на которых держится «одна учётка базы — права проверяет API»:
//   • читающая операция не может изменить данные;
//   • «кто вошёл», роль и таймауты не переходят к следующему запросу на том же подключении;
//   • ошибка откатывает всё; испорченное подключение в пул не возвращается;
//   • запрос — одна параметризованная команда;
//   • второй замок (роль authenticated) включается только для операций пользователя.
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = !fs.existsSync(path.join(SERVER, 'node_modules', 'pg')) ? 'нет зависимостей: npm ci --prefix server/osp-api'
  : !pgAvailable() ? 'нет PostgreSQL (бинарники или Docker)' : false

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.ru' }
const USER = { userId: '22222222-2222-4222-8222-222222222222', email: 'user@example.ru' }

// База «как у портала»: «кто вошёл» читается из настройки транзакции, строки делит правило таблицы.
const SETUP = `
create role authenticated nologin;
create role api_login login password 'api-test' in role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
grant usage on schema auth to authenticated;
create table public.notes(id int primary key, owner uuid not null, body text not null);
alter table public.notes owner to api_login;
alter table public.notes enable row level security;
create policy own_rows on public.notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
grant select, insert, update, delete on public.notes to authenticated;
insert into public.notes values (1, '${ADMIN.userId}', 'админа'), (2, '${USER.userId}', 'пользователя'), (3, '${USER.userId}', 'ещё пользователя');
`

describe('osp-api: обёртка транзакции — единственный путь к базе', { skip, timeout: 300000 }, () => {
  let pgdb
  let createDb
  let url
  const open = (over = {}) => createDb({ connectionString: url, max: 1, ...over })
  const state = (tx) => tx.query(`select current_user as usr,
      coalesce(current_setting('request.jwt.claims', true), '') as claims,
      current_setting('statement_timeout') as st, current_setting('transaction_read_only') as ro,
      current_setting('search_path') as sp, pg_backend_pid() as pid`).then((r) => r.rows[0])

  before(async () => {
    ;({ createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js')))
    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP)
    url = `postgres://api_login:api-test@127.0.0.1:${pgdb.port}/psdc_test`
  })
  after(() => pgdb?.stop())

  it('read — только чтение: запись отклоняет сама база, данные не меняются', async () => {
    const db = open()
    try {
      assert.equal((await db.read(null, state)).ro, 'on')
      await assert.rejects(db.read(null, (tx) => tx.query('insert into public.notes values (9, $1, $2)', [ADMIN.userId, 'x'])),
        (e) => e.code === '25006')
      await assert.rejects(db.read(null, (tx) => tx.query('delete from public.notes')), (e) => e.code === '25006')
      assert.equal((await db.read(null, (tx) => tx.query('select count(*)::int as n from public.notes'))).rows[0].n, 3)
      assert.equal((await db.write(null, state)).ro, 'off')
    } finally { await db.close() }
  })

  it('write — всё или ничего: ошибка в середине откатывает уже сделанное, подключение остаётся рабочим', async () => {
    const db = open()
    try {
      await assert.rejects(db.write(null, async (tx) => {
        await tx.query('insert into public.notes values (10, $1, $2)', [ADMIN.userId, 'первая'])
        await tx.query('insert into public.notes values (10, $1, $2)', [ADMIN.userId, 'дубль'])  // 23505
      }), (e) => e.code === '23505')
      await assert.rejects(db.write(null, async (tx) => {
        await tx.query('insert into public.notes values (11, $1, $2)', [ADMIN.userId, 'запись'])
        throw new Error('сбой в коде операции')
      }), /сбой в коде операции/)
      const ids = (await db.read(null, (tx) => tx.query('select id from public.notes order by id'))).rows.map((r) => r.id)
      assert.deepEqual(ids, [1, 2, 3], 'ни одна строка из прерванных операций не осталась')
      await db.write(null, (tx) => tx.query('insert into public.notes values (12, $1, $2)', [ADMIN.userId, 'успех']))
      assert.equal((await db.read(null, (tx) => tx.query('select count(*)::int as n from public.notes where id = 12'))).rows[0].n, 1)
      await db.write(null, (tx) => tx.query('delete from public.notes where id = 12'))
      assert.deepEqual(db.stats(), { max: 1, total: 1, idle: 1, waiting: 0 })
    } finally { await db.close() }
  })

  it('«кто вошёл», роль и таймауты не переходят к следующему запросу на том же подключении', async () => {
    const db = open({ secondLockRole: 'authenticated', statementTimeoutMs: 4321 })
    try {
      const a = await db.read(ADMIN, state)
      assert.equal(a.usr, 'authenticated')
      assert.deepEqual(JSON.parse(a.claims), { sub: ADMIN.userId, role: 'authenticated', email: ADMIN.email }, 'в базу уходит только собранный сервером контекст')
      assert.equal(a.st, '4321ms')
      // Следующий запрос — без пользователя, на том же подключении (пул из одного).
      const b = await db.read(null, state)
      assert.equal(b.pid, a.pid, 'то же подключение')
      assert.equal(b.usr, 'api_login', 'роль пользователя не осталась')
      assert.equal(b.claims, '', '«кто вошёл» не остался')
      // И после сбоя посреди операции пользователя — тоже.
      await assert.rejects(db.write(ADMIN, (tx) => tx.query('select 1/0')), (e) => e.code === '22012')
      const c = await db.read(null, state)
      assert.equal(c.pid, a.pid)
      assert.equal(c.usr, 'api_login')
      assert.equal(c.claims, '')
      assert.equal(c.sp, a.sp, 'search_path прежний')
      // Другой пользователь на том же подключении видит себя, а не предыдущего.
      assert.equal(JSON.parse((await db.read(USER, state)).claims).sub, USER.userId)
    } finally { await db.close() }
  })

  it('второй замок: под ролью пользователя действуют правила по строкам; служебная операция идёт под учёткой подключения', async () => {
    const locked = open({ secondLockRole: 'authenticated' })
    const plain = open()
    const ids = (db, who) => db.read(who, (tx) => tx.query('select id from public.notes order by id')).then((r) => r.rows.map((x) => x.id))
    try {
      assert.deepEqual(await ids(locked, ADMIN), [1], 'вошедший видит только свои строки')
      assert.deepEqual(await ids(locked, USER), [2, 3])
      // Чужую строку не изменить и не присвоить себе чужое авторство — отказывает правило базы.
      assert.equal((await locked.write(USER, (tx) => tx.query("update public.notes set body = 'взлом' where id = 1"))).rowCount, 0)
      await assert.rejects(locked.write(USER, (tx) => tx.query('insert into public.notes values (20, $1, $2)', [ADMIN.userId, 'от чужого имени'])),
        (e) => e.code === '42501')
      // Без второго замка (как будет в базе Яндекса) учётка-владелец видит всё: делить обязан код операции.
      assert.deepEqual(await ids(plain, ADMIN), [1, 2, 3])
      assert.deepEqual(await ids(locked, null), [1, 2, 3], 'служебная операция — под учёткой подключения')
    } finally { await locked.close(); await plain.close() }
  })

  it('запрос — одна параметризованная команда; вход без идентификатора отклоняется до базы', async () => {
    const db = open()
    try {
      await assert.rejects(db.read(null, (tx) => tx.query('select 1; select 2')), /multiple commands|cannot insert multiple/)
      await assert.rejects(db.write(null, (tx) => tx.query("insert into public.notes values (30, $1, 'a'); delete from public.notes", [ADMIN.userId])),
        /multiple commands|cannot insert multiple/)
      await assert.rejects(db.read(null, (tx) => tx.query({ text: 'select 1' })), TypeError)
      await assert.rejects(db.read(null, (tx) => tx.query('select $1::int', 5)), TypeError)
      await assert.rejects(db.read({ userId: "1' or '1'='1" }, state), TypeError)
      await assert.rejects(db.read({ email: 'x@example.ru' }, state), TypeError)
      // Значение с кавычками уходит параметром и остаётся значением.
      const tricky = "'; drop table public.notes; --"
      assert.equal((await db.read(null, (tx) => tx.query('select $1::text as v', [tricky]))).rows[0].v, tricky)
      assert.equal((await db.read(null, (tx) => tx.query('select count(*)::int as n from public.notes'))).rows[0].n, 3)
    } finally { await db.close() }
  })

  it('сбои подключения: таймаут запроса и убитое подключение не оставляют пул в плохом состоянии', async () => {
    const db = open({ statementTimeoutMs: 300 })
    try {
      await assert.rejects(db.read(null, (tx) => tx.query('select pg_sleep(3)')), (e) => e.code === '57014')
      const first = await db.read(null, state)
      assert.equal(first.usr, 'api_login', 'после таймаута подключение рабочее')
      // Подключение обрывают со стороны сервера посреди операции: ROLLBACK не проходит —
      // подключение уничтожается, следующий запрос получает новое.
      await assert.rejects(db.write(null, async (tx) => {
        await tx.query('insert into public.notes values (40, $1, $2)', [ADMIN.userId, 'не должна остаться'])
        pgdb.exec(`select pg_terminate_backend(${first.pid});`)
        await tx.query('select 1')
      }))
      const next = await db.read(null, state)
      assert.notEqual(next.pid, first.pid, 'испорченное подключение в пул не вернулось')
      assert.equal((await db.read(null, (tx) => tx.query('select count(*)::int as n from public.notes where id = 40'))).rows[0].n, 0)
      assert.equal(db.stats().total, 1)
    } finally { await db.close() }
  })

  it('подключений не больше лимита: лишние запросы ждут очереди и все выполняются', async () => {
    const db = open({ max: 2 })
    try {
      let peak = 0
      const jobs = Array.from({ length: 8 }, (_, i) => db.read(null, async (tx) => {
        peak = Math.max(peak, db.stats().total)
        await tx.query('select pg_sleep(0.05)')
        return i
      }))
      assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7])
      assert.ok(peak <= 2, `открыто подключений: ${peak}`)
      assert.ok(db.stats().total <= 2)
    } finally { await db.close() }
  })

  it('без строки подключения и с недопустимым именем роли обёртка не создаётся', () => {
    assert.throws(() => createDb({}), /не задана строка подключения/)
    assert.throws(() => createDb({ connectionString: url, secondLockRole: 'authenticated; drop' }), /недопустимое имя роли/)
  })
})
