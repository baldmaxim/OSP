// Связь учёток портала с учётками СУ-10 и заявки администратору ОСП (вход через Keycloak, migration/yandex/20270112).
//
//   • Учётка портала (auth.users.id) не меняется никогда: связь — отдельная строка osp_auth.identity_links (issuer, sub) →
//     user_id. Документы, записи и история остаются у человека.
//   • Вход: связь по sub → пользователь; иначе, только в окно переключения (OIDC_LINK_BY_EMAIL=true), — по почте: ровно
//     одна одобренная незаблокированная учётка без связи, не администратор и не суперадминистратор; иначе — заявка.
//     Пользователей сами не создаём: у людей, которые есть в ОСП под другой почтой, появились бы дубли.
//   • Решения по заявкам — администратор ОСП. Роль «Администратор», связь с учёткой администратора и её снятие — только
//     суперадминистратор (решение пользователя 10.11.2026; в базе — триггер user_roles_admin_guard: транзакции здесь идут
//     от имени администратора, триггер видит его).
//   • osp_auth читается и пишется только с отметкой 'auth', учётки — с 'internal' (как пароли, src/lib/auth/service.js).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const IDENTITY_ERRORS = {
  notFound: { status: 404, code: 'request_not_found', message: 'Заявка не найдена' },
  decided: { status: 409, code: 'request_decided', message: 'Заявку уже разобрали — обновите список' },
  userNotFound: { status: 404, code: 'user_not_found', message: 'Пользователь не найден' },
  userLinked: { status: 409, code: 'user_linked', message: 'Этот пользователь уже связан с другой учёткой СУ-10' },
  subjectLinked: { status: 409, code: 'subject_linked', message: 'Эта учётка СУ-10 уже связана с пользователем портала' },
  emailTaken: { status: 409, code: 'email_taken', message: 'Учётная запись с такой почтой уже есть — привяжите заявку к существующему пользователю' },
  superadminOnly: { status: 403, code: 'superadmin_only', message: 'Роль «Администратор» и связи администраторов — только у суперадминистратора' },
  counterpartyRequired: { status: 400, code: 'counterparty_required', message: 'Для подрядчика нужна организация' },
  roleUnknown: { status: 400, code: 'role_unknown', message: 'Такой роли нет' },
  referenceUnknown: { status: 400, code: 'reference_unknown', message: 'Организация или объект не найдены' },
  notLinked: { status: 404, code: 'not_linked', message: 'Пользователь не связан с СУ-10' },
  orgUnmapped: { status: 409, code: 'org_unmapped', message: 'Сначала сопоставьте организацию СУ-10 этого человека с контрагентом' },
  orgNotOwn: { status: 409, code: 'org_not_own', message: 'Учётка СУ-10 не в своей организации: сотрудник не войдёт без исключения суперадминистратора' },
  orgLookup: { status: 503, code: 'org_lookup_failed', message: 'СУ-10 не ответил — организация учётки не определена, повторите позже' },
}
const fail = (key, extra = {}) => ({ ok: false, ...IDENTITY_ERRORS[key], ...extra })

export const normEmail = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, 254) : null)
const normName = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е') : '')
const localPart = (email) => (email && email.includes('@') ? email.slice(0, email.indexOf('@')) : '')

export function createIdentity({ db, issuer, linkByEmail = false, sessions, createUserTx, isSuperadmin, orgs = null, log = null }) {
  const event = (tx, userId, kind, detail = {}) =>
    tx.query('insert into osp_auth.events (user_id, kind, detail) values ($1, $2, $3)', [userId, kind, JSON.stringify(detail)])

  async function isAdminOrSuperTx(tx, userId) {
    const role = (await tx.query('select role, is_approved from public.user_roles where user_id = $1', [userId])).rows[0]
    if (role?.role === 'admin') return true
    const { rows } = await tx.query("select to_regclass('public.superadmins') is not null as ok")
    if (!rows[0].ok) return false
    return (await tx.query('select 1 from public.superadmins where user_id = $1', [userId])).rows.length > 0
  }

  // Привязка по почте (окно переключения): ровно одна одобренная незаблокированная учётка без связи с этим issuer,
  // не администратор и не суперадминистратор. Внутри транзакции вызывающего. → { userId } | { conflict } | null
  async function linkByEmailTx(tx, { subject, email, via }) {
    if (!linkByEmail || !email) return null
    await tx.mark('internal')
    const { rows } = await tx.query(`select u.id, r.role from auth.users u join public.user_roles r on r.user_id = u.id
      where osp_private.email_norm(u.email) = osp_private.email_norm($1) and r.is_approved = true and r.is_blocked is not true`, [email])
    if (rows.length !== 1) return null
    const candidate = rows[0].id
    if (await isAdminOrSuperTx(tx, candidate)) return null
    await tx.mark('auth')
    const linked = (await tx.query('select subject from osp_auth.identity_links where issuer = $1 and user_id = $2', [issuer, candidate])).rows[0]
    if (linked) {
      await event(tx, candidate, 'sso.link_conflict', { via })
      return { conflict: true }
    }
    await tx.query(`insert into osp_auth.identity_links (issuer, subject, user_id, source) values ($1, $2, $3, 'email')`, [issuer, subject, candidate])
    await event(tx, candidate, 'sso.link', { via, source: 'email' })
    return { userId: candidate }
  }

  // Заявка от входа: создать или освежить. Отклонённая остаётся отклонённой; «связанная», чья связь снята, — снова ждёт.
  async function upsertLoginRequestTx(tx, { subject, email, fullName }) {
    await tx.mark('auth')
    const { rows } = await tx.query(`insert into osp_auth.identity_requests as q (issuer, subject, email, full_name, origin, first_seen_at, last_seen_at)
        values ($1, $2, $3, $4, 'login', now(), now())
      on conflict (issuer, subject) do update set
        email = case when q.status = 'rejected' then q.email else excluded.email end,
        full_name = case when q.status = 'rejected' then q.full_name else coalesce(excluded.full_name, q.full_name) end,
        status = case when q.status = 'linked' then 'pending' else q.status end,
        decided_by = case when q.status = 'linked' then null else q.decided_by end,
        decided_at = case when q.status = 'linked' then null else q.decided_at end,
        linked_user_id = case when q.status = 'linked' then null else q.linked_user_id end,
        first_seen_at = coalesce(q.first_seen_at, now()), last_seen_at = now()
      returning id, status, (xmax = 0) as inserted`, [issuer, subject, email, fullName])
    const r = rows[0]
    if (r.inserted) await event(tx, null, 'sso.request.create', { origin: 'login' })
    return r
  }

  // Вход: кто это. Внутри транзакции вызывающего (создание сессии — там же). → { kind: 'user', userId } | { kind: 'requested' | 'rejected' }
  async function resolveLoginTx(tx, { subject, email, fullName }) {
    await tx.mark('auth')
    const link = (await tx.query('select user_id from osp_auth.identity_links where issuer = $1 and subject = $2', [issuer, subject])).rows[0]
    if (link) {
      await tx.query('update osp_auth.identity_links set last_login_at = now() where issuer = $1 and subject = $2', [issuer, subject])
      return { kind: 'user', userId: link.user_id }
    }
    const byEmail = await linkByEmailTx(tx, { subject, email, via: 'login' })
    if (byEmail?.userId) {
      await tx.mark('auth')
      await tx.query('update osp_auth.identity_links set last_login_at = now() where issuer = $1 and subject = $2', [issuer, subject])
      return { kind: 'user', userId: byEmail.userId }
    }
    const r = await upsertLoginRequestTx(tx, { subject, email, fullName })
    return { kind: r.status === 'rejected' ? 'rejected' : 'requested' }
  }

  // Учётка действует: одобрена и не заблокирована в портале или это суперадминистратор (как у парольного входа).
  // Внутри транзакции вызывающего. → true | false
  async function accountActiveTx(tx, userId) {
    await tx.mark('internal')
    const row = (await tx.query('select is_approved, is_blocked from public.user_roles where user_id = $1', [userId])).rows[0]
    if (row && row.is_approved === true && row.is_blocked !== true) return true
    const { rows } = await tx.query("select to_regclass('public.superadmins') is not null as ok")
    if (!rows[0].ok) return false
    return (await tx.query('select 1 from public.superadmins where user_id = $1', [userId])).rows.length > 0
  }

  // Вход через СУ-10 целиком — одной транзакцией: кто это, действует ли учётка, организация (src/lib/auth/orgs.js), новая
  // сессия, отметки входа, событие. keycloak — { subject, sid, refreshToken, idToken }; orgIds — claim su10_org_id.
  // → { kind: 'user', userId, session } | { kind: 'requested' | 'rejected' | 'disabled' } | { kind: 'org_denied', error }
  async function completeLogin({ subject, email, fullName, keycloak, orgIds = [] }) {
    if (orgs) await orgs.ensureKnown(orgIds)
    return db.write(null, async (tx) => {
      const who = await resolveLoginTx(tx, { subject, email, fullName })
      if (who.kind !== 'user') {
        if (orgs) await orgs.recordTx(tx, subject, orgIds)
        return who
      }
      if (!(await accountActiveTx(tx, who.userId))) {
        await tx.mark('auth')
        await event(tx, who.userId, 'login_refused', { reason: 'disabled', via: 'sso' })
        return { kind: 'disabled' }
      }
      // Организация — до выпуска сессии и той же транзакцией: при смене контрагента новая сессия уже с ним, при отказе
      // сессии нет, а прежние закрыты.
      if (orgs) {
        const org = await orgs.applyTx(tx, { userId: who.userId, subject, orgIds, via: 'login' })
        if (!org.ok) return { kind: 'org_denied', error: org.error }
      }
      await tx.mark('internal')
      const session = await sessions.createInTx(tx, { userId: who.userId, keycloak: { issuer, subject, ...keycloak } })
      await tx.query('update auth.users set last_sign_in_at = now() where id = $1', [who.userId])
      await tx.query('update public.user_roles set last_login_at = now() where user_id = $1', [who.userId])
      await tx.mark('auth')
      await event(tx, who.userId, 'sso.login', {})
      return { kind: 'user', userId: who.userId, session }
    })
  }

  // Учётки портала для подсказок и колонки «СУ-10» — одним чтением.
  async function readUsersTx(tx) {
    await tx.mark('internal')
    const { rows: users } = await tx.query(`select u.id, u.email, u.last_sign_in_at, r.full_name, r.role, r.is_approved, r.is_blocked, r.last_login_at
      from auth.users u left join public.user_roles r on r.user_id = u.id`)
    const { rows: sa } = await tx.query("select to_regclass('public.superadmins') is not null as ok")
    const supers = sa[0].ok ? new Set((await tx.query('select user_id from public.superadmins')).rows.map((r) => r.user_id)) : new Set()
    return { users, supers }
  }

  // Заявки со списком похожих учёток без связи: та же почта, то же ФИО, та же часть почты до «@».
  async function listRequests({ status = 'pending' } = {}) {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const { rows: requests } = await tx.query(`select id, subject, email, full_name, status, origin, created_at, first_seen_at, last_seen_at, decided_at
        from osp_auth.identity_requests where issuer = $1 and status = $2 order by created_at desc limit 500`, [issuer, status])
      const linked = new Set((await tx.query('select user_id from osp_auth.identity_links where issuer = $1', [issuer])).rows.map((r) => r.user_id))
      const pendingCount = (await tx.query(`select count(*)::int as n from osp_auth.identity_requests where issuer = $1 and status = 'pending'`, [issuer])).rows[0].n
      const orgsOn = Boolean(orgs) && await orgs.enabled()
      const orgOf = orgsOn ? await orgs.describeSubjectsTx(tx, requests.map((q) => q.subject)) : new Map()
      const { users, supers } = await readUsersTx(tx)
      const free = users.filter((u) => !linked.has(u.id))
      const out = requests.map((q) => {
        const email = normEmail(q.email)
        const name = normName(q.full_name)
        const local = localPart(email)
        const similar = []
        for (const u of free) {
          const uEmail = normEmail(u.email)
          const why = []
          if (email && uEmail === email) why.push('email')
          if (name && normName(u.full_name) === name) why.push('name')
          if (local && local.length >= 3 && localPart(uEmail) === local && uEmail !== email) why.push('email_local')
          if (why.length) {
            similar.push({
              userId: u.id, email: u.email || '', fullName: u.full_name || '', role: u.role || null,
              isAdmin: u.role === 'admin' || supers.has(u.id), lastLoginAt: u.last_login_at || u.last_sign_in_at || null,
              approved: u.is_approved === true, blocked: u.is_blocked === true, match: why,
            })
          }
        }
        similar.sort((a, b) => b.match.length - a.match.length)
        return {
          id: q.id, subject: String(q.subject).toLowerCase(), email: q.email, fullName: q.full_name, status: q.status, origin: q.origin,
          createdAt: q.created_at, firstSeenAt: q.first_seen_at, lastSeenAt: q.last_seen_at, decidedAt: q.decided_at,
          similar: similar.slice(0, 5), ...(orgsOn ? { org: orgOf.get(String(q.subject).toLowerCase()) || null } : {}),
        }
      })
      return { requests: out, pending: pendingCount, orgsEnabled: orgsOn }
    })
  }

  // Связи всех пользователей — для колонки «СУ-10» в «Пользователях».
  async function listLinks() {
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const { rows } = await tx.query(`select user_id, source, linked_at, last_login_at from osp_auth.identity_links where issuer = $1`, [issuer])
      return rows.map((r) => ({ userId: r.user_id, source: r.source, linkedAt: r.linked_at, lastLoginAt: r.last_login_at }))
    })
  }

  // Заявка под замком, только «ждёт». → строка | ответ-ошибка
  async function pendingRequestTx(tx, requestId) {
    if (!UUID.test(String(requestId))) return fail('notFound')
    await tx.mark('auth')
    const q = (await tx.query('select * from osp_auth.identity_requests where id = $1 and issuer = $2 for update', [requestId, issuer])).rows[0]
    if (!q) return fail('notFound')
    if (q.status !== 'pending') return fail('decided')
    return q
  }

  async function decideTx(tx, { q, actor, userId, action }) {
    await tx.mark('auth')
    await tx.query(`update osp_auth.identity_requests set status = 'linked', decided_by = $2, decided_at = now(), linked_user_id = $3
      where id = $1`, [q.id, actor.userId, userId])
    await event(tx, userId, 'sso.request.decide', { action, by: actor.userId })
  }

  async function insertLinkTx(tx, { subject, userId, source, actor }) {
    await tx.mark('auth')
    const bySubject = (await tx.query('select user_id from osp_auth.identity_links where issuer = $1 and subject = $2', [issuer, subject])).rows[0]
    if (bySubject) return fail('subjectLinked')
    const byUser = (await tx.query('select subject from osp_auth.identity_links where issuer = $1 and user_id = $2', [issuer, userId])).rows[0]
    if (byUser) return fail('userLinked')
    await tx.query(`insert into osp_auth.identity_links (issuer, subject, user_id, source, linked_by) values ($1, $2, $3, $4, $5)`,
      [issuer, subject, userId, source, actor.userId])
    await event(tx, userId, 'sso.link', { source, by: actor.userId })
    return null
  }

  const mapDbError = (err) => {
    if (err?.code === '42501') return fail('superadminOnly')
    if (err?.code === '23505') return /email/i.test(String(err.constraint || err.detail || '')) ? fail('emailTaken') : fail('subjectLinked')
    if (err?.code === '23503') return fail('referenceUnknown')
    return null
  }
  const run = async (actor, fn) => {
    try {
      // От имени администратора: триггер базы (роль «Администратор») видит, кто действует.
      return await db.write(actor, fn)
    } catch (err) {
      const known = mapDbError(err)
      if (known) return known
      throw err
    }
  }
  const rollbackWith = (result) => Object.assign(new Error('identity: rollback'), { result })
  const unwrap = async (actor, fn) => {
    try {
      return await run(actor, fn)
    } catch (err) {
      if (err?.result) return err.result
      throw err
    }
  }

  // Учётка СУ-10 заявки (для организации — до транзакции решения). → subject | null
  async function requestSubject(requestId) {
    if (!UUID.test(String(requestId))) return null
    return db.read(null, async (tx) => {
      await tx.mark('auth')
      const row = (await tx.query('select subject from osp_auth.identity_requests where id = $1 and issuer = $2', [requestId, issuer])).rows[0]
      return row ? String(row.subject).toLowerCase() : null
    })
  }

  // «Создать пользователя» по заявке: учётка, роль, связь, заявка — одной транзакцией. Пароля нет: вход — через СУ-10.
  // Организация СУ-10 (src/lib/auth/orgs.js): подрядчику контрагент — только из связи организации (то, что прислала форма,
  // не берётся); сотруднику — только своя организация или исключение суперадминистратора (иначе он всё равно не войдёт).
  async function createUser({ actor, requestId, role, objectIds = [], counterpartyId = null, fullName = null }) {
    if (role === 'admin' && !(await isSuperadmin(actor.userId))) return fail('superadminOnly')
    let subjectOrg = null
    if (orgs && await orgs.enabled()) {
      const subject = await requestSubject(requestId)
      if (subject) {
        subjectOrg = await orgs.subjectOrgs(subject)
        if (!subjectOrg) return fail('orgLookup')
      }
    }
    return unwrap(actor, async (tx) => {
      const q = await pendingRequestTx(tx, requestId)
      if (q.ok === false) return q
      let cpId = counterpartyId
      let fromOrg = false
      if (subjectOrg) {
        const r = await orgs.resolveTx(tx, subjectOrg.orgIds)
        if (role === 'contractor') {
          if (r.result !== 'counterparty') return fail('orgUnmapped', { orgId: r.orgId || null, result: r.result })
          cpId = r.counterpartyId
          fromOrg = true
        } else {
          cpId = null
          if (r.result !== 'own') {
            await tx.mark('auth')
            const exc = r.result === 'ambiguous' ? null
              : (await tx.query('select su10_org_id from osp_auth.org_exceptions where issuer = $1 and subject = $2', [issuer, q.subject])).rows[0]
            if (!exc || (exc.su10_org_id || null) !== (r.orgId || null)) return fail('orgNotOwn', { orgId: r.orgId || null, result: r.result })
          }
        }
      }
      const email = normEmail(q.email)
      if (!email) throw rollbackWith({ ok: false, status: 400, code: 'email_missing', message: 'В заявке нет почты — привяжите её к существующему пользователю' })
      await tx.mark('internal')
      const taken = (await tx.query('select id from auth.users where osp_private.email_norm(email) = osp_private.email_norm($1)', [email])).rows[0]
      if (taken) return fail('emailTaken', { userId: taken.id })
      const created = await createUserTx(tx, { email, fullName: (fullName || q.full_name || '').trim() || null, role, counterpartyId: cpId, objectIds })
      if (created.ok === false) throw rollbackWith(created)
      if (fromOrg) {
        await tx.mark('internal')
        await tx.query(`update public.user_roles set counterparty_source = 'su10' where user_id = $1`, [created.user.id])
      }
      const problem = await insertLinkTx(tx, { subject: q.subject, userId: created.user.id, source: 'request', actor })
      if (problem) throw rollbackWith(problem)
      await decideTx(tx, { q, actor, userId: created.user.id, action: 'create' })
      return { ok: true, user: created.user }
    })
  }

  // «Привязать к существующему»: учётка есть и не связана; к администратору — только суперадминистратор.
  async function link({ actor, requestId, userId }) {
    if (!UUID.test(String(userId))) return fail('userNotFound')
    return unwrap(actor, async (tx) => {
      const q = await pendingRequestTx(tx, requestId)
      if (q.ok === false) return q
      await tx.mark('internal')
      const exists = (await tx.query('select 1 from auth.users where id = $1', [userId])).rows.length > 0
      if (!exists) return fail('userNotFound')
      if (await isAdminOrSuperTx(tx, userId) && !(await isSuperadmin(actor.userId))) return fail('superadminOnly')
      const problem = await insertLinkTx(tx, { subject: q.subject, userId, source: 'request', actor })
      if (problem) return problem
      await decideTx(tx, { q, actor, userId, action: 'link' })
      return { ok: true }
    })
  }

  async function reject({ actor, requestId }) {
    return unwrap(actor, async (tx) => {
      const q = await pendingRequestTx(tx, requestId)
      if (q.ok === false) return q
      await tx.query(`update osp_auth.identity_requests set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [q.id, actor.userId])
      await event(tx, null, 'sso.request.decide', { action: 'reject', by: actor.userId })
      return { ok: true }
    })
  }

  async function reopen({ actor, requestId }) {
    if (!UUID.test(String(requestId))) return fail('notFound')
    return unwrap(actor, async (tx) => {
      await tx.mark('auth')
      const r = await tx.query(`update osp_auth.identity_requests set status = 'pending', decided_by = null, decided_at = null, linked_user_id = null
        where id = $1 and issuer = $2 and status = 'rejected' returning id`, [requestId, issuer])
      if (!r.rows.length) return fail('decided')
      await event(tx, null, 'sso.request.decide', { action: 'reopen', by: actor.userId })
      return { ok: true }
    })
  }

  // Отвязать: связь снята, сессии СУ-10 отозваны сразу. Следующий вход — снова заявка.
  async function unlink({ actor, userId }) {
    if (!UUID.test(String(userId))) return fail('userNotFound')
    return unwrap(actor, async (tx) => {
      await tx.mark('internal')
      if (await isAdminOrSuperTx(tx, userId) && !(await isSuperadmin(actor.userId))) return fail('superadminOnly')
      await tx.mark('auth')
      const r = await tx.query('delete from osp_auth.identity_links where issuer = $1 and user_id = $2 returning subject', [issuer, userId])
      if (!r.rows.length) return fail('notLinked')
      await event(tx, userId, 'sso.unlink', { by: actor.userId })
      await tx.mark('internal')
      const revoked = await sessions.revokeKeycloakInTx(tx, userId, 'sso_unlinked')
      return { ok: true, revoked }
    })
  }

  return { completeLogin, resolveLoginTx, linkByEmailTx, accountActiveTx, listRequests, listLinks, createUser, link, reject, reopen, unlink, issuer, log }
}
