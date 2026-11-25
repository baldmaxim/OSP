// Граница объекта в базе сверки с SIGNAL (миграция 20270228_signal_integration): перевёрнутые пробы судьи и рецензентов.
//   • К-1: окно сверки договора (signal_contract_view) отдаёт детей и «есть ещё» ТОЛЬКО своего объекта; раскрыть можно потомка
//     связанного узла, у которого и у всех звеньев цепочки тот же объект;
//   • С-21: путь узла, подсказка, пути кандидатов и поиск папок — от границы объекта (signal_nodes.object_path), имена папок над
//     границей (они чужого объекта) не показываются и не ищутся; signal_node_json / signal_match_nodes отдают ещё objectPath;
//   • К-7 / В-6: разметка любой глубины — дерево корня (signal_tree), список привязок, предпросмотр с предупреждением о кодах другого
//     объекта, «Снять»; С-47: папки второго объекта в многообъектном корне размечаются отдельно и сотруднику первого не видны;
//   • С-36: узел, который договору уже не виден, не удерживает «сверено» до такта очереди — unverified:pending;
//   • С-5: перенос узла в другой объект снимает подтверждение человека и открытые кандидаты, договор — в очередь правкой.
// Нужны зависимости сервера и PostgreSQL (бинарники или Docker). Данные вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip, uuid } from './lib/signal-db.mjs'

describe('База сверки с SIGNAL: граница объекта, путь от границы, разметка любой глубины', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let seed
  const q = (text) => db.sql(text)
  const gen = () => Math.max(1, Number(q('select generation from osp_private.signal_meta')))
  const snapshot = (src, tree) => seed.snapshot(src.id, tree, { generation: gen() })
  const objOf = (n) => q(`select coalesce(object_id::text, '-') from osp_private.signal_nodes where node_id = '${n}'`)
  const pathOf = (n) => q(`select coalesce(object_path, '<NULL>') from osp_private.signal_nodes where node_id = '${n}'`)

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
  })
  after(async () => { await db?.stop() })

  it('К-1 и С-21: вложенная привязка X→А, X/Y→Б — карточка договора А не видит папку Б ни в списке, ни в «есть ещё», раскрыть её нельзя; договор Б видит свою папку без имён над границей', () => {
    const A = seed.object({ name: 'Тест: объект А', code: 'ТСА' })
    const B = seed.object({ name: 'Тест: объект Б', code: 'ТСБ' })
    const admin = seed.admin()
    const viewerA = seed.user({ contracts: 'view', objectIds: [A], objectScoped: true })
    const editorA = seed.user({ contracts: 'edit', objectIds: [A], objectScoped: true })
    const viewerB = seed.user({ contracts: 'view', objectIds: [B], objectScoped: true })
    const src = seed.source({ objectIds: [A, B] })
    const snap = snapshot(src, { name: 'R', children: [
      { name: 'Контрагент Альфа', items: [{ name: 'общий.pdf' }], children: [
        { name: 'Свой подкаталог', items: [{ name: 'а.pdf' }] },
        { name: 'ДП ТСБ-ДП-26-001 ООО Бета', items: [{ name: 'Б.pdf' }], children: [
          { name: 'Вернулись к А', items: [{ name: 'вернулись.pdf' }] }, { name: 'Бетонный подкаталог' }] }] }] })
    const X = snap.ids['R / Контрагент Альфа']
    const own = snap.ids['R / Контрагент Альфа / Свой подкаталог']
    const Y = snap.ids['R / Контрагент Альфа / ДП ТСБ-ДП-26-001 ООО Бета']
    const Z = snap.ids['R / Контрагент Альфа / ДП ТСБ-ДП-26-001 ООО Бета / Вернулись к А']
    const Y2 = snap.ids['R / Контрагент Альфа / ДП ТСБ-ДП-26-001 ООО Бета / Бетонный подкаталог']
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${X}', '${A}')`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${Y}', '${B}')`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${Z}', '${A}')`)
    assert.deepEqual([objOf(X), objOf(own), objOf(Y), objOf(Y2), objOf(Z)], [A, A, B, B, A])
    // object_path: от самого верхнего предка с тем же объектом у всех звеньев цепочки.
    assert.equal(pathOf(snap.rootId), '<NULL>', 'корень без объекта — пути нет')
    assert.equal(pathOf(X), 'Контрагент Альфа')
    assert.equal(pathOf(own), 'Контрагент Альфа / Свой подкаталог')
    assert.equal(pathOf(Y), 'ДП ТСБ-ДП-26-001 ООО Бета', 'граница Б: имя папки А над ней в путь не входит')
    assert.equal(pathOf(Y2), 'ДП ТСБ-ДП-26-001 ООО Бета / Бетонный подкаталог')
    assert.equal(pathOf(Z), 'Вернулись к А', 'А → Б → А: цепочка прервана папкой Б, путь начинается с Z')

    const cA = seed.contract({ number: 'Старый-17', objectId: A })
    const cB = seed.contract({ number: 'ТСБ-ДП-26-001', objectId: B })
    const cZ = seed.contract({ number: 'Старый-18', objectId: A })
    q(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id, checked_gen) values
      ('${cA}', 'verified', 'existing_url', '${X}', 1), ('${cB}', 'verified', 'existing_url', '${Y}', 1), ('${cZ}', 'verified', 'existing_url', '${Z}', 1)`)

    const viewA = db.asJson(viewerA, `select osp_private.signal_contract_view('${cA}', null, 200)`)
    assert.deepEqual(viewA.files.map((f) => `${f.kind}:${f.name}`).sort(), ['folder:Свой подкаталог', 'item:общий.pdf'].sort(), 'К-1: чужая папка в списке отсутствует')
    assert.ok(!viewA.files.some((f) => f.nodeId === Y), 'К-1: и её nodeId')
    assert.equal(viewA.more, false, 'К-1: чужая папка не даёт «есть ещё»')
    assert.equal(db.asJson(viewerA, `select osp_private.signal_contract_view('${cA}', null, 1)`).more, true, 'своих двое, лимит 1 — «есть ещё» по своим')
    assert.equal(viewA.node.path, 'Контрагент Альфа')
    // Раскрытие: свой потомок — да; чужая папка и её потомки — нет, в том числе потомок Z того же объекта за чужой папкой Y.
    assert.deepEqual(db.asJson(viewerA, `select osp_private.signal_contract_view('${cA}', '${own}', 200)`).files.map((f) => f.name), ['а.pdf'])
    for (const n of [Y, Y2, Z]) {
      const e = db.asError(viewerA, `select osp_private.signal_contract_view('${cA}', '${n}', 200)`)
      assert.deepEqual([e?.code, e?.message], ['SG403', 'forbidden'], n)
    }
    // Связанный узел Z (объект А) за чужой папкой Y: список и путь — только от Z.
    const viewZ = db.asJson(viewerA, `select osp_private.signal_contract_view('${cZ}', null, 200)`)
    assert.equal(viewZ.node.path, 'Вернулись к А')
    assert.deepEqual(viewZ.files.map((f) => f.name), ['вернулись.pdf'])
    // Договор Б: путь своей папки без имени папки объекта А; её дети — свои; поддерево Y2 раскрывается.
    const viewB = db.asJson(viewerB, `select osp_private.signal_contract_view('${cB}', null, 200)`)
    assert.equal(viewB.node.path, 'ДП ТСБ-ДП-26-001 ООО Бета')
    assert.ok(!JSON.stringify(viewB).includes('Контрагент Альфа'), 'С-21: имя папки объекта А нигде в ответе')
    assert.deepEqual(viewB.files.map((f) => f.name).sort(), ['Б.pdf', 'Бетонный подкаталог'].sort(), 'дети Y: свой файл и своя папка; Z (объект А) не показан')
    assert.deepEqual(db.asJson(viewerB, `select osp_private.signal_contract_view('${cB}', '${Y2}', 200)`).node.path, 'ДП ТСБ-ДП-26-001 ООО Бета / Бетонный подкаталог')

    // Значки: путь — от границы; кандидаты (при праве правки) — тоже.
    const m = db.asJson(viewerB, 'select osp_private.signal_marks(null, 100)').items.find((i) => i.id === cB)
    assert.equal(m.path, 'ДП ТСБ-ДП-26-001 ООО Бета')
    q(`insert into osp_private.signal_candidates (contract_id, node_id, status, score) values ('${cA}', '${own}', 'open', 50)`)
    const mA = db.asJson(editorA, 'select osp_private.signal_marks(null, 100)').items.find((i) => i.id === cA)
    assert.deepEqual([mA.path, mA.candidatePath, mA.candidates], ['Контрагент Альфа', 'Контрагент Альфа / Свой подкаталог', 1])
    assert.ok(!JSON.stringify(db.asJson(viewerB, 'select osp_private.signal_marks(null, 100)')).includes('Контрагент Альфа'))
    const cand = db.asJson(editorA, `select osp_private.signal_contract_view('${cA}')`).candidates
    assert.deepEqual(cand.map((c) => c.path), ['Контрагент Альфа / Свой подкаталог'])

    // Поиск папок: путь от границы; запрос по имени папки над границей объекта Б её не находит.
    const editorB = seed.user({ contracts: 'edit', objectIds: [B], objectScoped: true })
    const all = db.asJson(editorB, `select osp_private.signal_folders_search('${cB}', '', null, 50)`).items.map((i) => i.path)
    assert.deepEqual(all.sort(), ['ДП ТСБ-ДП-26-001 ООО Бета', 'ДП ТСБ-ДП-26-001 ООО Бета / Бетонный подкаталог'].sort())
    assert.deepEqual(db.asJson(editorB, `select osp_private.signal_folders_search('${cB}', 'контрагент альфа', null, 50)`).items, [], 'имя над границей не ищется')
    assert.deepEqual(db.asJson(editorB, `select osp_private.signal_folders_search('${cB}', 'бетонный', null, 50)`).items.map((i) => i.path), ['ДП ТСБ-ДП-26-001 ООО Бета / Бетонный подкаталог'])
    const pageA = db.asJson(editorA, `select osp_private.signal_folders_search('${cA}', '', null, 2)`)
    assert.equal(pageA.items.length, 2)
    assert.ok(pageA.next)
    const pageA2 = db.asJson(editorA, `select osp_private.signal_folders_search('${cA}', '', ${`'${pageA.next.replace(/'/g, "''")}'`}, 10)`)
    assert.equal(pageA.items.length + pageA2.items.length, 3, 'Контрагент Альфа, Свой подкаталог, Вернулись к А — страницы по пути от границы')

    // Служебный вход сопоставителя видит и полный путь, и путь от границы (имя папки ему положено).
    const nodes = db.sqlJson(`select osp_private.signal_match_nodes(array['${Y}']::uuid[], null, null, null, null)`).nodes
    assert.deepEqual([nodes[0].path, nodes[0].objectPath], ['R / Контрагент Альфа / ДП ТСБ-ДП-26-001 ООО Бета', 'ДП ТСБ-ДП-26-001 ООО Бета'])
    assert.equal(db.sqlJson(`select osp_private.signal_node_json('${Z}')`).objectPath, 'Вернулись к А')

    // Переименование предка меняет путь без смены объекта: публикация пересчитывает object_path.
    const renamed = { name: 'R', children: [{ id: X, name: 'Контрагент Альфа 2', items: [{ name: 'общий.pdf' }], children: [
      { id: own, name: 'Свой подкаталог', items: [{ name: 'а.pdf' }] },
      { id: Y, name: 'ДП ТСБ-ДП-26-001 ООО Бета', items: [{ name: 'Б.pdf' }], children: [{ id: Z, name: 'Вернулись к А', items: [{ name: 'вернулись.pdf' }] }, { id: Y2, name: 'Бетонный подкаталог' }] }] }] }
    assert.equal(seed.sync({ kind: 'manual', roots: [{ src, tree: renamed }] }).result.status, 'ok')
    assert.equal(pathOf(own), 'Контрагент Альфа 2 / Свой подкаталог')
    assert.equal(pathOf(Y), 'ДП ТСБ-ДП-26-001 ООО Бета', 'путь Б от переименования папки А не зависит')
  })

  it('К-7 / В-6: дерево корня, список привязок, предпросмотр с предупреждением о кодах другого объекта; разметка любой глубины и «Снять»; С-47 — папки второго объекта размечаются отдельно', () => {
    const K14 = seed.object({ name: 'Тест: корпус 14', code: 'К14Т' })
    const K22 = seed.object({ name: 'Тест: корпус 22', code: 'К22Т' })
    const admin = seed.admin()
    const editor14 = seed.user({ contracts: 'edit', objectIds: [K14], objectScoped: true })
    const editor = seed.user({ contracts: 'edit' })
    const src = seed.source({ objectIds: [K14, K22] })
    const snap = snapshot(src, { name: 'Договора подряда', children: [
      { name: 'Дельта', children: [
        { name: 'корп.14 ДП К14Т-ДП-26-001', numberKeys: ['К14Т|2026|1'], items: [{ name: 'к14.pdf' }] },
        { name: 'корп.22 ДП К22Т-ДП-26-001 ООО Чужой', numberKeys: ['К22Т|2026|1'], children: [{ name: 'Приложения', numberKeys: ['К22Т|2026|1'] }] },
        { name: 'Общая папка' }] },
      { name: 'Омега', children: [{ name: 'Глубокая', children: [{ name: 'Ещё глубже', children: [{ name: 'Дно К22Т-ДП-26-005', numberKeys: ['К22Т|2026|5'] }] }] }] }] })
    const ids = snap.ids
    const delta = ids['Договора подряда / Дельта']
    const k14 = ids['Договора подряда / Дельта / корп.14 ДП К14Т-ДП-26-001']
    const k22 = ids['Договора подряда / Дельта / корп.22 ДП К22Т-ДП-26-001 ООО Чужой']
    const bottom = ids['Договора подряда / Омега / Глубокая / Ещё глубже / Дно К22Т-ДП-26-005']
    const tree = (args = '') => db.asJson(admin, `select osp_private.signal_tree(${src.id}${args})`)

    // Дерево: дети корня; потом дети папки; поиск по всему корню; страницы.
    const top = tree()
    assert.deepEqual(top.items.map((i) => [i.name, i.hasChildren, i.bound, i.objectId, i.depth]), [['Дельта', true, false, null, 1], ['Омега', true, false, null, 1]])
    assert.equal(top.items[0].path, 'Договора подряда / Дельта', 'администратор видит полные пути')
    assert.equal(top.next, null)
    const kids = tree(`, '${delta}'`)
    assert.deepEqual(kids.items.map((i) => `${i.name}|${i.hasChildren}|${i.items}`).sort(), ['Общая папка|false|0', 'корп.14 ДП К14Т-ДП-26-001|false|1', 'корп.22 ДП К22Т-ДП-26-001 ООО Чужой|true|0'].sort())
    const p1 = tree(`, '${delta}', null, null, 2`)
    assert.equal(p1.items.length, 2)
    assert.ok(p1.next)
    const p2 = tree(`, '${delta}', null, '${p1.next.replace(/'/g, "''")}', 2`)
    assert.equal(p2.items.length, 1)
    assert.equal(p2.next, null)
    assert.deepEqual([...p1.items, ...p2.items].map((i) => i.nodeId).sort(), kids.items.map((i) => i.nodeId).sort(), 'страницы не пересекаются и ничего не теряют')
    const found = tree(`, null, 'дно к22т'`)
    assert.deepEqual(found.items.map((i) => i.nodeId), [bottom], 'поиск по всему корню, любая глубина')
    assert.deepEqual(tree(`, null, 'глубокая / ещё'`).items.map((i) => i.name).sort(), ['Дно К22Т-ДП-26-005', 'Ещё глубже'], 'поиск по пути: папка и всё под ней')
    assert.equal(db.asError(admin, `select osp_private.signal_tree(${src.id}, '${uuid('z', 1)}')`).message, 'not_found')
    assert.equal(db.asError(admin, `select osp_private.signal_tree(${src.id + 100})`).message, 'not_found')
    assert.equal(db.asError(admin, `select osp_private.signal_tree(${src.id}, null, '${'я'.repeat(101)}')`).message, 'invalid')
    for (const call of [`signal_tree(${src.id})`, `signal_bindings_list(${src.id})`, `signal_binding_preview(${src.id}, '${delta}', '${K14}')`]) {
      assert.equal(db.asError(editor, `select osp_private.${call}`).code, 'SG403', `сотрудник: ${call}`)
      assert.equal(db.asError(editor14, `select osp_private.${call}`).code, 'SG403')
    }

    // Предпросмотр: Дельта → К14, внутри — номер корпуса 22 (К22Т): предупреждение; части под другой привязкой не считаются.
    let pv = db.asJson(admin, `select osp_private.signal_binding_preview(${src.id}, '${delta}', '${K14}')`)
    assert.deepEqual(pv.warnings, [{ objectId: K22, objectName: 'Тест: корпус 22', folders: 2 }], 'папка корпуса 22 и её «Приложения»')
    assert.deepEqual(pv.affected, { folders: 5, items: 1 }, 'Дельта, корпус 14, корпус 22, «Приложения», «Общая папка»; один файл')
    // Омега → К22: свой код — предупреждений нет.
    pv = db.asJson(admin, `select osp_private.signal_binding_preview(${src.id}, '${ids['Договора подряда / Омега']}', '${K22}')`)
    assert.deepEqual(pv.warnings, [])
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_binding_preview(${src.id}, '${ids['Договора подряда / Омега']}', '${K14}')`).warnings.map((w) => w.objectName), ['Тест: корпус 22'], 'Омега → К14: внутри номер К22Т')
    assert.equal(db.asError(admin, `select osp_private.signal_binding_preview(${src.id}, '${delta}', '${seed.object()}')`).message, 'invalid', 'объект вне корня')
    assert.equal(db.asError(admin, `select osp_private.signal_binding_preview(${src.id}, '${uuid('z', 2)}', '${K14}')`).message, 'invalid', 'узла нет')

    // С-47 до разметки глубже: Дельта → К14 открывает сотруднику корпуса 14 папку корпуса 22.
    const c14 = seed.contract({ number: 'К14Т-ДП-26-001', objectId: K14 })
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${delta}', '${K14}')`)
    assert.ok(db.asJson(editor14, `select osp_private.signal_folders_search('${c14}', 'чужой', null, 50)`).items.length > 0, 'до разметки: папка К22 видна К14 (предупреждение предпросмотра не зря)')
    // Теперь любой глубины: папка корпуса 22 → К22 (глубина 2), «Дно» (глубина 4) → К22.
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${k22}', '${K22}')`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${bottom}', '${K22}')`)
    assert.deepEqual([objOf(k14), objOf(k22), objOf(ids['Договора подряда / Дельта / корп.22 ДП К22Т-ДП-26-001 ООО Чужой / Приложения']), objOf(bottom)], [K14, K22, K22, K22])
    assert.deepEqual(db.asJson(editor14, `select osp_private.signal_folders_search('${c14}', 'чужой', null, 50)`).items, [], 'К14 папку К22 больше не находит')
    // Предпросмотр на Дельта → К14 теперь не считает часть под привязкой k22.
    pv = db.asJson(admin, `select osp_private.signal_binding_preview(${src.id}, '${delta}', '${K14}')`)
    assert.deepEqual(pv.warnings, [], 'часть под другой привязкой не в счёт')
    assert.deepEqual(pv.affected, { folders: 3, items: 1 }, 'Дельта, корпус 14, «Общая папка»')

    // Список привязок: по пути, с объектами и признаком «видели».
    const list = db.asJson(admin, `select osp_private.signal_bindings_list(${src.id})`)
    assert.deepEqual(list.rootObjects.map((o) => o.objectName).sort(), ['Тест: корпус 14', 'Тест: корпус 22'])
    assert.deepEqual(list.items.map((i) => [i.path, i.objectName, i.observed]), [
      ['Договора подряда / Дельта', 'Тест: корпус 14', true],
      ['Договора подряда / Дельта / корп.22 ДП К22Т-ДП-26-001 ООО Чужой', 'Тест: корпус 22', true],
      ['Договора подряда / Омега / Глубокая / Ещё глубже / Дно К22Т-ДП-26-005', 'Тест: корпус 22', true]])
    assert.equal(tree(`, '${delta}'`).items.find((i) => i.nodeId === k22).bound, true)
    assert.equal(tree(`, '${delta}'`).items.find((i) => i.nodeId === k22).boundObjectId, K22)
    assert.equal(tree(`, '${delta}'`).items.find((i) => i.nodeId === k14).bound, false)
    assert.equal(tree(`, '${delta}'`).items.find((i) => i.nodeId === k14).objectName, 'Тест: корпус 14')

    // «Снять»: папка верхнего уровня снова «без объекта»; поддерево возвращается к ближайшей привязке выше или к «без объекта».
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${delta}', null)`), { ok: true })
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_unassigned(${src.id}, null, 50)`).items.map((i) => i.path), ['Договора подряда / Дельта', 'Договора подряда / Омега'],
      'после «Снять» папка Дельта снова в «без объекта» (Омега с самого начала)')
    assert.equal(objOf(delta), '-')
    assert.equal(objOf(k22), K22, 'своя привязка внутри осталась')
    assert.equal(objOf(k14), '-', 'корпус 14 потерял границу вместе с Дельтой')
    assert.equal(pathOf(k22), 'корп.22 ДП К22Т-ДП-26-001 ООО Чужой', 'путь от своей границы')
    // Снять несуществующую привязку — не ошибка и ничего не меняет.
    q('delete from osp_private.signal_queue')
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${delta}', null)`), { ok: true })
    assert.equal(q('select count(*) from osp_private.signal_queue'), '0', 'нечего снимать — очередь не трогается')
    // Привязка к пропавшей папке — нельзя; папка вне корня и файл — нельзя; снять привязку пропавшей папки — можно.
    assert.equal(db.asError(admin, `select osp_private.signal_binding_set(${src.id}, '${ids['Договора подряда / Дельта / корп.14 ДП К14Т-ДП-26-001 / к14.pdf']}', '${K14}')`).message, 'invalid', 'файл')
    q(`update osp_private.signal_nodes set seen_gen = 0 where node_id = '${k14}'`)
    assert.equal(db.asError(admin, `select osp_private.signal_binding_set(${src.id}, '${k14}', '${K14}')`).message, 'invalid', 'папку не видели в последнем обходе')
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${k14}', null)`), { ok: true })
  })

  it('С-36: узел перенесён в корень другого объекта или корень выключен — значок и окно не держат «сверено», отдают unverified:pending; «ссылка принята» (accepted) и жёлтые состояния — так же', () => {
    const A = seed.object({ name: 'Тест: объект Р1', code: 'РА' })
    const B = seed.object({ name: 'Тест: объект Р2', code: 'РБ' })
    const admin = seed.admin()
    const ed = seed.user({ contracts: 'edit', objectIds: [A, B], objectScoped: true })
    const src = seed.source({ objectIds: [A, B] })
    const snap = snapshot(src, { name: 'RX', children: [{ name: 'Раздел А', children: [{ name: 'ДП РА-ДП-26-001' }] }, { name: 'Раздел Б' }] })
    const secA = snap.ids['RX / Раздел А']
    const secB = snap.ids['RX / Раздел Б']
    const folder = snap.ids['RX / Раздел А / ДП РА-ДП-26-001']
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${secA}', '${A}')`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${secB}', '${B}')`)
    const states = [['verified', 'existing_url'], ['accepted', 'number_not_found'], ['attention', 'not_visible'], ['missing', 'deleted'], ['conflict', 'number_mismatch'],
      ['unverified', 'not_observed'], ['suggested', null], ['none', 'none']]
    const cs = states.map(([st, rs], i) => {
      const c = seed.contract({ number: `РА-ДП-26-00${i + 1}`, objectId: A })
      q(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id, checked_gen) values ('${c}', '${st}', ${rs ? `'${rs}'` : 'null'}, '${folder}', 1)`)
      return c
    })
    q('delete from osp_private.signal_queue')
    const mark = (c) => db.asJson(ed, 'select osp_private.signal_marks(null, 1000)').items.find((i) => i.id === c)
    const view = (c) => db.asJson(ed, `select osp_private.signal_contract_view('${c}')`)
    for (const [i, c] of cs.entries()) {
      assert.deepEqual([mark(c).state, mark(c).reason, mark(c).pending], [states[i][0], states[i][1], false], `${states[i][0]}: до переноса — как есть`)
    }
    assert.equal(mark(cs[0]).path, 'Раздел А / ДП РА-ДП-26-001', 'путь от границы объекта А (корень RX — граница без объекта)')
    // Публикация переносит папку в корень объекта Б (другая папка-родитель): договор А узел больше не видит.
    q(`update osp_private.signal_nodes set parent_id = '${secB}', path_ids = array[(select folder_id from osp_private.signal_sources where id = ${src.id}), '${secB}']::uuid[], object_id = '${B}' where node_id = '${folder}'`)
    for (const [i, c] of cs.entries()) {
      const gone = ['verified', 'accepted', 'attention', 'missing', 'conflict'].includes(states[i][0])
      const m = mark(c)
      const v = view(c)
      if (gone) assert.deepEqual([m.state, m.reason, m.pending, m.path, v.state, v.reason, v.pending, v.node], ['unverified', 'pending', true, undefined, 'unverified', 'pending', true, null], states[i].join(':'))
      else assert.deepEqual([m.state, m.reason, m.pending, v.state, v.reason], [states[i][0], states[i][1], false, states[i][0], states[i][1]], `${states[i][0]} не затронуто`)
    }
    // Корень выключен — то же самое для узла, который остался в границе.
    q(`update osp_private.signal_nodes set parent_id = '${secA}', path_ids = array[(select folder_id from osp_private.signal_sources where id = ${src.id}), '${secA}']::uuid[], object_id = '${A}' where node_id = '${folder}'`)
    assert.equal(mark(cs[0]).state, 'verified')
    db.asJson(admin, `select osp_private.signal_source_update(${src.id}, false, null)`)
    q('delete from osp_private.signal_queue')
    assert.deepEqual([mark(cs[0]).state, mark(cs[0]).reason, mark(cs[0]).pending], ['unverified', 'pending', true])
    assert.deepEqual([view(cs[1]).state, view(cs[1]).reason, view(cs[1]).pending], ['unverified', 'pending', true])
  })

  it('С-5: перенос узла через границу объекта (А → Б) снимает «подтверждено человеком», удаляет открытые кандидаты на узел, ставит договор в очередь правкой; без объекта и первичное назначение — не перенос', () => {
    const A = seed.object({ name: 'Тест: объект П1', code: 'ПА' })
    const B = seed.object({ name: 'Тест: объект П2', code: 'ПБ' })
    const admin = seed.admin()
    const src = seed.source({ objectIds: [A, B] })
    const snap = snapshot(src, { name: 'RP', children: [{ name: 'Верх', children: [{ name: 'Папка договора' }, { name: 'Соседняя' }] }] })
    const top = snap.ids['RP / Верх']
    const f = snap.ids['RP / Верх / Папка договора']
    const side = snap.ids['RP / Верх / Соседняя']
    const dp = seed.contract({ number: 'ПА-ДП-26-001', objectId: A })
    const other = seed.contract({ number: 'ПА-ДП-26-002', objectId: A })
    // Первичное назначение (NULL → А) — не перенос: подтверждения не трогаются.
    const confirmedAt = () => q(`select coalesce(confirmed_by::text, '-') from osp_private.signal_contracts where contract_id = '${dp}'`)
    q(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id, confirmed_by, confirmed_at) values
      ('${dp}', 'verified', 'confirmed', '${f}', '${admin}', now()), ('${other}', 'suggested', null, null, null, null)`)
    q(`insert into osp_private.signal_candidates (contract_id, node_id, status, score) values ('${other}', '${f}', 'open', 40), ('${other}', '${side}', 'open', 30)`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${top}', '${A}')`)
    assert.equal(confirmedAt(), admin, 'NULL → А: не перенос')
    assert.equal(q(`select count(*) from osp_private.signal_candidates where contract_id = '${other}' and status = 'open'`), '2')
    q('delete from osp_private.signal_queue')
    // Перепривязка поддерева А → Б: перенос.
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${top}', '${B}')`)
    assert.equal(confirmedAt(), '-', 'подтверждение человека снято')
    assert.equal(q(`select (confirmed_at is null)::text from osp_private.signal_contracts where contract_id = '${dp}'`), 'true')
    assert.equal(q(`select count(*) from osp_private.signal_candidates where contract_id = '${other}' and node_id in ('${f}', '${side}') and status = 'open'`), '0', 'открытые кандидаты на перенесённые узлы удалены')
    assert.equal(q(`select recheck_only::text from osp_private.signal_queue where contract_id = '${dp}'`), 'false', 'договор с этим узлом — в очередь правкой, а не плановой пересверкой')
    // Снятие привязки (Б → NULL) и состояние «без объекта» переносом не считаются.
    q(`update osp_private.signal_contracts set confirmed_by = '${admin}', confirmed_at = now() where contract_id = '${dp}'`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${top}', null)`)
    assert.equal(confirmedAt(), admin, 'Б → NULL: не перенос')
  })
})
