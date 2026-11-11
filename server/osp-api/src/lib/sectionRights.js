// Права разделов вошедшего — для шлюза данных (src/routes/dbGateway.js, src/lib/dbSections.js).
//
// Расчёт повторяет функции базы (supabase/migrations/20261010_r2ab_employee_only.sql):
//   • is_admin()       — одобренная роль admin или запись в superadmins;
//   • osp_is_employee()— одобрен и (администратор или: не заблокирован, без организации, роль не contractor), или суперадминистратор;
//   • osp_can(s, k)    — администратор, или сотрудник (одобрен, не заблокирован, без организации, не contractor) с флагом
//                        can_view / can_edit раздела в role_permissions своей роли.
// Совпадение с базой сторожит tests/osp-api/db-sections.test.mjs (расчёт против osp_can на синтетических пользователях).
//
// Кто пользователь — только из сессии или токена (principal), не из запроса. Строка читается служебной операцией и
// хранится не дольше ttlMs (как статус учётки, src/lib/userStatus.js): смена роли и прав действует не позже чем через
// это время. Сбой базы не кэшируется и не превращается в «прав нет»: вызывающий отвечает 503.
export const RIGHTS_DEFAULTS = { ttlMs: 30_000, maxEntries: 2000 }
const RIGHTS_TTL_MAX_MS = 60_000

const QUERY = `select r.role, r.counterparty_id, r.is_approved, r.is_blocked,
    coalesce(jsonb_object_agg(p.section, jsonb_build_array(coalesce(p.can_view, false), coalesce(p.can_edit, false)))
      filter (where p.section is not null), '{}'::jsonb) as perms
  from public.user_roles r
  left join public.role_permissions p on p.role = r.role
  where r.user_id = $1
  group by r.user_id, r.role, r.counterparty_id, r.is_approved, r.is_blocked`
const SUPERADMIN_QUERY = `select to_regclass('public.superadmins') is not null
    and exists (select 1 from public.superadmins s where s.user_id = $1) as ok`

// Строка user_roles + права роли + признак суперадминистратора → права. Чистая функция (тесты сверяют её с базой).
export function rightsFromRow(row, superadmin = false) {
  if (!row && !superadmin) return null
  const role = row?.role || null
  const approved = row?.is_approved === true
  const blocked = row?.is_blocked === true
  const contractor = Boolean(row?.counterparty_id) || role === 'contractor'
  const admin = superadmin || (role === 'admin' && approved)
  const employee = superadmin || (approved && (role === 'admin' || (!blocked && !contractor)))
  // Права раздела — у одобренного незаблокированного сотрудника без организации (как в osp_can).
  const working = approved && !blocked && !contractor
  const perms = row?.perms && typeof row.perms === 'object' ? row.perms : {}
  return {
    role,
    admin,
    superadmin,
    employee,
    contractor: contractor && !superadmin,
    can(section, kind) {
      if (admin) return true
      if (!working) return false
      const p = perms[section]
      return Array.isArray(p) && p[kind === 'edit' ? 1 : 0] === true
    },
  }
}

export function createSectionRights({ db, ttlMs = RIGHTS_DEFAULTS.ttlMs, maxEntries = RIGHTS_DEFAULTS.maxEntries, now = Date.now }) {
  if (!db) throw new Error('osp-api: права разделов читаются из базы — подключение не задано')
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > RIGHTS_TTL_MAX_MS) {
    throw new Error(`osp-api: права разделов хранятся не дольше ${RIGHTS_TTL_MAX_MS / 1000} с`)
  }
  const cache = new Map() // userId → { rights, at }
  const pending = new Map()

  const load = (userId) => db.read(null, async (tx) => {
    const { rows } = await tx.query(QUERY, [userId])
    const sa = await tx.query(SUPERADMIN_QUERY, [userId])
    return rightsFromRow(rows.length === 1 ? rows[0] : null, sa.rows[0]?.ok === true)
  })

  function get(userId) {
    const hit = cache.get(userId)
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.rights)
    let reading = pending.get(userId)
    if (!reading) {
      reading = load(userId).then((rights) => {
        cache.delete(userId)
        cache.set(userId, { rights, at: now() })
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
        return rights
      }).finally(() => pending.delete(userId))
      pending.set(userId, reading)
    }
    return reading
  }

  return { get, forget: (userId) => cache.delete(userId), clear: () => cache.clear(), size: () => cache.size }
}
