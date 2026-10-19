// Права под одну учётку на копии прода — «старый путь против нового» (migration/CUTOVER.md, доказательство 2).
//
// В базе Яндекса у портала одна учётка-владелец: ролей anon / authenticated нет, правила по строкам
// действуют на владельца, вид пользователя приходит во внутреннем токене шлюза. Копия прода загружается
// настоящими инструментами переноса (load.sh --single-owner, rights.sh), затем:
//   1) цепочка целиком — клиент портала (src/api/ownDb.js) → шлюз osp-api → настоящий PostgREST с
//      настройками из deploy/postgrest → база: каждый вид пользователя получает через шлюз ровно столько
//      строк, сколько даёт база под теми же правами; записи, функции и отказы — как у Supabase;
//   2) замер прав (tests/db/fingerprint.sql) совпадает с эталоном прода tests/db/baseline/rights.json:
//      ничего не шире и не уже, отличия — только равнозначные «нет доступа».
// В вывод и в отказы идут только имена таблиц, виды пользователей и числа.
//
// Нужны Docker, psql, pg_restore, проверенная копия прода; для цепочки — образ PostgREST той же версии,
// что ставит deploy/postgrest/install.sh, и зависимости сервера (npm ci --prefix server/osp-api).
// Миграции-кандидаты (baseline/candidate-migrations.txt) написаны для ролей Supabase и здесь не
// накатываются: к настоящему переносу они уже применены на проде и приходят в копии.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, latestVerifiedCopy, startSingleOwner } from './lib/stand.mjs'
import { CLASSES, readExpected, candidateMigrations } from './lib/rights.mjs'
import { yandexAllowAnnotations } from '../../scripts/build-db-allow.mjs'
import { SECTIONS } from '../../src/contexts/roleConstants.js'
import { createOwnDb } from '../../src/api/ownDb.js'
import { SECRET, userToken, signToken } from '../osp-api/lib/tokens.mjs'

const SERVER = path.join(ROOT, 'server', 'osp-api')
const ALLOW = JSON.parse(fs.readFileSync(path.join(SERVER, 'src', 'data', 'allow.json'), 'utf8'))
const PGRST_VERSION = /^VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(ROOT, 'deploy', 'postgrest', 'install.sh'), 'utf8'))[1]
const PGRST_IMAGE = `postgrest/postgrest:v${PGRST_VERSION}`
const GATEWAY_SECRET = 'single-owner-gateway-secret-0123456789abcdef'
const SUPABASE_URL = 'https://single-owner.supabase.co'
const OPS = ['select', 'insert', 'update', 'delete']
// Материализованные представления реестра уходят из public в закрытую схему — в замере их нет.
const MOVED_OUT = ['kp_rates_registry_mv', 'supply_rates_registry_mv']

const skip = skipReason({ needCopy: true })
const chainSkip = (() => {
  if (skip) return skip
  if (!fs.existsSync(path.join(SERVER, 'node_modules', 'jose'))) return 'нет зависимостей: npm ci --prefix server/osp-api'
  if (spawnSync('docker', ['image', 'inspect', PGRST_IMAGE], { stdio: 'ignore' }).status !== 0) return `нет образа ${PGRST_IMAGE} (docker pull)`
  return false
})()

// Настройки PostgREST — из файла, который ставится на сервер: проверяется именно то, что будет работать.
function pgrstEnv(overrides) {
  const env = {}
  for (const line of fs.readFileSync(path.join(ROOT, 'deploy', 'postgrest', 'postgrest.env.example'), 'utf8').split('\n')) {
    const m = /^(PGRST_[A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2]
  }
  return { ...env, ...overrides }
}

describe('Права под одну учётку на копии прода: цепочка через шлюз и замер против эталона', { skip, timeout: 60 * 60 * 1000 }, () => {
  let db
  let pgrst = null
  let app = null
  let base = null
  const users = {}

  const internal = (sql) => db.sql(sql, { appName: 'osp:internal' })
  const claimsOf = (sub) => JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })
  // Сколько строк каждой таблицы и представления даёт сама база этому виду пользователя (без шлюза).
  const directCounts = (sub) => Object.fromEntries(db.sql(`begin transaction read only;
      select set_config('request.jwt.claims', '${claimsOf(sub)}', true);
      select c.relname || '|' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p', 'v');
      rollback;`, { appName: 'osp-test-direct' }).split('\n').filter((l) => /^[A-Za-z0-9_]+\|\d+$/.test(l)).map((l) => { const [t, n] = l.split('|'); return [t, Number(n)] }))
  const as = (sub) => createOwnDb({ baseUrl: base, getToken: async () => (sub ? userToken(SUPABASE_URL, sub) : null), fetchImpl: fetch })

  before(async () => {
    db = startSingleOwner(latestVerifiedCopy())
    users.admin = internal("select user_id from public.user_roles where role = 'admin' and is_approved and not coalesce(is_blocked, false) order by user_id limit 1")
    users.engineer = internal("select user_id from public.user_roles where role not in ('admin', 'contractor') and counterparty_id is null and is_approved and not coalesce(is_blocked, false) order by user_id limit 1")
    users.unapproved = internal("select coalesce((select user_id::text from public.user_roles where is_approved is not true order by user_id limit 1), '')")
    if (chainSkip) return

    const port = 29000 + Math.floor(Math.random() * 1000)
    const name = `osp-test-pgrst-${process.pid}-${port}`
    const env = pgrstEnv({ PGRST_DB_URI: db.url, PGRST_JWT_SECRET: GATEWAY_SECRET, PGRST_SERVER_PORT: String(port) })
    const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), PGRST_IMAGE], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    pgrst = { url: `http://127.0.0.1:${port}`, env, stop: () => spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' }) }
    // Готов, когда описание структуры базы прочитано: запрос без токена отклоняется (401), а не 503.
    const deadline = Date.now() + 120000
    for (;;) {
      const status = await fetch(`${pgrst.url}/app_settings?select=key&limit=1`).then((r) => r.status, () => 0)
      if (status === 401) break
      if (Date.now() > deadline) throw new Error(`PostgREST не поднялся (последний ответ ${status})`)
      await new Promise((r) => setTimeout(r, 500))
    }

    const { buildApp } = await import(path.join(SERVER, 'src', 'app.js'))
    app = buildApp({ logger: false, config: {
      host: '127.0.0.1', port: 0, supabaseUrl: SUPABASE_URL, supabaseAnonKey: 'k', supabaseServiceKey: '', supabaseJwtSecret: SECRET,
      s3: {}, anthropicApiKey: '', ratesApiKeys: [], required: ['supabase'],
      db: { url: db.url, caFile: '', poolMax: 2 },
      dbGateway: { upstream: pgrst.url, secret: GATEWAY_SECRET, dbRole: db.owner, readOnlyFile: '' },
    } })
    await app.listen({ host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${app.server.address().port}/api/db`
  })
  after(async () => {
    await app?.close()
    pgrst?.stop()
    db?.stop()
  })

  it('загрузка и права прошли своими проверками; в копии есть администратор и сотрудник', () => {
    assert.match(db.rights, /ИТОГ: права под одну учётку применены и проверены\./)
    assert.ok(!/^FAIL/m.test(db.rights), db.rights)
    assert.match(users.admin, /^[0-9a-f-]{36}$/)
    assert.match(users.engineer, /^[0-9a-f-]{36}$/)
  })

  describe('цепочка: клиент портала → шлюз → настоящий PostgREST → база', { skip: chainSkip }, () => {
    it('PostgREST работает с настройками из deploy/postgrest и принимает только токен шлюза', async () => {
      assert.deepEqual([pgrst.env.PGRST_DB_PRE_REQUEST, pgrst.env.PGRST_DB_MAX_ROWS, pgrst.env.PGRST_DB_SCHEMAS, pgrst.env.PGRST_OPENAPI_MODE],
        ['osp_private.pre_request', '1000', 'public', 'disabled'])
      const get = (token) => fetch(`${pgrst.url}/tenders?select=id&limit=1`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status)
      const exp = Math.floor(Date.now() / 1000) + 60
      assert.equal(await get(null), 401, 'без токена')
      assert.equal(await get(userToken(SUPABASE_URL, users.admin)), 401, 'токен входа браузера PostgREST не принимает')
      assert.equal(await get(signToken({ role: db.owner, osp_role: 'authenticated', sub: users.admin, exp }, 'x'.repeat(48))), 401, 'чужая подпись')
      // Подпись шлюза, но без вида пользователя — отклоняет база (osp_private.pre_request).
      assert.ok(await get(signToken({ role: db.owner, sub: users.admin, exp }, GATEWAY_SECRET)) >= 400, 'токен без osp_role')
      assert.equal(await get(signToken({ role: db.owner, osp_role: 'authenticated', sub: users.admin, exp }, GATEWAY_SECRET)), 200)
      assert.equal((await fetch(`${pgrst.url}/`)).status >= 400, true, 'описание структуры наружу не отдаётся')
    })

    it('каждый вид пользователя получает через шлюз столько же строк, сколько даёт база', async () => {
      const kinds = [['администратор', users.admin, 'authenticated'], ['сотрудник', users.engineer, 'authenticated'],
        ['посторонняя учётка', '00000000-0000-4000-8000-00000000dead', 'authenticated'], ['аноним', null, 'anon']]
      if (users.unapproved) kinds.push(['неодобренный', users.unapproved, 'authenticated'])
      const tables = Object.keys(ALLOW.tables).sort()
      // Таблицы и представления из миграций-кандидатов и из миграций базы нового портала (migration/yandex,
      // строки «-- osp:allow table …»): в список шлюза они входят заранее (scripts/build-db-allow.mjs), а в копии
      // прода появятся после применения миграции. Пока их нет — шлюз отвечает «не найдено» и строк не отдаёт;
      // больше ничего в списке без таблицы в базе быть не может.
      const candidateRelations = new Set([
        ...candidateMigrations().flatMap((f) =>
          [...fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')
            .matchAll(/create\s+(?:(?:or\s+replace\s+)?view|table(?:\s+if\s+not\s+exists)?)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)/gi)]
            .map((m) => m[1].toLowerCase())),
        ...yandexAllowAnnotations().filter((a) => a.kind === 'table' && a.entry).map((a) => a.name),
      ])
      const pending = []
      const differ = []
      const closedByGateway = []
      const timedOut = []
      let compared = 0
      let visible = 0
      for (const [kind, sub, role] of kinds) {
        const want = directCounts(sub)
        const client = as(sub)
        for (const t of tables) {
          // Первая строка и точное число — как считает страницы портал; при отказе в ответе есть код.
          const res = await client.from(t).select('*', { count: 'exact' }).range(0, 0)
          const allowed = (ALLOW.tables[t][role] || []).includes('select')
          if (!(t in want)) {
            assert.ok(candidateRelations.has(t), `${t}: в списке шлюза, но нет ни в копии, ни в миграциях-кандидатах`)
            // Этому виду пользователя чтение не выдано — шлюз отказывает раньше, чем спросит базу.
            if (!allowed) assert.ok(res.error && (res.status === 401 || res.status === 403), `${kind} / ${t}: шлюз должен отказать`)
            else assert.ok(res.error && res.status === 404 && res.error.code === 'PGRST205', `${kind} / ${t}: шлюз должен ответить «не найдено»`)
            pending.push(`${kind} / ${t}`)
            continue
          }
          if (!allowed) {
            assert.ok(res.error && (res.status === 401 || res.status === 403), `${kind} / ${t}: шлюз должен отказать`)
            // Шлюз закрыл чтение, а база этому виду пользователя строки показала бы: держится только списком.
            if (want[t] > 0) closedByGateway.push(`${kind} / ${t}`)
            continue
          }
          compared++
          // Учётка без доступа, полный подсчёт большой таблицы: правило вызывает функцию на каждую строку
          // (is_my_tender и подобные), и запрос может не уложиться в таймаут базы. Строк такой пользователь
          // не видит в любом случае — это не расхождение прав. Замер и причины — migration/CUTOVER.md,
          // «Известные отличия по скорости».
          if (res.error?.code === '57014' && want[t] === 0 && sub !== users.admin && sub !== users.engineer) {
            timedOut.push(`${kind} / ${t}`)
            continue
          }
          if (res.error || res.count !== want[t]) differ.push(`${kind} / ${t}: шлюз ${res.error ? `отказ ${res.status} ${res.error.code || ''}` : res.count} ≠ база ${want[t]}`)
          else if (res.count > 0) visible++
        }
      }
      assert.deepEqual(differ, [], `Шлюз и база расходятся:\n${differ.join('\n')}`)
      assert.deepEqual(closedByGateway, [], 'чтение, закрытое только списком шлюза, — базе нечем подстраховать')
      assert.ok(timedOut.length <= 8, `не уложились в таймаут (учётки без доступа): ${timedOut.join('; ')}`)
      if (timedOut.length) console.log(`полный подсчёт не уложился в таймаут у учёток без доступа: ${timedOut.join('; ')}`)
      if (pending.length) console.log(`ещё не в копии прода (миграции-кандидаты), шлюз отвечает «не найдено»: ${[...new Set(pending.map((p) => p.split(' / ')[1]))].join(', ')}`)
      assert.ok(compared > 200 && visible > 50, `сравнение не пустое: ${compared} замеров, из них со строками ${visible}`)
      // Администратор видит рабочие данные, аноним — только витрину.
      const admin = directCounts(users.admin)
      const anon = directCounts(null)
      assert.ok(admin.tenders > 0 && admin.contracts > 0 && admin.user_roles > 0)
      assert.equal(anon.contracts, 0)
      assert.equal(anon.user_roles, 0)
      assert.ok(anon.tenders < admin.tenders)
    })

    it('запросы портала: связи, порядок, страница, предел 1000 строк', async () => {
      const A = as(users.admin)
      const list = await A.from('tenders').select('*, objects(name, status), winner:counterparties!winner_counterparty_id(id, name), tender_winners(counterparty_id)')
        .order('created_at', { ascending: false }).range(0, 4)
      assert.equal(list.error, null)
      assert.equal(list.data.length, 5)
      for (const key of ['objects', 'winner', 'tender_winners']) assert.ok(key in list.data[0], key)
      // Без диапазона сервер отдаёт не больше 1000 строк — как Supabase: постраничные обходы портала на это рассчитаны.
      const big = await A.from('tender_estimate_items').select('id', { count: 'exact' })
      assert.equal(big.error, null)
      assert.ok(big.count > 1000, 'в копии прода позиций смет больше тысячи')
      assert.equal(big.data.length, 1000)
    })

    it('запись и функции: своя строка создаётся, меняется и удаляется; права — как на проде', async () => {
      const A = as(users.admin)
      const E = as(users.engineer)
      const key = `osp_single_owner_probe_${process.pid}`
      const ins = await A.from('app_settings').insert({ key, value: 'x' }).select('*').single()
      assert.equal(ins.error, null)
      assert.equal(ins.data.key, key)
      assert.equal((await A.from('app_settings').update({ value: 'y' }).eq('key', key).select('value').single()).data.value, 'y')
      assert.equal((await A.from('app_settings').delete().eq('key', key).select('key')).data.length, 1)
      assert.equal(internal(`select count(*) from public.app_settings where key = '${key}'`), '0', 'проверочной строки не осталось')

      assert.equal((await A.rpc('is_admin')).data, true)
      assert.equal((await E.rpc('is_admin')).data, false)
      assert.ok((await E.rpc('get_auth_users')).error, 'список учёток входа — только администратору')
      assert.equal((await A.rpc('touch_last_login')).error, null)
      assert.equal((await A.rpc('refresh_rates_registry')).error, null, 'пересчёт реестра работает из закрытой схемы')

      // Таблица «только чтение», материализованное представление, запись анонима — отказы шлюза.
      const readOnly = await E.from('psdc_rows').insert({ psdc_id: '00000000-0000-4000-8000-000000000000' })
      assert.deepEqual([readOnly.status, readOnly.error.code], [403, '42501'])
      const mv = await A.from('kp_rates_registry_mv').select('id').limit(1)
      assert.deepEqual([mv.status, mv.error.code], [404, 'PGRST205'])
      const anonWrite = await as(null).from('tenders').insert({ work_description: 'x' })
      assert.deepEqual([anonWrite.status, anonWrite.error.code], [401, '42501'])
      const anonRpc = await as(null).rpc('is_admin')
      assert.equal(anonRpc.status, 401)
    })

    it('сервер сам видит, что копия — репетиция: учётки входа не меняет, готовность это показывает', async () => {
      const ready = (await app.inject({ method: 'GET', url: '/api/ready' })).json()
      assert.deepEqual([ready.checks.db, ready.checks.gateway, ready.data], ['ok', 'ok', 'rehearsal'])
      const before = internal('select count(*) from public.user_roles')
      const res = await as(users.admin).rpc('admin_delete_user', { target_user_id: users.engineer })
      assert.deepEqual([res.status, res.error.code], [409, 'OSP_REHEARSAL'])
      assert.equal(internal('select count(*) from public.user_roles'), before, 'строки пользователей на месте')
    })
  })

  // Последним: замер заводит в копии своих проверочных пользователей.
  it('замер прав под одной учёткой совпадает с эталоном прода: ничего не шире и не уже', () => {
    const run = (text, file) => db.sql(text, { file, appName: 'osp:internal', options: '-c osp_test.single_owner=on' })
    run(null, path.join(ROOT, 'tests', 'db', 'fingerprint.sql'))
    const sections = Object.keys(SECTIONS).map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
    run(`select osp_test.setup(array[${sections}]::text[])`)
    const actual = { classes: {}, self_promote: {} }
    for (const c of CLASSES) {
      actual.classes[c] = JSON.parse(run(`select osp_test.fingerprint('${c}')::text`))
      const promoted = run(`select osp_test.self_promote('${c}')`)
      if (promoted !== 'n/a') actual.self_promote[c] = promoted
    }
    if (process.env.ACTUAL_OUT) fs.writeFileSync(process.env.ACTUAL_OUT.replace(/(\.json)?$/, '.single-owner.json'), JSON.stringify(actual, null, 2) + '\n')

    // Кандидаты сюда не накатываются (см. шапку) — их исправления в ожидание не входят.
    const exp = readExpected({ withCandidates: false })
    // «Нет доступа» выражается по-разному: на проде — отказ по выдаче прав (err:42501), под одной учёткой —
    // ноль строк по правилу. Сравниваем по смыслу: нет / часть / всё.
    const rank = (v) => ({ none: 0, no: 0, 'err:42501': 0, some: 1, visible: 1, all: 2, yes: 2 }[v])
    const role = (c) => (c === 'anon' ? 'anon' : c === 'service_role' ? null : 'authenticated')
    const stats = { same: 0, equivalent: 0, incomparable: 0 }
    const wider = []
    const narrower = []
    const other = []
    const gatewayOnly = []
    const missing = new Set()
    const extra = new Set()
    for (const c of CLASSES) {
      const tables = new Set([...Object.keys(exp.classes[c]), ...Object.keys(actual.classes[c])])
      for (const t of [...tables].sort()) {
        const e = exp.classes[c][t]
        const a = actual.classes[c][t]
        if (!a) { missing.add(t); continue }
        if (!e) { extra.add(t); continue }
        for (const op of OPS) {
          const ev = e[op]
          const av = a[op]
          const cell = `${c} / ${t} / ${op}: на проде ${ev}, здесь ${av}`
          if (ev === av) { stats.same++; continue }
          if ([ev, av].some((v) => v === undefined || v === 'empty' || v === 'n/a')) { stats.incomparable++; continue }
          const re = rank(ev)
          const ra = rank(av)
          if (re === undefined || ra === undefined) { other.push(cell); continue }
          if (re === ra) { stats.equivalent++; continue }
          if (ra < re) { narrower.push(cell); continue }
          // Шире. Если на проде это держала только выдача прав — под одной учёткой держит список шлюза.
          const closed = ev === 'err:42501' && role(c) && !(ALLOW.tables[t]?.[role(c)] || []).includes(op)
          ;(closed ? gatewayOnly : wider).push(cell)
        }
      }
    }
    assert.deepEqual(wider, [], `ШИРЕ, чем на проде:\n${wider.join('\n')}`)
    assert.deepEqual(narrower, [], `УЖЕ, чем на проде (портал потеряет доступ):\n${narrower.join('\n')}`)
    assert.deepEqual(other, [], `Непонятные значения:\n${other.join('\n')}`)
    assert.deepEqual(gatewayOnly, [], `Держится только списком шлюза — базе нечем подстраховать:\n${gatewayOnly.join('\n')}`)
    assert.deepEqual([...missing].sort(), MOVED_OUT, 'из public ушли только материализованные представления реестра')
    assert.deepEqual([...extra], [], 'новых таблиц в public нет')
    assert.ok(stats.same > 3000, `сравнение не пустое: совпало ${stats.same}, равнозначно ${stats.equivalent}, несравнимо ${stats.incomparable}`)
    assert.ok(stats.incomparable < 50, `несравнимых ячеек (пустые таблицы) немного: ${stats.incomparable}`)
    // Никто не может сделать себя администратором — как на проде. Отказ выражен по-разному: на проде —
    // ошибка записи (нет выдачи прав), здесь запись не находит строки; дыра — только значение 'admin'.
    assert.deepEqual(Object.keys(actual.self_promote).sort(), Object.keys(exp.self_promote).sort())
    for (const [c, v] of Object.entries(actual.self_promote)) assert.ok(v === 'not_admin' || v.startsWith('err:'), `${c}: ${v}`)
    for (const [c, v] of Object.entries(exp.self_promote)) assert.notEqual(v, 'admin', `эталон прода, ${c}`)
    // Функции анониму: на проде — отказ самой функции или отсутствие выдачи; здесь аноним до функций не доходит.
    assert.ok(Object.values(ALLOW.rpc).every((roles) => !roles.includes('anon')), 'анониму шлюз не выдаёт ни одной функции')
    console.log(`замер под одной учёткой: совпало ${stats.same}, равнозначно ${stats.equivalent}, несравнимо ${stats.incomparable}; шире 0, уже 0`)
  })
})
