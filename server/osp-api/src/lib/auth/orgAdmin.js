// «Администрирование» → «Организации СУ-10»: связь организации СУ-10 с контрагентом ОСП, создание контрагента из реестра,
// отвязка, исключения для сотрудников (src/routes/orgAdmin.js; решения пользователя 11.11.2026, план ред. 2).
//
// Каждое изменение — одной транзакцией от имени администратора: блокировка организации (как у входа и перепроверки,
// src/lib/auth/orgs.js), проверка, правка, событие в osp_auth.events, отзыв сессий СУ-10 затронутых учёток. Поэтому изменение
// действует сразу: подрядчик бывшей связи не дорабатывает до перепроверки, а вход, идущий параллельно, увидит новое состояние.
//
// Подсказки «какой это контрагент» — src/lib/orgMatch.js; это подсказки, решает администратор.
import { lockOrgsTx, isUuid, REGISTRY_META } from './orgs.js'
import { buildIndex, candidatesFor, confidentCandidate, searchCounterparties, namesAgree, nameKey, softInn } from '../orgMatch.js'
import { isValidInn, isPublicMailDomain } from '../../shared/contractorSignupRules.js'

export const ORG_ADMIN_ERRORS = {
  orgNotFound: { status: 404, code: 'org_not_found', message: 'Организации нет в реестре СУ-10 — обновите список' },
  orgInactive: { status: 409, code: 'org_inactive', message: 'Организация пропала из реестра СУ-10 или записана с ошибкой — связать нельзя' },
  orgOwn: { status: 409, code: 'org_own', message: 'Это своя организация СУ-10 — с контрагентом она не связывается' },
  orgLinked: { status: 409, code: 'org_linked', message: 'Организация уже связана с контрагентом — сначала отвяжите' },
  notLinked: { status: 404, code: 'org_not_linked', message: 'Организация не связана — обновите список' },
  cpNotFound: { status: 404, code: 'counterparty_not_found', message: 'Контрагент не найден или удалён' },
  cpBlacklisted: { status: 409, code: 'counterparty_blacklisted', message: 'Контрагент в чёрном списке — связать нельзя' },
  cpLinked: { status: 409, code: 'counterparty_linked', message: 'Контрагент уже связан с другой организацией СУ-10' },
  nameRequired: { status: 400, code: 'name_required', message: 'Укажите название контрагента' },
  innInvalid: { status: 400, code: 'inn_invalid', message: 'ИНН не прошёл проверку: 10 цифр у организации, 12 у ИП' },
  innTaken: { status: 409, code: 'inn_taken', message: 'Контрагент с таким ИНН уже есть — сопоставьте организацию с ним' },
  subjectUnknown: { status: 404, code: 'subject_unknown', message: 'Учётка СУ-10 не найдена среди заявок и связей' },
  orgAmbiguous: { status: 409, code: 'org_ambiguous', message: 'У учётки несколько организаций в СУ-10 — это ошибка данных СУ-10, исключение не поможет' },
  orgLookup: { status: 503, code: 'org_lookup_failed', message: 'СУ-10 не ответил — организация учётки не определена, повторите позже' },
  exceptionNotFound: { status: 404, code: 'exception_not_found', message: 'Исключения нет — обновите список' },
}
const fail = (key, extra = {}) => ({ ok: false, ...ORG_ADMIN_ERRORS[key], ...extra })
const rollbackWith = (result) => Object.assign(new Error('org admin: rollback'), { result })

export function createOrgAdmin({ db, orgs, issuer, sessions, userStatus = null, log = null, now = Date.now, cacheMs = 60_000 }) {
  let cpCache = null // { at, list } — живые контрагенты для подсказок

  const event = (tx, userId, kind, detail) =>
    tx.query('insert into osp_auth.events (user_id, kind, detail) values ($1, $2, $3)', [userId, kind, JSON.stringify(detail)])

  const run = async (actor, fn) => {
    try {
      return await db.write(actor, fn)
    } catch (err) {
      if (err?.result) return err.result
      if (err?.code === '23505') return fail('cpLinked')
      if (err?.code === '23503') return fail('cpNotFound')
      throw err
    }
  }

  // Учётки СУ-10 этой организации, связанные с пользователями портала, и подрядчики этих контрагентов — их сессии СУ-10
  // закрываются сразу. Внутри транзакции. → сколько учёток портала
  async function revokeAffectedTx(tx, orgId, counterpartyIds, reason) {
    await tx.mark('auth')
    const users = new Set((await tx.query(`select l.user_id from osp_auth.identity_links l
        join osp_auth.subject_orgs s on s.issuer = l.issuer and s.subject = l.subject
      where l.issuer = $1 and $2::uuid = any(s.org_ids)`, [issuer, orgId])).rows.map((r) => r.user_id))
    await tx.mark('internal')
    if (counterpartyIds.length) {
      for (const r of (await tx.query('select user_id from public.user_roles where counterparty_id = any($1::uuid[])', [counterpartyIds])).rows) users.add(r.user_id)
    }
    for (const u of users) {
      await sessions.revokeKeycloakInTx(tx, u, reason)
      userStatus?.forget?.(u)
    }
    return users.size
  }

  async function orgForUpdateTx(tx, orgId) {
    await tx.mark('auth')
    await lockOrgsTx(tx, issuer, [orgId])
    return (await tx.query('select su10_org_id, kind, name, inn, state from osp_auth.su10_orgs where issuer = $1 and su10_org_id = $2 for update',
      [issuer, orgId])).rows[0] || null
  }
  const orgProblem = (org) => (!org ? 'orgNotFound' : org.state !== 'active' ? 'orgInactive' : org.kind !== 'contractor' ? 'orgOwn' : null)

  // ── Список ───────────────────────────────────────────────────────────────────────────────────────────────────────
  async function list() {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const orgRows = (await tx.query(`select su10_org_id, kind, name, inn, state, invalid_reason, first_seen_at, seen_at, missing_since
        from osp_auth.su10_orgs where issuer = $1 order by name`, [issuer])).rows
      const links = new Map((await tx.query(`select su10_org_id, counterparty_id, source, match, linked_at from osp_auth.org_links
        where issuer = $1`, [issuer])).rows.map((r) => [r.su10_org_id, r]))
      const subjects = (await tx.query(`select subject, org_ids, in_group from osp_auth.subject_orgs
        where issuer = $1 and org_source is not null and cardinality(org_ids) = 1`, [issuer])).rows
      const pending = new Set((await tx.query(`select subject from osp_auth.identity_requests where issuer = $1 and status = 'pending'`, [issuer]))
        .rows.map((r) => String(r.subject).toLowerCase()))
      const idLinks = new Map((await tx.query('select subject, user_id from osp_auth.identity_links where issuer = $1', [issuer])).rows
        .map((r) => [String(r.subject).toLowerCase(), r.user_id]))
      const exceptions = (await tx.query(`select subject, su10_org_id, reason, created_by, created_at from osp_auth.org_exceptions
        where issuer = $1 order by created_at desc`, [issuer])).rows
      const metaRow = (await tx.query('select value from osp_auth.meta where key = $1', [REGISTRY_META])).rows[0]
      let registry = {}
      try { registry = JSON.parse(metaRow?.value || '{}') } catch { registry = {} }
      await tx.mark('internal')
      const cpIds = [...links.values()].map((l) => l.counterparty_id)
      const cps = new Map((await tx.query(`select c.id, (to_jsonb(c) ->> 'counterparty_number')::int as number, c.name, c.inn,
          c.status::text as status, c.deleted_at is not null as deleted from public.counterparties c where c.id = any($1::uuid[])`, [cpIds])).rows
        .map((r) => [r.id, r]))
      const roles = new Map((await tx.query('select user_id, role, counterparty_id, full_name from public.user_roles')).rows.map((r) => [r.user_id, r]))

      const byOrg = new Map()
      const bucket = (id) => {
        if (!byOrg.has(id)) byOrg.set(id, { accounts: 0, requests: 0, employees: [] })
        return byOrg.get(id)
      }
      const excBySubject = new Map(exceptions.map((e) => [String(e.subject).toLowerCase(), e]))
      for (const s of subjects) {
        const subject = String(s.subject).toLowerCase()
        const b = bucket(s.org_ids[0])
        if (s.in_group) b.accounts++
        if (pending.has(subject)) b.requests++
        const userId = idLinks.get(subject)
        const role = userId ? roles.get(userId) : null
        if (userId && !(role && (role.role === 'contractor' || role.counterparty_id))) {
          b.employees.push({ userId, subject, fullName: role?.full_name || null, exception: excBySubject.has(subject) })
        }
      }
      const contractorsOf = new Map()
      for (const r of roles.values()) if (r.counterparty_id) contractorsOf.set(r.counterparty_id, (contractorsOf.get(r.counterparty_id) || 0) + 1)

      const out = orgRows.map((o) => {
        const l = links.get(o.su10_org_id)
        const c = l ? cps.get(l.counterparty_id) : null
        const b = byOrg.get(o.su10_org_id) || { accounts: 0, requests: 0, employees: [] }
        const counterparty = l ? { id: l.counterparty_id, number: c?.number ?? null, name: c?.name ?? null, inn: c?.inn ?? null,
          status: c?.status ?? null, deleted: c ? c.deleted : true, source: l.source, match: l.match, linkedAt: l.linked_at } : null
        const usable = Boolean(counterparty && o.state === 'active' && o.kind === 'contractor' && !counterparty.deleted && counterparty.status !== 'blacklist')
        return {
          id: o.su10_org_id, kind: o.kind, name: o.name, inn: o.inn, state: o.state, invalidReason: o.invalid_reason,
          firstSeenAt: o.first_seen_at, seenAt: o.seen_at, missingSince: o.missing_since,
          counterparty, usable, accounts: b.accounts, requests: b.requests,
          // Сотрудники ОСП, чья учётка СУ-10 в этой организации: для «не своей» — без исключения не войдут.
          employees: o.kind === 'own' ? b.employees.length : b.employees,
          contractorsAffected: counterparty ? contractorsOf.get(counterparty.id) || 0 : 0,
        }
      })
      return {
        orgs: out,
        exceptions: exceptions.map((e) => ({ subject: String(e.subject).toLowerCase(), orgId: e.su10_org_id, reason: e.reason, createdAt: e.created_at,
          userId: idLinks.get(String(e.subject).toLowerCase()) || null, fullName: roles.get(idLinks.get(String(e.subject).toLowerCase()))?.full_name || null })),
        registry: { generation: registry.generation || 0, at: registry.at || null, lastAttemptAt: registry.lastAttemptAt || null,
          error: registry.error || null, held: Boolean(registry.held), heldReasons: registry.heldReasons || [], configured: orgs.configured() },
      }
    })
  }

  // ── Подсказки и поиск ─────────────────────────────────────────────────────────────────────────────────────────────
  async function counterpartiesTx(tx) {
    if (cpCache && now() - cpCache.at < cacheMs) return cpCache.list
    await tx.mark('internal')
    const { rows } = await tx.query(`
      with cp as (
        select c.id, c.name, c.inn, c.status::text as status, (to_jsonb(c) ->> 'counterparty_number')::int as number
        from public.counterparties c where c.deleted_at is null),
      ctr as (select x.cp, count(*)::int as n from (
        select counterparty_id as cp from public.contracts where counterparty_id is not null
        union all select counterparty_id from public.contract_counterparties) x group by x.cp),
      tnd as (select counterparty_id as cp, count(*)::int as n from public.tender_counterparties group by counterparty_id),
      rel as (select x.cp, count(*)::int as n from (
        select counterparty_id as cp from public.counterparty_relations
        union all select related_counterparty_id from public.counterparty_relations) x group by x.cp),
      dom as (select counterparty_id as cp, array_agg(distinct lower(btrim(split_part(email, '@', 2)))) as d
        from public.counterparty_contacts where email like '%_@_%.%' group by counterparty_id)
      select cp.*, coalesce(ctr.n, 0) as contracts, coalesce(tnd.n, 0) as tenders, coalesce(rel.n, 0) as relations, coalesce(dom.d, '{}') as domains
      from cp left join ctr on ctr.cp = cp.id left join tnd on tnd.cp = cp.id left join rel on rel.cp = cp.id left join dom on dom.cp = cp.id`)
    cpCache = { at: now(), list: rows }
    return rows
  }

  // Подсказки для организации (без q) или поиск по названию, ИНН, № (с q). Домены — почт известных учёток этой организации.
  async function candidates({ orgId, q = '' }) {
    if (!isUuid(orgId)) return fail('orgNotFound')
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const o = (await tx.query('select su10_org_id, kind, name, inn, state from osp_auth.su10_orgs where issuer = $1 and su10_org_id = $2', [issuer, orgId])).rows[0]
      if (!o) return fail('orgNotFound')
      const linkedTo = new Map((await tx.query('select counterparty_id, su10_org_id from osp_auth.org_links where issuer = $1', [issuer])).rows
        .map((r) => [r.counterparty_id, r.su10_org_id]))
      const subjects = (await tx.query(`select subject from osp_auth.subject_orgs where issuer = $1 and $2::uuid = any(org_ids)`, [issuer, orgId])).rows
        .map((r) => r.subject)
      const reqEmails = (await tx.query(`select email from osp_auth.identity_requests where issuer = $1 and subject = any($2::uuid[])`, [issuer, subjects])).rows
      const linkUsers = (await tx.query(`select user_id from osp_auth.identity_links where issuer = $1 and subject = any($2::uuid[])`, [issuer, subjects])).rows
      const list = await counterpartiesTx(tx)
      await tx.mark('internal')
      const userEmails = linkUsers.length
        ? (await tx.query('select email from auth.users where id = any($1::uuid[])', [linkUsers.map((r) => r.user_id)])).rows : []
      const domains = [...new Set([...reqEmails, ...userEmails].map((r) => String(r.email || '').toLowerCase().split('@')[1] || '')
        .filter((d) => d && !isPublicMailDomain(d)))]
      const view = (cp) => ({ id: cp.id, number: cp.number, name: cp.name, inn: cp.inn, status: cp.status })
      const org = { id: o.su10_org_id, kind: o.kind, name: o.name, inn: o.inn, state: o.state }
      const mark = (cand) => ({ ...cand, counterparty: view(cand.counterparty), linkedTo: linkedTo.get(cand.counterparty.id) || null })
      if (String(q).trim()) {
        return { org, candidates: searchCounterparties(list, q).map((cp) => mark({ counterparty: cp, reasons: [], flags: cp.status === 'blacklist' ? ['blacklist'] : [], confident: false })) }
      }
      const shaped = { su10OrgId: o.su10_org_id, kind: o.kind, name: o.name, inn: o.inn || '', emailDomains: domains, innHints: [] }
      const cands = candidatesFor(shaped, buildIndex(list))
      const confident = confidentCandidate(shaped, cands, new Set([...linkedTo.keys()].filter((id) => linkedTo.get(id) !== orgId)))
      return { org, domains, candidates: cands.map((c) => mark({ ...c, confident: confident?.counterparty.id === c.counterparty.id })) }
    })
  }

  // ── Связать, отвязать, создать контрагента ────────────────────────────────────────────────────────────────────────
  async function link({ actor, orgId, counterpartyId }) {
    if (!isUuid(orgId)) return fail('orgNotFound')
    if (!isUuid(counterpartyId)) return fail('cpNotFound')
    return run(actor, async (tx) => {
      const org = await orgForUpdateTx(tx, orgId)
      const problem = orgProblem(org)
      if (problem) return fail(problem)
      if ((await tx.query('select 1 from osp_auth.org_links where issuer = $1 and su10_org_id = $2', [issuer, orgId])).rows.length) return fail('orgLinked')
      await tx.mark('internal')
      const cp = (await tx.query('select id, status::text as status, deleted_at from public.counterparties where id = $1 for share', [counterpartyId])).rows[0]
      if (!cp || cp.deleted_at) return fail('cpNotFound')
      if (cp.status === 'blacklist') return fail('cpBlacklisted')
      await tx.mark('auth')
      const other = (await tx.query('select su10_org_id from osp_auth.org_links where issuer = $1 and counterparty_id = $2', [issuer, counterpartyId])).rows[0]
      if (other) return fail('cpLinked', { orgId: other.su10_org_id })
      await tx.query(`insert into osp_auth.org_links (issuer, su10_org_id, counterparty_id, source, match, linked_by)
        values ($1, $2, $3, 'admin', 'admin', $4)`, [issuer, orgId, counterpartyId, actor.userId])
      const revoked = await revokeAffectedTx(tx, orgId, [counterpartyId], 'org_link_changed')
      await tx.mark('auth')
      await event(tx, null, 'org.link', { org: orgId, counterparty: counterpartyId, source: 'admin', by: actor.userId, revoked })
      return { ok: true, revoked }
    })
  }

  async function unlink({ actor, orgId }) {
    if (!isUuid(orgId)) return fail('orgNotFound')
    return run(actor, async (tx) => {
      await tx.mark('auth')
      await lockOrgsTx(tx, issuer, [orgId])
      const r = await tx.query('delete from osp_auth.org_links where issuer = $1 and su10_org_id = $2 returning counterparty_id', [issuer, orgId])
      if (!r.rows.length) return fail('notLinked')
      const counterpartyId = r.rows[0].counterparty_id
      const revoked = await revokeAffectedTx(tx, orgId, [counterpartyId], 'org_unlinked')
      await tx.mark('auth')
      await event(tx, null, 'org.unlink', { org: orgId, counterparty: counterpartyId, by: actor.userId, revoked })
      return { ok: true, revoked }
    })
  }

  async function createCounterparty({ actor, orgId, name = null, inn = null }) {
    if (!isUuid(orgId)) return fail('orgNotFound')
    const innDigits = inn == null ? null : String(inn).replace(/\s+/g, '')
    if (innDigits && !isValidInn(innDigits)) return fail('innInvalid')
    const result = await run(actor, async (tx) => {
      const org = await orgForUpdateTx(tx, orgId)
      const problem = orgProblem(org)
      if (problem) return fail(problem)
      if ((await tx.query('select 1 from osp_auth.org_links where issuer = $1 and su10_org_id = $2', [issuer, orgId])).rows.length) return fail('orgLinked')
      const finalName = String(name ?? org.name ?? '').trim().slice(0, 255)
      if (!finalName) return fail('nameRequired')
      const finalInn = innDigits === null ? (org.inn && isValidInn(org.inn) ? org.inn : null) : (innDigits || null)
      await tx.mark('internal')
      if (finalInn) {
        const same = (await tx.query(`select c.id, (to_jsonb(c) ->> 'counterparty_number')::int as number, c.inn from public.counterparties c
          where c.deleted_at is null and c.inn like '%' || ltrim($1, '0') || '%'`, [finalInn])).rows.filter((c) => softInn(c.inn, finalInn))
        if (same.length) return fail('innTaken', { counterpartyId: same[0].id, number: same[0].number })
      }
      const cp = (await tx.query(`insert into public.counterparties (name, inn, status) values ($1, $2, 'active')
        returning id, (to_jsonb(counterparties) ->> 'counterparty_number')::int as number, name`, [finalName, finalInn])).rows[0]
      const { rows: t } = await tx.query("select to_regclass('public.counterparty_audit_log') is not null as ok")
      if (t[0].ok) {
        await tx.query(`insert into public.counterparty_audit_log (counterparty_id, event_type, description, changed_by_role, changed_by_name)
          values ($1, 'created', $2, 'admin', $3)`, [cp.id, 'Создан из реестра организаций СУ-10 и связан с организацией', actor.email || 'Администратор'])
      }
      await tx.mark('auth')
      await tx.query(`insert into osp_auth.org_links (issuer, su10_org_id, counterparty_id, source, match, linked_by)
        values ($1, $2, $3, 'admin', 'admin', $4)`, [issuer, orgId, cp.id, actor.userId])
      const revoked = await revokeAffectedTx(tx, orgId, [], 'org_link_changed')
      await tx.mark('auth')
      await event(tx, null, 'org.link', { org: orgId, counterparty: cp.id, source: 'admin', created: true, by: actor.userId, revoked })
      return { ok: true, counterparty: { id: cp.id, number: cp.number, name: cp.name }, revoked }
    })
    if (result.ok) cpCache = null
    return result
  }

  // ── Карточка контрагента ──────────────────────────────────────────────────────────────────────────────────────────
  // Связанная организация и (для «Связать…») действующие организации-подрядчики без связи: похожие — первыми.
  async function ofCounterparty({ counterpartyId }) {
    if (!isUuid(counterpartyId)) return fail('cpNotFound')
    return db.read(null, async (tx) => {
      await tx.mark('internal')
      const cp = (await tx.query('select id, name, inn, status::text as status, deleted_at from public.counterparties where id = $1', [counterpartyId])).rows[0]
      if (!cp) return fail('cpNotFound')
      await tx.mark('auth')
      const link = (await tx.query(`select l.su10_org_id, l.source, l.linked_at, o.name, o.inn, o.kind, o.state from osp_auth.org_links l
          join osp_auth.su10_orgs o on o.issuer = l.issuer and o.su10_org_id = l.su10_org_id
        where l.issuer = $1 and l.counterparty_id = $2`, [issuer, counterpartyId])).rows[0]
      const free = (await tx.query(`select o.su10_org_id, o.name, o.inn from osp_auth.su10_orgs o
        where o.issuer = $1 and o.state = 'active' and o.kind = 'contractor'
          and not exists (select 1 from osp_auth.org_links l where l.issuer = o.issuer and l.su10_org_id = o.su10_org_id)
        order by o.name`, [issuer])).rows
      const scored = free.map((o) => {
        const reasons = []
        if (o.inn && cp.inn && softInn(cp.inn, o.inn)) reasons.push('inn')
        if (nameKey(o.name) && nameKey(o.name) === nameKey(cp.name)) reasons.push('name')
        else if (namesAgree(o.name, cp.name)) reasons.push('name_similar')
        return { id: o.su10_org_id, name: o.name, inn: o.inn, reasons, score: (reasons.includes('inn') ? 100 : 0) + (reasons.includes('name') ? 40 : 0) + (reasons.includes('name_similar') ? 10 : 0) }
      }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'))
      return {
        counterparty: { id: cp.id, name: cp.name, inn: cp.inn, status: cp.status, deleted: Boolean(cp.deleted_at) },
        link: link ? { orgId: link.su10_org_id, name: link.name, inn: link.inn, kind: link.kind, state: link.state, source: link.source, linkedAt: link.linked_at } : null,
        orgs: scored,
      }
    })
  }

  // ── Исключения (только суперадминистратор — проверяет маршрут) ─────────────────────────────────────────────────────
  // Учётка — из заявок и связей; организация — текущая известная (не известна — спросить Admin API).
  async function addException({ actor, subject, reason }) {
    const sub = String(subject || '').toLowerCase()
    if (!isUuid(sub)) return fail('subjectUnknown')
    const known = await db.read(null, async (tx) => {
      await tx.mark('auth')
      const inLinks = (await tx.query('select 1 from osp_auth.identity_links where issuer = $1 and subject = $2', [issuer, sub])).rows.length > 0
      const inReq = (await tx.query('select 1 from osp_auth.identity_requests where issuer = $1 and subject = $2', [issuer, sub])).rows.length > 0
      const org = (await tx.query('select org_ids, org_source from osp_auth.subject_orgs where issuer = $1 and subject = $2', [issuer, sub])).rows[0]
      return { exists: inLinks || inReq, org }
    })
    if (!known.exists) return fail('subjectUnknown')
    let orgIds = known.org?.org_source ? known.org.org_ids : null
    if (!orgIds) {
      const fresh = await orgs.subjectOrgs(sub)
      if (!fresh) return fail('orgLookup')
      orgIds = fresh.orgIds
    }
    if (orgIds.length > 1) return fail('orgAmbiguous')
    const orgId = orgIds[0] || null
    return run(actor, async (tx) => {
      await tx.mark('auth')
      await tx.query(`insert into osp_auth.org_exceptions (issuer, subject, su10_org_id, reason, created_by) values ($1, $2, $3, $4, $5)
        on conflict (issuer, subject) do update set su10_org_id = excluded.su10_org_id, reason = excluded.reason,
          created_by = excluded.created_by, created_at = now()`, [issuer, sub, orgId, String(reason).trim(), actor.userId])
      await event(tx, null, 'org.exception.add', { subject: sub, org: orgId, by: actor.userId })
      return { ok: true, orgId }
    })
  }

  async function removeException({ actor, subject }) {
    const sub = String(subject || '').toLowerCase()
    if (!isUuid(sub)) return fail('exceptionNotFound')
    return run(actor, async (tx) => {
      await tx.mark('auth')
      const r = await tx.query('delete from osp_auth.org_exceptions where issuer = $1 and subject = $2 returning su10_org_id', [issuer, sub])
      if (!r.rows.length) return fail('exceptionNotFound')
      const user = (await tx.query('select user_id from osp_auth.identity_links where issuer = $1 and subject = $2', [issuer, sub])).rows[0]
      let revoked = 0
      if (user) {
        await tx.mark('internal')
        revoked = await sessions.revokeKeycloakInTx(tx, user.user_id, 'org_exception_removed')
        userStatus?.forget?.(user.user_id)
      }
      await tx.mark('auth')
      await event(tx, null, 'org.exception.remove', { subject: sub, by: actor.userId, revoked })
      return { ok: true, revoked }
    })
  }

  return { list, candidates, link, unlink, createCounterparty, ofCounterparty, addException, removeException, rollbackWith, log }
}
