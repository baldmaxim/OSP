// Права разделов в шлюзе данных: карта src/data/db-sections.json → решение по запросу.
//
// Шлюз (src/routes/dbGateway.js) сначала проверяет список allow.json (таблица и действие вообще открыты вошедшим),
// затем — эту карту: какое право раздела нужно на действие с таблицей или вызов функции. Строки дальше режет база.
//
// Правило действия (RULE):
//   "employee" — любой одобренный сотрудник; "admin" — только администратор; "none" — никому через шлюз;
//   [вариант, …] — достаточно одного:
//     { any: [[раздел, "view"|"edit"], …] }                — полный доступ;
//     { any: […], columns: [колонки] }                      — только эти колонки: для чтения — что запросить,
//                                                             отфильтровать и отсортировать; для записи — ключи тела;
//     { role: [ключи ролей], columns?: […] }                — по роли (интерфейс гейтит по роли, а не по разделу).
// Администратор проходит любое правило, кроме "none". Нет записи в карте — только администратор.
// Чтение помечено "read": "sensitive" (проверяется всегда) или "reference" (справочник: режим OSP_DB_SECTIONS_READ_REFERENCE).
import fs from 'node:fs'

export const SECTION_KEYS = new Set([
  'objects', 'contacts', 'counterparties', 'general_documents', 'tasks', 'tenders', 'vors', 'tenders_materials',
  'cost_plan_docs', 'contracts', 'dc_requests', 'dp_requests', 'dp_requests_create', 'doc_check_requests',
  'doc_check_requests_create', 'analysis_kp', 'rates_registry', 'reports', 'reports_full', 'admin',
])
const ACTIONS = ['select', 'insert', 'update', 'delete']
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// ── Карта ────────────────────────────────────────────────────────────────────
function checkRule(rule, where) {
  if (rule === 'employee' || rule === 'admin' || rule === 'none') return
  if (!Array.isArray(rule) || rule.length === 0) throw new Error(`${where}: правило — "employee" | "admin" | "none" | [варианты]`)
  for (const v of rule) {
    if (!v || typeof v !== 'object') throw new Error(`${where}: вариант — объект`)
    if (v.any) {
      if (!Array.isArray(v.any) || v.any.length === 0) throw new Error(`${where}: any — непустой список`)
      for (const pair of v.any) {
        if (!Array.isArray(pair) || pair.length !== 2 || !SECTION_KEYS.has(pair[0]) || !['view', 'edit'].includes(pair[1])) {
          throw new Error(`${where}: неизвестный раздел или право ${JSON.stringify(pair)}`)
        }
      }
    } else if (v.role) {
      if (!Array.isArray(v.role) || v.role.length === 0 || !v.role.every((r) => IDENT.test(r))) throw new Error(`${where}: role — список ключей ролей`)
    } else {
      throw new Error(`${where}: вариант без any и role`)
    }
    if (v.columns !== undefined && (!Array.isArray(v.columns) || v.columns.length === 0 || !v.columns.every((c) => IDENT.test(c)))) {
      throw new Error(`${where}: columns — непустой список имён колонок`)
    }
  }
}

export function validateSectionMap(map) {
  if (!map || typeof map !== 'object' || !map.tables || !map.rpc) throw new Error('db-sections: нужны tables и rpc')
  for (const [name, t] of Object.entries(map.tables)) {
    if (!['sensitive', 'reference'].includes(t.read)) throw new Error(`db-sections: ${name}.read — sensitive | reference`)
    for (const a of ACTIONS) if (t[a] !== undefined) checkRule(t[a], `db-sections: ${name}.${a}`)
  }
  for (const [name, f] of Object.entries(map.rpc)) {
    if (!['read', 'write'].includes(f.kind)) throw new Error(`db-sections: rpc ${name}.kind — read | write`)
    if (!['sensitive', 'reference'].includes(f.read)) throw new Error(`db-sections: rpc ${name}.read — sensitive | reference`)
    checkRule(f.call, `db-sections: rpc ${name}.call`)
    if (Array.isArray(f.call) && f.call.some((v) => v.columns)) throw new Error(`db-sections: rpc ${name} — колонки у функции не бывают`)
  }
  return map
}

export function loadSectionMap(url = new URL('../data/db-sections.json', import.meta.url)) {
  return validateSectionMap(JSON.parse(fs.readFileSync(url, 'utf8')))
}

// ── Разбор select ────────────────────────────────────────────────────────────
// Дерево: { star, cols: [{ name, complex }], embeds: [{ key, rel, node }] }. key — как связь названа в запросе (псевдоним
// или имя), rel — таблица. complex — приведение типа, json-путь, агрегат: колонка не простая.
export function parseSelect(select) {
  const text = String(select ?? '*').replace(/\s+/g, '') || '*'
  let i = 0
  const node = () => {
    const out = { star: false, cols: [], embeds: [] }
    for (;;) {
      let item = ''
      while (i < text.length && text[i] !== ',' && text[i] !== '(' && text[i] !== ')') item += text[i++]
      if (text[i] === '(') {
        i += 1
        const child = node()
        if (text[i] !== ')') throw new Error('select: не закрыта скобка')
        i += 1
        let name = item.startsWith('...') ? item.slice(3) : item
        if (name.includes('::')) throw new Error('select: приведение типа перед скобкой')
        const colon = name.indexOf(':')
        const alias = colon === -1 ? null : name.slice(0, colon)
        name = (colon === -1 ? name : name.slice(colon + 1)).split('!')[0]
        if (!IDENT.test(name) || (alias !== null && !IDENT.test(alias))) throw new Error('select: непонятное имя связи')
        // Шлюз принимает за связь всё, что стоит перед скобкой (агрегат count() — тоже: такой таблицы нет — отказ).
        out.embeds.push({ key: alias || name, rel: name, node: child })
      } else if (item) {
        if (item === '*') out.star = true
        else {
          // alias:col::cast, col->a->>b, col.sum()
          let body = item
          const colon = body.indexOf(':')
          if (colon !== -1 && body[colon + 1] !== ':') body = body.slice(colon + 1)
          const plain = IDENT.test(body)
          const name = (body.match(/^[A-Za-z_][A-Za-z0-9_]*/) || [''])[0]
          out.cols.push({ name, complex: !plain })
        }
      }
      if (text[i] === ',') { i += 1; continue }
      return out
    }
  }
  const root = node()
  if (i !== text.length) throw new Error('select: лишняя закрывающая скобка')
  return root
}

// Связанные таблицы дерева: [{ path: ['contracts'], rel, node }] — путь из ключей (псевдонимов).
export function embedsOf(tree, prefix = []) {
  const out = []
  for (const e of tree.embeds) {
    const path = [...prefix, e.key]
    out.push({ path, rel: e.rel, node: e.node })
    out.push(...embedsOf(e.node, path))
  }
  return out
}

// ── Колонки запроса для одной связи ─────────────────────────────────────────
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and', 'not.or', 'not.and'])
const LOGIC = new Set(['or', 'and', 'not.or', 'not.and'])

// Колонки, по которым запрос фильтрует и сортирует связь с путём path ([] — верхняя таблица). → { cols: Set, logic: bool }
export function queryColumnsFor(params, path) {
  const cols = new Set()
  let logic = false
  const prefix = path.length ? `${path.join('.')}.` : ''
  for (const [key, value] of params) {
    if (key === 'select') continue
    let rest
    if (prefix) {
      if (!key.startsWith(prefix)) continue
      rest = key.slice(prefix.length)
    } else {
      rest = key
    }
    // Ключ другой (более глубокой) связи: «a.b.col» при пути [a] — не наш.
    if (rest.includes('.') && !LOGIC.has(rest)) continue
    if (LOGIC.has(rest)) { logic = true; continue }
    if (rest === 'order') {
      for (const part of value.split(',')) {
        const name = part.split('.')[0]
        if (!IDENT.test(name)) { logic = true; continue }
        cols.add(name)
      }
      continue
    }
    if (rest === 'limit' || rest === 'offset') continue
    if (rest === 'on_conflict' || rest === 'columns') {
      for (const name of value.split(',')) cols.add(name.trim())
      continue
    }
    if (RESERVED.has(rest)) continue
    // Фильтр по колонке. Json-путь или приведение в ключе — не простая колонка.
    if (!IDENT.test(rest)) { logic = true; continue }
    cols.add(rest)
  }
  return { cols, logic }
}

// ── Решение ──────────────────────────────────────────────────────────────────
// rule + права → { full: bool } | { columns: Set } | null (нет).
export function evaluateRule(rule, rights) {
  if (rule === undefined || rule === 'admin') return rights.admin ? { full: true } : null
  if (rule === 'none') return null
  if (rule === 'employee') return rights.employee ? { full: true } : null
  if (rights.admin) return { full: true }
  let limited = null
  for (const v of rule) {
    const ok = v.any ? v.any.some(([s, k]) => rights.can(s, k)) : (rights.employee && v.role.includes(rights.role))
    if (!ok) continue
    if (!v.columns) return { full: true }
    limited ??= new Set()
    for (const c of v.columns) limited.add(c)
  }
  return limited ? { columns: limited } : null
}

// Ограничение колонками для чтения связи: всё запрошенное — из разрешённого, без «*», без сложных колонок и логики.
function readColumnsProblem(node, allowed, params, path) {
  if (node.star) return 'запрошены все колонки'
  for (const c of node.cols) {
    if (c.complex) return `колонка ${c.name || '?'} не простая`
    if (!allowed.has(c.name)) return `колонка ${c.name}`
  }
  const q = queryColumnsFor(params, path)
  if (q.logic) return 'сложное условие'
  for (const c of q.cols) if (!allowed.has(c)) return `условие по колонке ${c}`
  return null
}

const describe = (rule) => (typeof rule === 'string' ? rule : JSON.stringify(rule))

// Решение по запросу. → { denied: [{ what, rule, mode }], bodyColumns: Set | null, rpc?: … }
//   what — «table.action» / «rpc name»; mode — 'enforce' | 'log' (как поступить с этим отказом).
//   bodyColumns — запись разрешена только этими колонками тела (проверит вызывающий, когда тело прочитано).
export function decideSections(map, rights, { kind, name, method, actions, select = '', params = new URLSearchParams(), modes }) {
  const denied = []
  let bodyColumns = null
  const readMode = (entry) => (entry?.read === 'reference' ? modes.readReference : 'enforce')

  let tree
  try {
    tree = parseSelect(select || '*')
  } catch (err) {
    return { error: err.message }
  }

  if (kind === 'rpc') {
    const f = map.rpc[name]
    const ok = evaluateRule(f?.call, rights)
    const write = f?.kind === 'write' && method === 'POST'
    if (!ok) denied.push({ what: `rpc ${name}`, rule: describe(f?.call), mode: write ? modes.write : readMode(f) })
  } else {
    const t = map.tables[name]
    for (const action of actions) {
      const res = evaluateRule(t?.[action], rights)
      const mode = action === 'select' ? readMode(t) : modes.write
      if (!res) { denied.push({ what: `${name}.${action}`, rule: describe(t?.[action]), mode }); continue }
      if (res.full) continue
      if (action === 'select') {
        const problem = readColumnsProblem(tree, res.columns, params, [])
        if (problem) denied.push({ what: `${name}.select (${problem})`, rule: describe(t?.[action]), mode })
      } else if (action === 'delete') {
        denied.push({ what: `${name}.delete`, rule: describe(t?.[action]), mode })
      } else {
        // Запись колонками: ключи тела — после его чтения; колонки запроса (columns, on_conflict) — сразу.
        const q = queryColumnsFor(new URLSearchParams([...params].filter(([k]) => k === 'columns' || k === 'on_conflict')), [])
        const bad = [...q.cols].find((c) => !res.columns.has(c))
        if (bad) { denied.push({ what: `${name}.${action} (колонка ${bad})`, rule: describe(t?.[action]), mode }); continue }
        bodyColumns = bodyColumns ? new Set([...bodyColumns].filter((c) => res.columns.has(c))) : new Set(res.columns)
        bodyColumns.mode = mode
      }
    }
  }

  // Связанные таблицы в select — всегда чтение.
  for (const e of embedsOf(tree)) {
    const t = map.tables[e.rel]
    const res = evaluateRule(t?.select, rights)
    const mode = readMode(t)
    if (!res) { denied.push({ what: `${e.rel}.select (связь ${e.path.join('.')})`, rule: describe(t?.select), mode }); continue }
    if (res.full) continue
    const problem = readColumnsProblem(e.node, res.columns, params, e.path)
    if (problem) denied.push({ what: `${e.rel}.select (связь ${e.path.join('.')}: ${problem})`, rule: describe(t?.select), mode })
  }
  return { denied, bodyColumns }
}

// Тело записи с ограничением колонками: JSON-объект или массив объектов, ключи — из разрешённых. → null или текст отказа.
export function bodyColumnsProblem(body, allowed) {
  let data
  try {
    data = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''))
  } catch {
    return 'тело — не JSON'
  }
  const rows = Array.isArray(data) ? data : [data]
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'тело — не объект'
    for (const key of Object.keys(row)) if (!allowed.has(key)) return `колонка ${key}`
  }
  return null
}
