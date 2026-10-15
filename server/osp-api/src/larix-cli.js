// Договорные расценки из Larix.CPM — ручные команды. На сервере corp — в образе выложенного выпуска с
// настройками портала (deploy/docker/deploy.sh):
//
//   bash /opt/portals/osp/deploy.sh larix probe
//   bash /opt/portals/osp/deploy.sh larix sync [--force] [--target db|supabase]
//
//   probe                          — только чтение: что отдаёт Larix (размер, число позиций, имена и типы полей,
//                                    виды документов и статусы договоров) и сколько наших договоров со ссылкой
//                                    на Larix нашлось в ответе. Ни названий, ни цен не печатает.
//   sync [--force] [--target db|supabase]
//                                  — внеочередная загрузка (без ожидания расписания). --force принимает ответ,
//                                    который защита отложила бы (пустой или намного меньше прежнего).
//
// Настройки — те же переменные, что у службы (LARIX_*, OSP_DB_URL, SUPABASE_*); LARIX_SYNC для команд не нужен.
// Логин, пароль и токен не печатаются. Выход: 0 — готово; 3 — загрузка отложена защитой (held); 4 — сбой;
// 1 — ошибка запуска.
import { loadConfig } from './config.js'
import { defaultDeps, buildLarixTargets, larixSecrets } from './app.js'
import { createLarixClient, redact } from './lib/larixClient.js'
import { createLarixSync, normalizeBoq } from './lib/larixSync.js'

const LINK_RE = /^\s*https?:\/\/cpm\.su10\.larix\.ru\/contract\/(\d{1,15})\/?([?#].*)?\s*$/i
const ROUND = [1000, 2000, 5000, 10000, 20000, 50000, 100000]

const log = {
  info: (obj, msg) => console.error(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.error(JSON.stringify({ level: 'warn', msg, ...obj })),
}

function usage() {
  console.error('Использование: node src/larix-cli.js probe | sync [--force] [--target db|supabase]')
  return 1
}

// Наши договоры со ссылкой «Путь к Larix.CPM» — номера договоров Larix (только чтение).
async function ourLarixIds(config, db, deps) {
  const ids = []
  if (db) {
    const rows = await db.read(null, async (tx) => (await tx.query(
      'select document_link from public.contracts where deleted_at is null and document_link is not null')).rows)
    for (const r of rows) { const m = LINK_RE.exec(r.document_link || ''); if (m) ids.push(Number(m[1])) }
    return ids
  }
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null
  const client = deps.createSupabase(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from('contracts').select('document_link').is('deleted_at', null)
      .not('document_link', 'is', null).range(from, from + 999)
    if (error) throw new Error(`contracts: ${error.code || error.message}`)
    for (const r of data || []) { const m = LINK_RE.exec(r.document_link || ''); if (m) ids.push(Number(m[1])) }
    if (!data || data.length < 1000) return ids
  }
}

const typeOf = (v) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const fmt = (n) => Number(n).toLocaleString('ru-RU')

async function probe(config, db, deps) {
  const client = createLarixClient(config.larix)
  const t0 = Date.now()
  const { rows: raw, bytes } = await client.fetchBoq()
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`Larix: ответ ${(bytes / 1024 / 1024).toFixed(1)} МБ, позиций ${fmt(raw.length)}, за ${seconds} с`)
  const types = new Map()
  const tally = (map, key) => map.set(key, (map.get(key) || 0) + 1)
  const objectTypes = new Map()
  const states = new Map()
  const contracts = new Set()
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    for (const [k, v] of Object.entries(r)) {
      if (!types.has(k)) types.set(k, new Map())
      tally(types.get(k), typeOf(v))
    }
    tally(objectTypes, String(r.object_type ?? '—').slice(0, 60))
    tally(states, String(r.contract_state ?? '—').slice(0, 60))
    if (r.contract_id !== null && r.contract_id !== undefined) contracts.add(Number(r.contract_id))
  }
  console.log('Поля и типы значений:')
  for (const [k, m] of [...types.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${k.slice(0, 64)}: ${[...m.entries()].map(([t, n]) => `${t} ${fmt(n)}`).join(', ')}`)
  }
  const vatLike = [...types.keys()].filter((k) => /vat|nds|tax|ндс/i.test(k))
  console.log(`Похоже на ставку НДС: ${vatLike.length ? vatLike.join(', ') : 'нет такого поля'}`)
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([v, n]) => `${v} (${fmt(n)})`).join('; ')
  console.log(`Виды документов (object_type): ${top(objectTypes)}`)
  console.log(`Статусы договоров (contract_state): ${top(states)}`)
  const { rows, skipped } = normalizeBoq(raw)
  console.log(`Прошли проверку: ${fmt(rows.length)}; отброшено: ${fmt(skipped)}`)
  const materials = rows.filter((r) => r.price_material > 0).length
  const works = rows.filter((r) => r.price_work > 0).length
  console.log(`Строк реестра будет: материалы ${fmt(materials)}, работы ${fmt(works)}`)
  if (ROUND.includes(raw.length)) console.log(`ВНИМАНИЕ число позиций круглое (${fmt(raw.length)}) — возможно, Larix отдаёт не всё (предел страницы)`)
  const ours = await ourLarixIds(config, db, deps)
  if (ours === null) {
    console.log(`Договоров в ответе: ${fmt(contracts.size)}; наши договоры не прочитаны (нет OSP_DB_URL и служебного ключа Supabase)`)
  } else {
    const uniq = new Set(ours)
    const found = [...uniq].filter((id) => contracts.has(id)).length
    console.log(`Договоров в ответе: ${fmt(contracts.size)}; наших договоров со ссылкой на Larix: ${fmt(uniq.size)}, из них есть в ответе: ${fmt(found)}`)
    if (uniq.size > 0 && found === 0) console.log('ВНИМАНИЕ ни один номер из наших ссылок не совпал с contract_id — ссылки на нашу карточку договора работать не будут')
  }
  return 0
}

async function sync(config, db, deps, { force, only }) {
  const larixSync = createLarixSync({
    client: createLarixClient(config.larix),
    targets: buildLarixTargets(config, { db, deps }),
    log,
    secrets: larixSecrets(config),
  })
  const out = await larixSync.runOnce({ startedBy: 'cli', force, only })
  if (!out.started) {
    console.log('Загрузка не начата: идёт другая (или цель не выбрана)')
    return 4
  }
  for (const [name, r] of Object.entries(out.results)) {
    console.log(`${name}: ${r?.status || '—'}${r?.positions !== undefined ? `, позиций ${fmt(r.positions)}` : ''}${r?.rows !== undefined ? `, строк ${fmt(r.rows)}` : ''}`
      + `${r?.matched !== undefined ? `, договоров найдено у нас ${fmt(r.matched)} из ${fmt(r.contracts)}` : ''}${r?.reason ? ` (${r.reason})` : ''}${r?.code ? ` (${r.code})` : ''}`)
  }
  const statuses = Object.values(out.results).map((r) => r?.status)
  if (statuses.includes('failed')) return 4
  if (statuses.includes('held')) return 3
  return 0
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (!['probe', 'sync'].includes(cmd)) return usage()
  const force = rest.includes('--force')
  const ti = rest.indexOf('--target')
  const only = ti >= 0 ? rest[ti + 1] : null
  const known = new Set(['--force', '--target', only].filter(Boolean))
  if (cmd === 'probe' && rest.length) return usage()
  if (rest.some((a) => !known.has(a)) || (ti >= 0 && !['db', 'supabase'].includes(only))) return usage()

  // Для команд загрузка «включена» всегда: проверяются логин, адрес и базы-цели, как у службы.
  const config = loadConfig({ ...process.env, LARIX_SYNC: '1' })
  const deps = defaultDeps
  const db = config.db.url ? deps.createDb({ url: config.db.url, caFile: config.db.caFile, max: 1, logger: log }) : null
  try {
    return cmd === 'probe' ? await probe(config, db, deps) : await sync(config, db, deps, { force, only })
  } catch (err) {
    console.error(`FAIL ${redact(err?.message || err, larixSecrets(config)).slice(0, 300)}`)
    return 4
  } finally {
    await db?.close()
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
  console.error(`FAIL ${String(err?.message || err).slice(0, 300)}`)
  process.exitCode = 1
})
