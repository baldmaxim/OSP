// Тесты-сторожа очереди пересчёта сверки с SIGNAL (пакет ПР-9, контроль мутантов SM10f–h): каждая значимая правка договора,
// его контрагентов и объекта ставит в очередь именно те договоры, которых она касается; незначимая правка очередь не трогает.
// Триггеры никогда не отказывают бизнес-записи (инвариант 4) — каждая правка ниже проходит, а очередь проверяется отдельно.
//
//   договор: номер, дата, объект, контрагент, тип записи, родитель, ссылка, мягкое удаление → договор и его ДС (по родителю и корню цепочки)
//   не значимо: примечание, статус → очередь пуста
//   контрагенты договора: добавление, замена, удаление → этот договор
//   объект: название, код для договоров → все договоры объекта и только они
//   новый договор → в очереди; жёсткое удаление договора → его ДС
// Данные — синтетика. Нужны PostgreSQL и зависимости сервера.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)

describe('Сторожа очереди пересчёта SIGNAL: триггеры на contracts, contract_counterparties, objects', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let A
  let B
  let cp1
  let cp2
  let cp3
  let other // договор чужой цепочки и чужого объекта: ни одна правка ниже его в очередь не ставит
  let seq = 0

  const queued = () => new Set(db.sql('select contract_id from osp_private.signal_queue order by contract_id').split('\n').filter(Boolean))
  const clear = () => db.sql('TRUNCATE osp_private.signal_queue')
  // Перечисленные договоры в очереди, договор чужой цепочки и чужого объекта — нет; exact — очередь ровно из перечисленных
  // (незначимая правка очередь не трогает: «перегрузка» очереди — тоже дефект, С-38).
  const expectQueue = (must, label, { exact = false } = {}) => {
    const got = queued()
    for (const id of must) assert.ok(got.has(id), `${label}: договор ${id} должен быть в очереди`)
    assert.ok(!got.has(other), `${label}: договор чужой цепочки и чужого объекта в очередь не ставится`)
    if (exact) assert.deepEqual([...got].filter((id) => !must.includes(id)), [], `${label}: в очереди лишние договоры`)
  }
  // Новая цепочка: договор объекта А и его ДС; очередь после создания очищена.
  const chain = () => {
    const n = ++seq
    const dp = db.seed.contract({ number: `ТРА-ДП-26-${100 + n}`, objectId: A, counterparties: [cp1] })
    const ds = db.seed.contract({ number: `ДС-${n}`, objectId: A, counterparties: [cp1], recordType: 'ds_vor', parent: dp })
    clear()
    return { dp, ds }
  }
  const update = (id, set) => db.sql(`update public.contracts set ${set} where id = ${lit(id)}`)

  before(async () => {
    db = await startSignalDb()
    const { seed } = db
    A = seed.object({ name: 'Тест: объект А', code: 'ТРА' })
    B = seed.object({ name: 'Тест: объект Б', code: 'ТРБ' })
    cp1 = seed.counterparty({ name: 'ООО Тест Один' })
    cp2 = seed.counterparty({ name: 'ООО Тест Два' })
    cp3 = seed.counterparty({ name: 'ООО Тест Три' })
    other = seed.contract({ number: 'ТРБ-ДП-26-002', objectId: B, counterparties: [cp2] })
  })
  after(async () => { await db?.stop() })
  beforeEach(() => clear())

  it('правка значимой колонки ставит в очередь договор и его ДС (по родителю и по корню цепочки), договор другой цепочки — нет', () => {
    const cases = [
      ['contract_number', `contract_number = 'ТРА-ДП-26-911'`],
      ['contract_date', `contract_date = '2026-05-05'`],
      ['object_id', `object_id = ${lit(B)}`],
      ['counterparty_id', `counterparty_id = ${lit(cp2)}`],
      ['signal_link', `signal_link = 'https://signal.example.test/projects/p/folders/f'`],
      ['deleted_at', 'deleted_at = now()'],
    ]
    for (const [label, set] of cases) {
      const c = chain()
      update(c.dp, set)
      expectQueue([c.dp, c.ds], `contracts.${label}`)
    }
  })

  it('смена родителя и типа записи ставит ДС в очередь (тип в боевой схеме меняет охранник иерархии — сторож на самом условии триггера)', () => {
    const c = chain()
    const c2 = chain()
    update(c.ds, `parent_contract_id = ${lit(c2.dp)}`)
    expectQueue([c.ds], 'перенос ДС к другому договору')
    clear()
    update(c2.ds, `record_type = 'ds_extra'`)
    expectQueue([c2.ds], 'смена типа записи')
  })

  it('незначимая правка (примечание, статус) очередь не трогает', () => {
    const c = chain()
    update(c.dp, `notes = 'примечание'`)
    update(c.dp, `status = 'new_request'`)
    update(c.ds, `notes = 'ещё примечание'`)
    expectQueue([], 'примечание и статус', { exact: true })
  })

  it('контрагенты договора: добавление, замена и удаление ставят в очередь только этот договор', () => {
    const c = chain()
    db.sql(`insert into public.contract_counterparties (contract_id, counterparty_id, sort_order) values (${lit(c.dp)}, ${lit(cp2)}, 5)`)
    expectQueue([c.dp], 'добавление контрагента')
    clear()
    db.sql(`update public.contract_counterparties set counterparty_id = ${lit(cp3)} where contract_id = ${lit(c.dp)} and counterparty_id = ${lit(cp2)}`)
    expectQueue([c.dp], 'замена контрагента')
    clear()
    db.sql(`delete from public.contract_counterparties where contract_id = ${lit(c.dp)} and counterparty_id = ${lit(cp3)}`)
    expectQueue([c.dp], 'удаление контрагента')
  })

  it('объект: название и код для договоров ставят в очередь все договоры объекта и только их; адрес — никого', () => {
    chain()
    const ofA = db.sql(`select id from public.contracts where object_id = ${lit(A)}`).split('\n').filter(Boolean)
    assert.ok(ofA.length >= 2 && !ofA.includes(other))
    db.sql(`update public.objects set name = 'Тест: объект А (новое имя)' where id = ${lit(A)}`)
    expectQueue(ofA, 'название объекта')
    clear()
    db.sql(`update public.objects set contract_code = 'ТРВ' where id = ${lit(A)}`)
    expectQueue(ofA, 'код объекта')
    clear()
    db.sql(`update public.objects set address = 'Тест: другой адрес' where id = ${lit(A)}`)
    expectQueue([], 'адрес объекта', { exact: true })
  })

  it('новый договор — в очереди; жёсткое удаление договора — в очереди его ДС', () => {
    const fresh = db.seed.contract({ number: 'ТРА-ДП-26-801', objectId: A, counterparties: [cp1] })
    assert.ok(queued().has(fresh), 'новый договор в очереди')
    const c = chain()
    db.sql(`delete from public.contracts where id = ${lit(c.dp)}`)
    expectQueue([c.ds], 'после удаления договора его ДС в очереди')
  })
})
