// Пересчёт реестра расценок по расписанию — только если таблицы-источники менялись.
//
// REFRESH MATERIALIZED VIEW заново собирает весь реестр: разбор 144 тыс. строк КП, сортировка во временные файлы, сверка
// со старой версией. За сутки на базе Яндекса это 137 пересчётов и 29 ГБ временных файлов — ночью и в выходные тоже, хотя
// данные не менялись. Теперь такт сначала смотрит счётчики записей источников (pg_stat_user_tables, это чтение
// каталога, без обращения к самим таблицам) и пересчитывает, только если они сдвинулись.
//
// Откуда список источников. Из зависимостей самих представлений (pg_depend): новая таблица в реестре попадает в проверку
// без правки этого файла, забыть про неё нельзя.
//
// Почему это не отдаст устаревший реестр:
//   • счётчик растёт при любой вставке, правке и удалении в любом подключении; статистика приходит с задержкой
//     в секунды — изменение заметит следующий такт;
//   • не удалось прочитать счётчики или среди источников есть что-то, кроме таблиц (представление) — пересчёт,
//     как раньше;
//   • перезапуск службы или новый узел базы — счётчики неизвестны или другие, пересчёт;
//   • раз в maxAgeMs пересчёт в любом случае — страховка;
//   • кнопка «Обновить» на странице работает как раньше, в обход этой проверки.
export const REGISTRY_REFRESH_DEFAULTS = { intervalMs: 10 * 60_000, maxAgeMs: 6 * 60 * 60_000, statementTimeoutMs: 180_000 }

export const REGISTRY_ACTIVITY_SQL = `
with mv as (
  select (quote_ident(schemaname) || '.' || quote_ident(matviewname))::regclass as oid
  from pg_catalog.pg_matviews
  where matviewname in ('kp_rates_registry_mv', 'supply_rates_registry_mv')
), src as (
  select distinct d.refobjid as oid, c.relkind
  from mv
  join pg_catalog.pg_rewrite r on r.ev_class = mv.oid
  join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = r.oid
    and d.refclassid = 'pg_catalog.pg_class'::regclass
  join pg_catalog.pg_class c on c.oid = d.refobjid
  where d.refobjid <> mv.oid
)
select count(*)::int as tables,
  coalesce(bool_or(src.relkind not in ('r', 'p')), false) as opaque,
  coalesce(string_agg(s.relid::text || ':' || s.n_tup_ins || ':' || s.n_tup_upd || ':' || s.n_tup_del, ',' order by s.relid), '') as signature
from src
left join pg_catalog.pg_stat_user_tables s on s.relid = src.oid`

export function createRegistryRefresh({ db, log = console, now = Date.now, options = {} }) {
  const o = { ...REGISTRY_REFRESH_DEFAULTS, ...options }
  let last = null // { signature, at } последнего настоящего пересчёта

  async function readSignature() {
    try {
      const row = await db.read(null, async (tx) => (await tx.query(REGISTRY_ACTIVITY_SQL)).rows[0])
      return row && row.tables > 0 && !row.opaque && row.signature ? row.signature : null
    } catch (err) {
      log.warn?.({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'registry activity')
      return null
    }
  }

  // Защита от двойного запуска — блокировка в базе: вторая копия службы (или параллельный запуск) пересчёт пропустит.
  // Функция отдаёт now() этой транзакции, только если пересчитала: повторный вызов в течение минуты отдаёт время прошлого.
  const refresh = () => db.write(null, async (tx) => {
    const { rows } = await tx.query('select pg_try_advisory_xact_lock(hashtext($1)) as ok', ['osp:registry-refresh'])
    if (!rows[0].ok) return 'busy'
    const done = await tx.query('select public.refresh_rates_registry() = now() as refreshed')
    return done.rows[0].refreshed ? 'refreshed' : 'recent'
  }, { statementTimeoutMs: o.statementTimeoutMs })

  // Источники не менялись. Подпись «Данные на …» на странице — время, на которое реестр верен, а не время пересчёта:
  // пишем только её. Колонка updated_at (по ней функция отсчитывает минуту между пересчётами) остаётся прежней —
  // кнопка «Обновить» сразу после такой отметки пересчитает как обычно.
  const markCurrent = () => db.write(null, (tx) => tx.query(
    "update public.app_settings set value = now()::text where key = 'rates_registry_refreshed_at'"))

  // → 'refreshed' | 'unchanged' | 'busy' | 'recent'. Сбой пересчёта — исключение: следующий такт повторит.
  async function run() {
    const signature = await readSignature()
    if (signature && last && last.signature === signature && now() - last.at < o.maxAgeMs) {
      await markCurrent()
      return 'unchanged'
    }
    const result = await refresh()
    // Подпись читали до пересчёта: правка во время него сдвинет счётчик, и следующий такт пересчитает снова.
    // busy и recent — пересчёта не было, запоминать нечего.
    last = result === 'refreshed' && signature ? { signature, at: now() } : null
    return result
  }

  function start() {
    const timer = setInterval(() => {
      run().catch((err) => log.warn?.({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'registry refresh'))
    }, o.intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  return { run, start }
}
