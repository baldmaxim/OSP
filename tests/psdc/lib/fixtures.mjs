// Построители тестовых данных: пользователи, документы, строки ведомости.
import { randomUUID } from 'node:crypto'
import { sqlJson } from './pg.mjs'

export const HEADER = [
  '№ п/п', 'Тип ресурса', 'Шифр', 'Давальческий материал', 'Статья затрат', 'Наименование работы',
  'Ед. изм.', 'Норма расхода', 'Объём', 'Цена за материал', 'Стоимость за материал', 'Цена за работу',
  'Стоимость за работу', 'Единичная расценка', 'Общая стоимость', 'Завод-изготовитель',
  'Применяемые материалы', 'Место проведения работ', 'Комментарий', 'ID строки в системе',
]

const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

export function createUser(db, { role = 'lawyer', canView = true, canEdit = true, objectIds = [], approved = true, name } = {}) {
  const uid = randomUUID()
  db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${uid}', '${uid}@test.local');
    INSERT INTO user_roles (user_id, role, is_approved, full_name, object_ids)
      VALUES ('${uid}', '${role}', ${approved}, ${lit(name || `Пользователь ${role}`)}, '{${objectIds.join(',')}}');
  `)
  if (role !== 'admin') {
    db.exec(`
      INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES ('${role}', 'contracts', ${canView}, ${canEdit})
      ON CONFLICT (role, section) DO UPDATE SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;
    `)
  }
  return uid
}

export function createObject(db, name = 'Объект') {
  return db.exec(`INSERT INTO objects (name) VALUES (${lit(name)}) RETURNING id;`).trim()
}

// Документ первого этапа. Возвращает { id, display_id }.
export function createDocument(db, fields = {}) {
  const cols = Object.keys(fields)
  const vals = cols.map((c) => {
    const v = fields[c]
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (Array.isArray(v)) return `ARRAY[${v.map(lit).join(',')}]::text[]`
    return lit(v)
  })
  const sql = cols.length
    ? `INSERT INTO contracts (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING json_build_object('id', id, 'display_id', display_id);`
    : `INSERT INTO contracts DEFAULT VALUES RETURNING json_build_object('id', id, 'display_id', display_id);`
  return JSON.parse(db.exec(sql).trim())
}

// Ячейка в формате, который присылает браузер.
export function cell(value, extra = {}) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') return { t: 'n', v: String(value), ...extra }
  return { t: 's', v: String(value), ...extra }
}

const COLS = 'ABCDEFGHIJKLMNOPQRSTU'.split('')

// Строка ведомости: { A: '1', B: 'Секция', ... } → { r, c }.
export function row(r, values) {
  const c = {}
  for (const col of COLS) {
    const v = values[col]
    if (v === undefined) continue
    c[col] = (v && typeof v === 'object' && 't' in v) ? v : cell(v)
    if (c[col] === undefined) delete c[col]
  }
  return { r, c }
}

export function section(r, number, name, extra = {}) {
  return row(r, { A: number, B: 'Секция', F: name, ...extra })
}

export function process(r, number, name, { volume, materialPrice, workPrice, dm = false, unit = 'м2', ...extra } = {}) {
  return row(r, {
    A: number, B: 'Комплексный процесс', F: name, G: unit,
    I: volume, J: materialPrice, L: workPrice, D: dm ? 'ДМ' : undefined, ...extra,
  })
}

// Загрузка + проверка от имени пользователя. Возвращает JSON проверки.
export function stage(db, uid, { documentId = null, batchId = null, rows, header = HEADER, hasU = false, totals = {}, fatal = [], fileName = 'ВОР.xlsx' }) {
  const meta = { source_filename: fileName, source_hash: randomUUID(), source_size: 1000, sheet_name: 'Ведомость объёмов работ', has_u: hasU, header, totals, fatal }
  const id = db.asUser(uid, `SELECT psdc_create(${documentId ? `'${documentId}'` : 'NULL'}, ${batchId ? `'${batchId}'` : 'NULL'}, ${sqlJson(meta)});`)
  for (let i = 0; i < rows.length; i += 2000) {
    db.asUser(uid, `SELECT psdc_add_rows('${id}', ${sqlJson(rows.slice(i, i + 2000))});`)
  }
  const result = JSON.parse(db.asUser(uid, `SELECT psdc_validate('${id}');`))
  return { id, result }
}

function parseOut(out) {
  if (!out) return null
  try { return JSON.parse(out) } catch { return out }
}

export function rpc(db, uid, fn, ...args) {
  return parseOut(db.asUser(uid, `SELECT ${fn}(${args.join(', ')});`))
}

export function tryRpc(db, uid, fn, ...args) {
  const res = db.tryAsUser(uid, `SELECT ${fn}(${args.join(', ')});`)
  return res.ok ? { ok: true, value: parseOut(res.out) } : { ok: false, error: res.error }
}

export const q = (id) => `'${id}'`
