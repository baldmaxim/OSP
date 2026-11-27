// Права на функции базы сверки с SIGNAL (миграция 20270228_signal_integration, С-22) и вторая линия защиты от прямого вызова.
//   • каталог: ни одна функция osp_private.signal_* не выдана «всем» (EXECUTE у PUBLIC снят — пробы Y1/Y2 рецензента); роль без выдач
//     (учётка сотрудника, если бы она подключалась к базе напрямую) не исполняет НИ ОДНОЙ; каждая функция отнесена к одному из трёх
//     классов — служебная (osp-api без вошедшего), пользовательская (db.read/db.write от имени вошедшего), внутренняя;
//   • служебные первой строкой отказывают SG403 при непустом auth.uid() — и под claims сотрудника, и администратора;
//   • внутренние помощники под claims сотрудника не выдают чужое: signal_node_json, signal_contract_input, signal_publish,
//     signal_mark_root_errors — SG403; signal_recompute_objects и signal_enqueue_impl — только администратору / сотруднику с правкой;
//     signal_contract_ok и signal_node_visible — false вне охвата и без права раздела;
//   • вызов под учёткой сотрудника ничего не портит: signal_publish с чужим id не публикует отложенный прогон (проба Y2).
// Нужны зависимости сервера и PostgreSQL (бинарники или Docker). Данные вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip, uuid } from './lib/signal-db.mjs'

// Классы функций: набор обязан совпадать с каталогом — новая функция без класса роняет тест.
const SERVICE = ['signal_sync_due', 'signal_sync_begin', 'signal_sync_heartbeat', 'signal_stage_put', 'signal_sync_fail', 'signal_sync_finish',
  'signal_accept_held', 'signal_sources_for_sync', 'signal_enqueue_all', 'signal_enqueue_missed', 'signal_queue_claim', 'signal_queue_release',
  'signal_match_load', 'signal_match_nodes', 'signal_state_write']
const USER = ['signal_user_flags', 'signal_marks', 'signal_contract_view', 'signal_folders_search', 'signal_confirm', 'signal_reject', 'signal_unlink',
  'signal_alias_create', 'signal_alias_delete', 'signal_alias_list', 'signal_admin_state', 'signal_runs', 'signal_source_add', 'signal_source_update',
  'signal_binding_set', 'signal_unassigned', 'signal_tree', 'signal_bindings_list', 'signal_binding_preview']
const INTERNAL = ['signal_require', 'signal_contract_ok', 'signal_node_visible', 'signal_actor', 'signal_node_json', 'signal_enqueue_impl', 'signal_publish',
  'signal_mark_root_errors', 'signal_recompute_objects', 'signal_contract_input', 'signal_run_json', 'signal_jsonb_texts', 'signal_jsonb_uuids',
  'signal_like_escape', 'signal_norm_link', 'signal_name_key', 'signal_alias_clash', 'signal_tree_item', 'signal_audit_row', 'signal_enqueue_trg']

describe('База сверки с SIGNAL: права на функции и прямой вызов внутренних помощников', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let seed
  let A
  let B
  let other
  let viewer
  let editor
  let admin
  let contractor
  let src
  let snap
  let dpA
  const q = (text) => db.sql(text)

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
    A = seed.object({ name: 'Тест: объект А', code: 'ПРА' })
    B = seed.object({ name: 'Тест: объект Б', code: 'ПРБ' })
    admin = seed.admin()
    viewer = seed.user({ contracts: 'view', objectIds: [A], objectScoped: true })
    editor = seed.user({ contracts: 'edit', objectIds: [A], objectScoped: true })
    other = seed.user({ contracts: 'edit', objectIds: [B], objectScoped: true })
    contractor = seed.contractor({ objectIds: [A] })
    const cp = seed.counterparty({ name: 'ООО Секрет', inn: '7707083893' })
    dpA = seed.contract({ number: 'ПРА-ДП-26-005', objectId: A, counterparties: [cp] })
    src = seed.source({ objectIds: [A] })
    snap = seed.snapshot(src.id, { name: 'R2', children: [{ name: 'ДП ПРА-ДП-26-005 ООО Секрет', numberKeys: ['ПРА|2026|5'] }] }, { generation: 2 })
  })
  after(async () => { await db?.stop() })

  const folder = () => snap.ids['R2 / ДП ПРА-ДП-26-005 ООО Секрет']
  const err = (uid, call) => { const e = db.asError(uid, `select osp_private.${call}`); return e && [e.code, e.message] }

  it('Y1: ни одна функция signal_* не выдана «всем»; роль без выдач не исполняет ни одну; классы функций полны (служебные, пользовательские, внутренние)', () => {
    const rows = q(`select p.proname || '|' || has_function_privilege('public', p.oid, 'EXECUTE') || '|' || (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname like 'signal\\_%' order by 1`).split('\n').map((r) => r.split('|'))
    const names = [...new Set(rows.map((r) => r[0]))].sort()
    assert.deepEqual(names, [...SERVICE, ...USER, ...INTERNAL].sort(), 'каждая функция signal_* отнесена к классу, лишних нет')
    assert.equal(new Set([...SERVICE, ...USER, ...INTERNAL]).size, SERVICE.length + USER.length + INTERNAL.length, 'классы не пересекаются')
    assert.deepEqual(rows.filter((r) => r[1] === 'true' || r[2] === 'true').map((r) => r[0]), [], 'EXECUTE у PUBLIC снят у всех')
    // Роль «сотрудник» с доступом к схеме, но без выдач на функции, не исполняет ни одну из них; владелец (учётка подключения) — все.
    db.pgdb.exec(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'signal_employee_probe') then create role signal_employee_probe nologin; end if; end $$;
      grant usage on schema osp_private to signal_employee_probe`)
    const exec = q(`select p.proname || '|' || has_function_privilege('signal_employee_probe', p.oid, 'EXECUTE') || '|' || has_function_privilege('osp_owner', p.oid, 'EXECUTE')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname like 'signal\\_%' order by 1`).split('\n').map((r) => r.split('|'))
    assert.deepEqual(exec.filter((r) => r[1] === 'true').map((r) => r[0]), [], 'роль сотрудника: ни одной исполняемой функции')
    assert.deepEqual(exec.filter((r) => r[2] !== 'true').map((r) => r[0]), [], 'учётка подключения исполняет все')
    // Прямой вызов под ролью без выдачи — отказ базы («нет права»), а не функции.
    assert.throws(() => db.pgdb.exec(`SET ROLE signal_employee_probe;\nselect osp_private.signal_norm_link('x');`), /permission denied for function signal_norm_link/)
    assert.throws(() => db.pgdb.exec(`SET ROLE signal_employee_probe;\nselect osp_private.signal_user_flags();`), /permission denied for function signal_user_flags/)
    db.pgdb.exec('drop owned by signal_employee_probe; drop role signal_employee_probe')
  })

  it('Y1: служебные функции первой строкой отказывают SG403 — вошедшему сотруднику, администратору и неизвестному; пользовательские и внутренние проверяют вошедшего', () => {
    const calls = {
      signal_sync_due: 'signal_sync_due()', signal_sync_begin: "signal_sync_begin('manual', 'full', 'admin', null)",
      signal_sync_heartbeat: 'signal_sync_heartbeat(1, gen_random_uuid())', signal_stage_put: "signal_stage_put(1, gen_random_uuid(), '[]'::jsonb)",
      signal_sync_fail: "signal_sync_fail(1, gen_random_uuid(), 'failed', 'http', '{}'::jsonb)", signal_sync_finish: "signal_sync_finish(1, gen_random_uuid(), '{}'::jsonb)",
      signal_accept_held: "signal_accept_held(1, 0, 'cli', 'проверка')", signal_sources_for_sync: 'signal_sources_for_sync()', signal_enqueue_all: 'signal_enqueue_all()',
      signal_enqueue_missed: 'signal_enqueue_missed()', signal_queue_claim: 'signal_queue_claim(10)',
      signal_queue_release: "signal_queue_release(gen_random_uuid(), '{}'::uuid[], 1)", signal_match_load: "signal_match_load('{}'::uuid[])",
      signal_match_nodes: 'signal_match_nodes(null, null, null, null, null)', signal_state_write: "signal_state_write(null, '[]'::jsonb)",
    }
    assert.deepEqual(Object.keys(calls).sort(), SERVICE.slice().sort())
    for (const [name, call] of Object.entries(calls)) {
      for (const uid of [admin, editor, viewer, uuid('z', 99)]) assert.deepEqual(err(uid, call), ['SG403', 'forbidden'], `${name} под ${uid}`)
      // Те же функции без вошедшего (служебная операция osp-api) не отказывают по uid.
      const e = db.sqlError(`select osp_private.${call}`)
      assert.ok(!e || e.code !== 'SG403', `${name}: без вошедшего не SG403 (${e?.message})`)
    }
    assert.ok(Number(q('select osp_private.signal_enqueue_missed()')) >= 0)
  })

  it('С-22: внутренние помощники под claims сотрудника не выдают чужое (node_json, contract_input, publish, mark_root_errors) и не меняют данные (recompute, enqueue)', () => {
    // Были открыты: имя и путь любого узла, реквизиты и стороны (ИНН) любого договора.
    for (const uid of [editor, viewer, other, contractor, admin]) {
      assert.deepEqual(err(uid, `signal_node_json('${folder()}')`), ['SG403', 'forbidden'], `node_json ${uid}`)
      assert.deepEqual(err(uid, `signal_contract_input('${dpA}')`), ['SG403', 'forbidden'], `contract_input ${uid}`)
      assert.deepEqual(err(uid, "signal_publish(999999, array[1]::bigint[])"), ['SG403', 'forbidden'], `publish ${uid}`)
      assert.deepEqual(err(uid, "signal_mark_root_errors('{}'::jsonb, 'x')"), ['SG403', 'forbidden'], `mark_root_errors ${uid}`)
    }
    // Служебный вход по-прежнему отдаёт всё это службе.
    assert.equal(db.sqlJson(`select osp_private.signal_node_json('${folder()}')`).name, 'ДП ПРА-ДП-26-005 ООО Секрет')
    assert.equal(db.sqlJson(`select osp_private.signal_contract_input('${dpA}')`).counterparties[0].inn, '7707083893')
    // Пересчёт границы — администратору; сотруднику (даже с правкой) и подрядчику — нет.
    for (const uid of [editor, viewer, other, contractor]) assert.deepEqual(err(uid, `signal_recompute_objects(${src.id})`), ['SG403', 'forbidden'], `recompute ${uid}`)
    assert.equal(db.asError(admin, `select osp_private.signal_recompute_objects(${src.id})`), null)
    // Постановка в очередь всех договоров — сотруднику с правкой и администратору; просмотр, подрядчик, без права — нет.
    q('delete from osp_private.signal_queue')
    for (const uid of [viewer, contractor, seed.user({ contracts: null }), uuid('z', 98)]) assert.deepEqual(err(uid, 'signal_enqueue_impl(null)'), ['SG403', 'forbidden'])
    assert.equal(q('select count(*) from osp_private.signal_queue'), '0', 'отказ ничего не поставил')
    assert.equal(db.asError(editor, 'select osp_private.signal_enqueue_impl(null)'), null)
    assert.ok(Number(q('select count(*) from osp_private.signal_queue')) >= 1)
    // Проверка ключа синонима — только правка и администратор.
    for (const uid of [viewer, contractor]) assert.deepEqual(err(uid, `signal_alias_clash('ключ', '${A}')`), ['SG403', 'forbidden'])
    assert.equal(db.as(editor, `select osp_private.signal_alias_clash('тест: объект б', '${A}')`), 't', 'ключ равен названию чужого объекта')
    assert.equal(db.as(editor, `select osp_private.signal_alias_clash('тест: объект а', '${A}')`), 'f', 'название своего объекта конфликтом не считается')
  })

  it('С-22: signal_contract_ok и signal_node_visible при прямом вызове — false вне охвата, подрядчику, без права раздела и без вошедшего; свой договор и свой узел — true', () => {
    const ok = (uid, c) => db.as(uid, `select osp_private.signal_contract_ok('${c}')`) === 't'
    const vis = (uid, n, c, obs = false) => db.as(uid, `select osp_private.signal_node_visible('${n}', '${c}', ${obs})`) === 't'
    assert.equal(ok(editor, dpA), true)
    assert.equal(ok(viewer, dpA), true)
    assert.equal(ok(admin, dpA), true)
    for (const [who, uid] of [['чужой объект', other], ['подрядчик', contractor], ['без права', seed.user({ contracts: null, objectIds: [A] })], ['нет строки', uuid('z', 97)]]) {
      assert.equal(ok(uid, dpA), false, `contract_ok: ${who}`)
      assert.equal(vis(uid, folder(), dpA), false, `node_visible: ${who}`)
    }
    assert.equal(q(`select osp_private.signal_contract_ok('${dpA}')`), 'f', 'без вошедшего — false')
    assert.equal(q(`select osp_private.signal_node_visible('${folder()}', '${dpA}')`), 'f')
    assert.equal(vis(editor, folder(), dpA), true)
    assert.equal(vis(editor, folder(), dpA, true), true, 'виден и в последнем обходе')
    q(`update osp_private.signal_nodes set seen_gen = 0 where node_id = '${folder()}'`)
    assert.equal(vis(editor, folder(), dpA, true), false, 'не виден в последнем обходе')
    assert.equal(vis(editor, folder(), dpA), true)
    q(`update osp_private.signal_nodes set seen_gen = 2 where node_id = '${folder()}'`)
  })

  it('Y2: signal_publish под claims сотрудника не публикует отложенный прогон: поколение и staging прежние', () => {
    q('delete from osp_private.signal_runs')
    const run = JSON.parse(q("select osp_private.signal_sync_begin('manual', 'full', 'cli', null)").split('\n')[0])
    const staged = seed.stageRows(src.id, { name: 'R2', children: [{ name: 'Корпус 1' }] }, { ids: snap.ids })
    q(`select osp_private.signal_stage_put(${run.runId}, '${run.ownerToken}', '${JSON.stringify(staged.rows).replace(/'/g, "''")}'::jsonb)`)
    q(`update osp_private.signal_runs set status = 'held', reason = 'shrink', finished_at = now() where id = ${run.runId}`)
    const gen = q('select generation from osp_private.signal_meta')
    const stage = q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${run.runId}`)
    assert.deepEqual(err(viewer, `signal_publish(${run.runId}, array[${src.id}]::bigint[])`), ['SG403', 'forbidden'])
    assert.deepEqual(err(editor, `signal_publish(999999, array[${src.id}]::bigint[])`), ['SG403', 'forbidden'])
    assert.equal(q('select generation from osp_private.signal_meta'), gen)
    assert.equal(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${run.runId}`), stage)
    assert.equal(q(`select reason from osp_private.signal_runs where id = ${run.runId}`), 'shrink')
    q('delete from osp_private.signal_runs')
  })

  it('Y1: пользовательские функции проверяют вошедшего: без строки ролей, подрядчик, без права раздела — SG403; сотрудник без правки — только просмотр', () => {
    const user = (name) => ({ name, args: {
      signal_user_flags: '', signal_marks: 'null, 10', signal_contract_view: `'${dpA}'`, signal_folders_search: `'${dpA}', '', null, 5`,
      signal_alias_list: '', signal_admin_state: '', signal_runs: '5', signal_unassigned: `${src.id}, null, 10`, signal_tree: `${src.id}`,
      signal_bindings_list: `${src.id}`, signal_binding_preview: `${src.id}, '${folder()}', '${A}'`, signal_binding_set: `${src.id}, '${folder()}', null`,
      signal_source_update: `${src.id}, null, null`, signal_alias_delete: '999999' }[name] })
    for (const [who, uid] of [['подрядчик', contractor], ['без права', seed.user({ contracts: null, objectIds: [A] })], ['нет строки', uuid('z', 96)]]) {
      for (const name of ['signal_marks', 'signal_contract_view', 'signal_folders_search', 'signal_alias_list', 'signal_admin_state', 'signal_runs', 'signal_unassigned',
        'signal_tree', 'signal_bindings_list', 'signal_binding_preview', 'signal_binding_set', 'signal_source_update', 'signal_alias_delete']) {
        assert.deepEqual(err(uid, `${name}(${user(name).args})`), ['SG403', 'forbidden'], `${who}: ${name}`)
      }
    }
    // Просмотр: окно и значки — да; всё админское и правка — нет.
    assert.ok(db.asJson(viewer, `select osp_private.signal_contract_view('${dpA}')`))
    for (const name of ['signal_folders_search', 'signal_admin_state', 'signal_runs', 'signal_unassigned', 'signal_tree', 'signal_bindings_list', 'signal_binding_preview', 'signal_binding_set']) {
      assert.equal(err(viewer, `${name}(${user(name).args})`)?.[0], 'SG403', `просмотр: ${name}`)
    }
    // Правка (сотрудник): синонимы — да (свои, С-2), админское — нет.
    assert.deepEqual(db.asJson(editor, 'select osp_private.signal_alias_list()'), { items: [] })
    for (const name of ['signal_admin_state', 'signal_runs', 'signal_tree', 'signal_bindings_list', 'signal_binding_preview', 'signal_binding_set']) {
      assert.equal(err(editor, `${name}(${user(name).args})`)?.[0], 'SG403', `правка: ${name}`)
    }
  })
})
