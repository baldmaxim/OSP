// Организация учётки СУ-10 → контрагент ОСП (вход через Keycloak; migration/yandex/20270201_su10_org_links.sql,
// temp/osp-org-mapping.md, план ред. 2). Правило — fail-closed: ошибка связи открыла бы чужую историю контрагента.
//
// Решение при каждом входе и каждой перепроверке — по claim su10_org_id из подписанного access token, кэшу реестра и связи:
//   итог  none (claim пуст) | ambiguous (два и больше) | unknown (нет в реестре и после перечитывания) |
//         inactive (организация пропала из реестра или с ошибкой) | own (своя) | unmapped (подрядчик без связи; связь на
//         удалённого контрагента или из чёрного списка — тоже) | counterparty (связь есть, контрагент жив).
//   подрядчик в ОСП (роль contractor или counterparty_id не NULL):
//         counterparty(X) и X у него → ничего (отметка counterparty_source='su10' ставится, если её не было);
//         counterparty(X), у него другой → user_roles.counterparty_id = X, все его сессии закрыты (и триггером базы), org.change;
//         иначе → отказ OSP_ORG_UNMAPPED, все его сессии закрыты, org.denied; counterparty_id не трогаем.
//   сотрудник (counterparty_id IS NULL и роль не contractor) — решение пользователя 11.11.2026:
//         own → вход; иначе — отказ OSP_ORG_DENIED и закрытие сессий, кроме исключения суперадминистратора для той же
//         организации (для пустого claim — исключение без организации). ambiguous исключением не покрывается.
//   counterparty_id = NULL автоматически не ставится нигде: в ОСП NULL означает «сотрудник СУ-10».
//
// Гонки: вход, перепроверка, связь администратора и сверка реестра берут pg_advisory_xact_lock по организации; строка
// user_roles — FOR UPDATE, контрагент — FOR SHARE. Поэтому живой сессии без действующей связи не остаётся: отзыв идёт после
// фиксации входа, а вход после отзыва видит новое состояние.
//
// Реестр (подгруппы /org в Keycloak, src/lib/auth/kcAdmin.js) — в osp_auth.su10_orgs. Сверка — только полным чтением; новое
// поколение: увиденные → active или invalid, неувиденные → missing. Предохранитель: пустой реестр после непустого или массовое
// выбывание связанных организаций — ничего не меняется (событие org.registry с held), принять — identity orgs-sync --force.
// Связь действует только у active + contractor; выбывшая связанная организация — сессии её подрядчиков закрываются в той же
// транзакции. subject_orgs (организация учётки и членство в группе доступа) — только для показа администратору.
import { randomUUID } from 'node:crypto'

export const ORG_ERRORS = {
  unmapped: { status: 403, code: 'OSP_ORG_UNMAPPED', message: 'Организация не сопоставлена с контрагентом ОСП — обратитесь к администратору ОСП' },
  denied: { status: 403, code: 'OSP_ORG_DENIED', message: 'Учётка СУ-10 не числится в организации СУ-10 — обратитесь к администратору ОСП' },
  changed: { status: 401, code: 'OSP_ORG_CHANGED', message: 'Организация учётки СУ-10 изменилась — войдите заново' },
}
export const ORGS_DEFAULTS = {
  throttleMs: 15_000, unknownWaitMs: 5_000, memberLookups: 50, memberStaleMs: 24 * 60 * 60_000,
  breakerMin: 5, breakerShare: 0.2, candidatesCacheMs: 60_000,
}
export const REGISTRY_META = 'su10_org_registry'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const lockKey = (issuer, orgId) => `osp-org:${issuer}:${String(orgId).toLowerCase()}`
export async function lockOrgsTx(tx, issuer, orgIds) {
  for (const id of [...new Set(orgIds.map((x) => String(x).toLowerCase()))].sort()) {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(issuer, id)])
  }
}
const event = (tx, userId, kind, detail = {}) =>
  tx.query('insert into osp_auth.events (user_id, kind, detail) values ($1, $2, $3)', [userId, kind, JSON.stringify(detail)])

// Готовность режима keycloak: таблицы есть, реестр хоть раз сверен полностью, своя организация в нём действует. Без своей
// организации сотрудники получили бы отказ. Внутри транзакции вызывающего с отметкой 'auth'. → текст проблемы или null
export async function orgRegistryProblemTx(tx, issuer) {
  const { rows } = await tx.query("select to_regclass('osp_auth.su10_orgs') is not null as ok")
  if (!rows[0].ok) return 'нет таблиц организаций СУ-10 — сначала миграция 20270201 (deploy-server.sh migrate)'
  const meta = (await tx.query('select value from osp_auth.meta where key = $1', [REGISTRY_META])).rows[0]
  let state = {}
  try { state = JSON.parse(meta?.value || '{}') } catch { state = {} }
  if (!state.generation) return 'реестр организаций СУ-10 ещё не сверен — identity orgs-sync'
  const own = (await tx.query(`select count(*)::int as n from osp_auth.su10_orgs where issuer = $1 and state = 'active' and kind = 'own'`, [issuer])).rows[0].n
  if (!own) return 'в реестре организаций СУ-10 нет действующей своей организации — сотрудники не войдут; проверьте реестр (identity orgs-sync)'
  return null
}

export function createOrgs({ db, kcAdmin = null, issuer, sessions, userStatus = null, log = null, now = Date.now, options = {} }) {
  const o = { ...ORGS_DEFAULTS, ...options }
  let present = null // таблицы есть (true — навсегда; false — перепроверка раз в минуту)
  let presentAt = 0
  let refreshing = null
  let lastRefresh = null // { at, result | error }

  async function enabled() {
    if (present === true) return true
    if (present === false && now() - presentAt < 60_000) return false
    const r = await db.read(null, (tx) => tx.query("select to_regclass('osp_auth.org_links') is not null as ok"))
    present = r.rows[0].ok
    presentAt = now()
    return present
  }

  // ── Решение по организации ──────────────────────────────────────────────────────────────────────────────────────
  // Внутри транзакции вызывающего; оставляет отметку 'auth'. Блокирует организацию до конца транзакции.
  async function resolveTx(tx, orgIds) {
    const ids = [...new Set((orgIds || []).map((x) => String(x).toLowerCase()))]
    if (!ids.length) return { result: 'none', orgId: null }
    if (ids.length > 1) return { result: 'ambiguous', orgId: null, orgIds: ids }
    const orgId = ids[0]
    await tx.mark('auth')
    await lockOrgsTx(tx, issuer, [orgId])
    const org = (await tx.query('select su10_org_id, kind, name, state from osp_auth.su10_orgs where issuer = $1 and su10_org_id = $2',
      [issuer, orgId])).rows[0]
    if (!org) return { result: 'unknown', orgId }
    if (org.state !== 'active') return { result: 'inactive', orgId, kind: org.kind }
    if (org.kind === 'own') return { result: 'own', orgId, kind: 'own' }
    const link = (await tx.query('select counterparty_id from osp_auth.org_links where issuer = $1 and su10_org_id = $2', [issuer, orgId])).rows[0]
    if (!link) return { result: 'unmapped', orgId, kind: 'contractor' }
    await tx.mark('internal')
    const cp = (await tx.query('select id, status::text as status, deleted_at from public.counterparties where id = $1 for share',
      [link.counterparty_id])).rows[0]
    await tx.mark('auth')
    if (!cp || cp.deleted_at || cp.status === 'blacklist') return { result: 'unmapped', orgId, kind: 'contractor', blocked: true }
    return { result: 'counterparty', orgId, kind: 'contractor', counterpartyId: cp.id }
  }

  // Организации нет в кэше — один раз перечитать реестр (не чаще раза в 15 с, ждать не дольше 5 с). Вне транзакции входа.
  async function ensureKnown(orgIds) {
    const ids = [...new Set((orgIds || []).map((x) => String(x).toLowerCase()))]
    if (ids.length !== 1 || !kcAdmin || !(await enabled())) return
    const known = await db.read(null, async (tx) => {
      await tx.mark('auth')
      return (await tx.query('select 1 from osp_auth.su10_orgs where issuer = $1 and su10_org_id = $2', [issuer, ids[0]])).rows.length > 0
    })
    if (known) return
    const wait = new Promise((resolve) => { setTimeout(resolve, o.unknownWaitMs).unref?.() })
    await Promise.race([refreshRegistry({ throttle: true }).catch((err) => log?.warn({ code: err?.code }, 'org registry refresh')), wait])
  }

  // Применить итог к учётке портала. Внутри транзакции вызывающего (отметки ставит сама). via — login | recheck.
  // → { ok: true, changed?: true, result } | { ok: false, error: 'unmapped' | 'denied', result }
  async function applyTx(tx, { userId, subject, orgIds, via }) {
    if (!(await tableReadyTx(tx))) return { ok: true, result: { result: 'disabled' } }
    await recordTx(tx, subject, orgIds)
    const r = await resolveTx(tx, orgIds)
    await tx.mark('internal')
    const role = (await tx.query('select role, counterparty_id, counterparty_source from public.user_roles where user_id = $1 for update', [userId])).rows[0]
    const contractor = Boolean(role && (role.role === 'contractor' || role.counterparty_id))

    if (contractor) {
      if (r.result === 'counterparty') {
        if (role.counterparty_id === r.counterpartyId) {
          if (role.counterparty_source !== 'su10') {
            await tx.query(`update public.user_roles set counterparty_source = 'su10' where user_id = $1`, [userId])
          }
          return { ok: true, result: r }
        }
        // Другой контрагент: триггер базы закроет все сессии; кэш сессий этой службы — сразу.
        await tx.query(`update public.user_roles set counterparty_id = $2, counterparty_source = 'su10' where user_id = $1`, [userId, r.counterpartyId])
        await sessions.revokeAllInTx(tx, userId, 'org_changed')
        userStatus?.forget?.(userId)
        await tx.mark('auth')
        await event(tx, userId, 'org.change', { from: role.counterparty_id || null, to: r.counterpartyId, org: r.orgId, via })
        return { ok: true, changed: true, result: r }
      }
      await sessions.revokeAllInTx(tx, userId, 'org_denied')
      await tx.mark('auth')
      await event(tx, userId, 'org.denied', { as: 'contractor', result: r.result, org: r.orgId || null, via })
      return { ok: false, error: 'unmapped', result: r }
    }

    if (r.result === 'own') return { ok: true, result: r }
    await tx.mark('auth')
    if (r.result !== 'ambiguous') {
      const exc = (await tx.query('select su10_org_id from osp_auth.org_exceptions where issuer = $1 and subject = $2', [issuer, subject])).rows[0]
      if (exc && (exc.su10_org_id || null) === (r.orgId || null)) return { ok: true, result: r, exception: true }
    }
    await tx.mark('internal')
    await sessions.revokeAllInTx(tx, userId, 'org_denied')
    await tx.mark('auth')
    await event(tx, userId, 'org.denied', { as: 'employee', result: r.result, org: r.orgId || null, via })
    return { ok: false, error: 'denied', result: r }
  }

  // Организация учётки из токена — для показа администратору (заявки, вкладка). Внутри транзакции вызывающего; оставляет 'auth'.
  async function recordTx(tx, subject, orgIds) {
    if (!(await tableReadyTx(tx))) return
    await tx.mark('auth')
    await tx.query(`insert into osp_auth.subject_orgs (issuer, subject, org_ids, org_source, org_seen_at) values ($1, $2, $3::uuid[], 'token', now())
      on conflict (issuer, subject) do update set org_ids = excluded.org_ids, org_source = 'token', org_seen_at = now()`,
    [issuer, subject, (orgIds || []).slice(0, 10)])
  }

  // Организации учёток для показа (заявки, вкладка): без блокировок. → Map(subject → описание)
  //   описание: { known, orgIds, source, seenAt, org: { id, name, kind, inn, state } | null,
  //               counterparty: { id, number, name, status, deleted } | null, result }
  //   result: unknown_subject (организация учётки ещё не известна) | none | ambiguous | unknown | inactive | own | unmapped | counterparty
  async function describeSubjectsTx(tx, subjects) {
    const out = new Map()
    const list = [...new Set((subjects || []).filter(isUuid).map((x) => String(x).toLowerCase()))]
    if (!list.length || !(await tableReadyTx(tx))) return out
    await tx.mark('auth')
    const rows = (await tx.query(`select subject, org_ids, org_source, org_seen_at from osp_auth.subject_orgs
      where issuer = $1 and subject = any($2::uuid[])`, [issuer, list])).rows
    const orgIds = [...new Set(rows.flatMap((r) => (r.org_source ? r.org_ids || [] : [])))]
    const byOrg = new Map((await tx.query(`select su10_org_id, kind, name, inn, state from osp_auth.su10_orgs
      where issuer = $1 and su10_org_id = any($2::uuid[])`, [issuer, orgIds])).rows.map((r) => [r.su10_org_id, r]))
    const links = new Map((await tx.query(`select su10_org_id, counterparty_id from osp_auth.org_links
      where issuer = $1 and su10_org_id = any($2::uuid[])`, [issuer, orgIds])).rows.map((r) => [r.su10_org_id, r.counterparty_id]))
    await tx.mark('internal')
    const cps = new Map((await tx.query(`select c.id, (to_jsonb(c) ->> 'counterparty_number')::int as number, c.name, c.status::text as status,
        c.deleted_at is not null as deleted from public.counterparties c where c.id = any($1::uuid[])`, [[...links.values()]])).rows
      .map((r) => [r.id, r]))
    for (const r of rows) out.set(r.subject, describeOrg(r, byOrg, links, cps))
    for (const subject of list) if (!out.has(subject)) out.set(subject, describeOrg(null, byOrg, links, cps))
    return out
  }

  // Таблицы есть — проверка той же транзакцией (служба могла быть выложена раньше миграции).
  async function tableReadyTx(tx) {
    if (present === true) return true
    const r = await tx.query("select to_regclass('osp_auth.org_links') is not null as ok")
    present = r.rows[0].ok
    presentAt = now()
    return present
  }

  // Перепроверка сессии: отдельной транзакцией. → { ok: true } | { ok: false, key: 'unmapped' | 'denied' | 'changed' }
  async function applyOnRecheck({ userId, subject, orgIds }) {
    await ensureKnown(orgIds)
    const r = await db.write(null, (tx) => applyTx(tx, { userId, subject, orgIds, via: 'recheck' }))
    if (!r.ok) return { ok: false, key: r.error }
    if (r.changed) return { ok: false, key: 'changed' }
    return { ok: true }
  }

  // ── Реестр ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async function readMetaTx(tx) {
    const row = (await tx.query('select value from osp_auth.meta where key = $1', [REGISTRY_META])).rows[0]
    try { return JSON.parse(row?.value || '{}') } catch { return {} }
  }
  const writeMetaTx = (tx, value) => tx.query(`insert into osp_auth.meta (key, value, updated_at) values ($1, $2, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`, [REGISTRY_META, JSON.stringify(value)])

  // Сессии СУ-10 подрядчиков этих контрагентов — внутри транзакции (отметка internal). → сколько учёток задето
  async function revokeCounterpartyUsersTx(tx, counterpartyIds, reason) {
    if (!counterpartyIds.length) return 0
    await tx.mark('internal')
    const users = (await tx.query('select user_id from public.user_roles where counterparty_id = any($1::uuid[])', [counterpartyIds])).rows.map((r) => r.user_id)
    for (const u of users) await sessions.revokeKeycloakInTx(tx, u, reason)
    for (const u of users) userStatus?.forget?.(u)
    return users.length
  }

  async function applyRegistryTx(tx, { orgs, skipped }, force) {
    await tx.mark('auth')
    const meta = await readMetaTx(tx)
    const current = (await tx.query('select su10_org_id, kind, state from osp_auth.su10_orgs where issuer = $1', [issuer])).rows
    const ids = [...new Set([...current.map((r) => r.su10_org_id), ...orgs.map((x) => x.id)])]
    await lockOrgsTx(tx, issuer, ids)
    const links = (await tx.query('select su10_org_id, counterparty_id from osp_auth.org_links where issuer = $1', [issuer])).rows
    const incoming = new Map(orgs.map((x) => [x.id, x]))
    const losing = links.filter((l) => {
      const x = incoming.get(l.su10_org_id)
      return !x || x.state !== 'active' || x.kind !== 'contractor'
    })
    const prevActive = current.filter((r) => r.state === 'active')
    const goingMissing = prevActive.filter((r) => !incoming.has(r.su10_org_id)).length
    const reasons = []
    if (prevActive.length > 0 && orgs.length === 0) reasons.push('empty')
    if (losing.length > Math.max(o.breakerMin, links.length * o.breakerShare)) reasons.push('links')
    if (goingMissing > Math.max(o.breakerMin, prevActive.length * o.breakerShare)) reasons.push('drop')
    const summary = { orgs: orgs.length, invalid: orgs.filter((x) => x.state === 'invalid').length, missing: goingMissing,
      losing: losing.length, skipped, reasons, force: Boolean(force) }
    if (reasons.length && !force) {
      await writeMetaTx(tx, { ...meta, lastAttemptAt: new Date(now()).toISOString(), held: true, heldReasons: reasons, error: null })
      await event(tx, null, 'org.registry', { ...summary, held: true })
      return { ...summary, held: true, generation: meta.generation || 0 }
    }
    const generation = (Number(meta.generation) || 0) + 1
    for (const x of orgs) {
      await tx.query(`insert into osp_auth.su10_orgs (issuer, su10_org_id, kind, name, inn, state, invalid_reason, generation)
          values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (issuer, su10_org_id) do update set kind = excluded.kind, name = excluded.name, inn = excluded.inn,
          state = excluded.state, invalid_reason = excluded.invalid_reason, generation = excluded.generation, seen_at = now(),
          missing_since = null`,
      [issuer, x.id, x.kind, x.name, x.inn, x.state, x.invalidReason, generation])
    }
    await tx.query(`update osp_auth.su10_orgs set state = 'missing', invalid_reason = null, missing_since = coalesce(missing_since, now())
      where issuer = $1 and generation < $2 and state <> 'missing'`, [issuer, generation])
    const revoked = await revokeCounterpartyUsersTx(tx, losing.map((l) => l.counterparty_id), 'org_inactive')
    await tx.mark('auth')
    const at = new Date(now()).toISOString()
    await writeMetaTx(tx, { generation, at, lastAttemptAt: at, held: false, heldReasons: [], error: null, count: orgs.length })
    await event(tx, null, 'org.registry', { ...summary, generation, revoked })
    return { ...summary, held: false, generation, revoked }
  }

  // Перечитать реестр. throttle — частый вызов получает прошлый итог (не чаще раза в 15 с). Ошибка — кэш прежний, ошибка
  // запоминается для вкладки. → итог | исключение
  async function refreshRegistry({ force = false, throttle = false } = {}) {
    if (!kcAdmin) throw Object.assign(new Error('org registry: KC_ADMIN_* не заданы'), { code: 'kc_admin_missing' })
    if (throttle && !force && lastRefresh && now() - lastRefresh.at < o.throttleMs) {
      if (lastRefresh.error) throw lastRefresh.error
      return { ...lastRefresh.result, cached: true }
    }
    refreshing ??= (async () => {
      try {
        const registry = await kcAdmin.orgRegistry()
        const result = await db.write(null, (tx) => applyRegistryTx(tx, registry, force))
        lastRefresh = { at: now(), result }
        log?.info({ orgs: result.orgs, held: result.held, generation: result.generation, revoked: result.revoked ?? 0 }, 'org registry')
        return result
      } catch (err) {
        lastRefresh = { at: now(), error: err }
        await db.write(null, async (tx) => {
          await tx.mark('auth')
          const meta = await readMetaTx(tx)
          await writeMetaTx(tx, { ...meta, lastAttemptAt: new Date(now()).toISOString(), error: String(err?.code || 'error').slice(0, 80) })
        }).catch(() => {})
        throw err
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  // После сверки группы доступа (src/lib/auth/accessSync.js): реестр, членство, организации участников порциями. Только для
  // показа администратору — ошибки не ломают сверку. limit — сколько участников спросить у Admin API за проход.
  async function afterSync(members, { held = false, limit = o.memberLookups } = {}) {
    if (!(await enabled())) return { skipped: 'no_tables' }
    const out = { registry: null, lookups: 0, lookupErrors: 0 }
    try {
      out.registry = await refreshRegistry({ throttle: true })
    } catch (err) {
      log?.warn({ code: err?.code, status: err?.status }, 'org registry refresh')
    }
    if (held) return out
    const enabledIds = members.filter((m) => m.enabled).map((m) => m.id)
    await db.write(null, async (tx) => {
      await tx.mark('auth')
      await tx.query(`insert into osp_auth.subject_orgs (issuer, subject, in_group, group_seen_at)
          select $1, s, true, now() from unnest($2::uuid[]) as s
        on conflict (issuer, subject) do update set in_group = true, group_seen_at = now()`, [issuer, enabledIds])
      await tx.query(`update osp_auth.subject_orgs set in_group = false
        where issuer = $1 and in_group and not (subject = any($2::uuid[]))`, [issuer, enabledIds])
    })
    if (!kcAdmin || limit <= 0) return out
    const stale = await db.read(null, async (tx) => {
      await tx.mark('auth')
      return (await tx.query(`select subject from osp_auth.subject_orgs
        where issuer = $1 and in_group and (org_seen_at is null or org_seen_at < now() - make_interval(secs => $2))
        order by org_seen_at nulls first limit $3`, [issuer, o.memberStaleMs / 1000, limit])).rows.map((r) => r.subject)
    })
    for (const subject of stale) {
      let ids
      try {
        ids = await kcAdmin.userOrgs(subject)
      } catch (err) {
        out.lookupErrors++
        log?.warn({ code: err?.code, status: err?.status }, 'org user groups')
        break
      }
      await db.write(null, async (tx) => {
        await tx.mark('auth')
        await tx.query(`update osp_auth.subject_orgs set org_ids = $3::uuid[], org_source = 'admin_api', org_seen_at = now()
          where issuer = $1 and subject = $2`, [issuer, subject, ids.slice(0, 10)])
      })
      out.lookups++
    }
    return out
  }

  // Организация учётки для «Создать пользователя»: свежая из Admin API, иначе сохранённая. → { orgIds, source } | null
  async function subjectOrgs(subject) {
    if (kcAdmin) {
      try {
        const ids = await kcAdmin.userOrgs(subject)
        await db.write(null, async (tx) => {
          await tx.mark('auth')
          await tx.query(`insert into osp_auth.subject_orgs (issuer, subject, org_ids, org_source, org_seen_at) values ($1, $2, $3::uuid[], 'admin_api', now())
            on conflict (issuer, subject) do update set org_ids = excluded.org_ids, org_source = 'admin_api', org_seen_at = now()`,
          [issuer, subject, ids.slice(0, 10)])
        })
        return { orgIds: ids, source: 'admin_api' }
      } catch (err) {
        log?.warn({ code: err?.code, status: err?.status }, 'org user groups')
      }
    }
    const row = await db.read(null, async (tx) => {
      await tx.mark('auth')
      return (await tx.query('select org_ids, org_source from osp_auth.subject_orgs where issuer = $1 and subject = $2 and org_source is not null',
        [issuer, subject])).rows[0]
    })
    return row ? { orgIds: row.org_ids, source: row.org_source } : null
  }

  // Полная сверка для identity orgs-sync: реестр (force — принять отложенное предохранителем) и организации всех участников
  // группы доступа без предела. → итог
  async function fullSync({ force = false } = {}) {
    if (!kcAdmin) throw Object.assign(new Error('org registry: KC_ADMIN_* не заданы'), { code: 'kc_admin_missing' })
    const registry = await refreshRegistry({ force })
    const members = await kcAdmin.groupMembers()
    const after = await afterSync(members, { held: registry.held, limit: Number.MAX_SAFE_INTEGER })
    const notOwn = registry.held ? [] : await employeesNotInOwn()
    return { registry, members: members.filter((m) => m.enabled).length, lookups: after.lookups, lookupErrors: after.lookupErrors, employeesNotInOwn: notOwn }
  }

  // Учётки портала-сотрудников, связанные с СУ-10, у которых организация не своя (им нужно исключение до переключения).
  // → [{ userId, subject, result }] — только id, без почт и ФИО.
  async function employeesNotInOwn() {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const links = (await tx.query(`select l.user_id, l.subject, s.org_ids, s.org_source, e.su10_org_id as exc_org, e.subject is not null as has_exc
          from osp_auth.identity_links l
          left join osp_auth.subject_orgs s on s.issuer = l.issuer and s.subject = l.subject
          left join osp_auth.org_exceptions e on e.issuer = l.issuer and e.subject = l.subject
        where l.issuer = $1`, [issuer])).rows
      const orgs = new Map((await tx.query('select su10_org_id, kind, state from osp_auth.su10_orgs where issuer = $1', [issuer])).rows
        .map((r) => [r.su10_org_id, r]))
      await tx.mark('internal')
      const roles = new Map((await tx.query('select user_id, role, counterparty_id from public.user_roles')).rows.map((r) => [r.user_id, r]))
      const out = []
      for (const l of links) {
        const role = roles.get(l.user_id)
        if (role && (role.role === 'contractor' || role.counterparty_id)) continue
        const ids = l.org_source ? (l.org_ids || []) : []
        let result = 'unknown' // организация учётки ещё не известна
        if (ids.length > 1) result = 'ambiguous'
        else if (ids.length === 1) {
          const org = orgs.get(ids[0])
          result = !org ? 'unknown' : org.state !== 'active' ? 'inactive' : org.kind === 'own' ? 'own' : 'contractor'
        } else if (l.org_source) result = 'none'
        if (result === 'own') continue
        if (l.has_exc && result !== 'ambiguous' && (l.exc_org || null) === (ids[0] || null)) continue
        out.push({ userId: l.user_id, subject: l.subject, result })
      }
      return out
    })
  }

  return {
    enabled, resolveTx, applyTx, recordTx, describeSubjectsTx, applyOnRecheck, ensureKnown, refreshRegistry, afterSync, subjectOrgs, fullSync, employeesNotInOwn,
    revokeCounterpartyUsersTx, lockOrgsTx: (tx, ids) => lockOrgsTx(tx, issuer, ids), lastRefresh: () => lastRefresh,
    configured: () => Boolean(kcAdmin), issuer, owner: randomUUID(), options: o,
  }
}

export const isUuid = (v) => UUID.test(String(v ?? ''))

// Описание организации учётки для показа (без блокировок; решение о доступе — только resolveTx).
export function describeOrg(row, byOrg, links, cps) {
  const base = { known: Boolean(row?.org_source), orgIds: row?.org_source ? row.org_ids || [] : [], source: row?.org_source || null,
    seenAt: row?.org_seen_at || null, org: null, counterparty: null, result: 'unknown_subject' }
  if (!base.known) return base
  if (!base.orgIds.length) return { ...base, result: 'none' }
  if (base.orgIds.length > 1) return { ...base, result: 'ambiguous' }
  const o = byOrg.get(base.orgIds[0])
  if (!o) return { ...base, result: 'unknown' }
  const org = { id: o.su10_org_id, name: o.name, kind: o.kind, inn: o.inn, state: o.state }
  if (o.state !== 'active') return { ...base, org, result: 'inactive' }
  if (o.kind === 'own') return { ...base, org, result: 'own' }
  const cpId = links.get(o.su10_org_id)
  const c = cpId ? cps.get(cpId) : null
  const counterparty = c ? { id: c.id, number: c.number, name: c.name, status: c.status, deleted: c.deleted } : null
  if (!counterparty || counterparty.deleted || counterparty.status === 'blacklist') return { ...base, org, counterparty, result: 'unmapped' }
  return { ...base, org, counterparty, result: 'counterparty' }
}
