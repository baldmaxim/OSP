// Сверка группы доступа СУ-10 (osp-access) с заявками и связями портала — так заявка появляется у администратора ОСП
// сразу после выдачи доступа на auth.su10.ru/manage, а отзыв доступа закрывает сессии и у тех, кто сейчас ничего не делает.
// Работает только в режиме keycloak и только при настроенном служебном клиенте (KC_ADMIN_*).
//
// По каждому включённому участнику: связь есть — ничего; окно переключения (OIDC_LINK_BY_EMAIL) — привязка по почте, как при
// входе; заявка «ждёт» — освежить почту и ФИО; отклонённую и разобранную — не трогать; заявки нет — создать (origin kc_sync).
// После полного успешного чтения группы, и только тогда:
//   • чистка — заявки kc_sync без входов, чьих участников больше нет в группе (выдали и сразу отозвали). Заявки от входа и
//     заявки с входами не удаляются никогда;
//   • быстрый отзыв — сессии СУ-10 связанных пользователей не из группы (связь остаётся: вернут доступ — войдут).
//
// Предохранитель: ошибка или сбой на стороне СУ-10 не должны массово выгнать людей и стереть заявки. Ни отзыва, ни чистки
// (новые заявки и обновление почты — можно), если: отзыв больше max(10, 20 % связанных); чистка больше max(10, 20 % заявок
// kc_sync); участников стало меньше на 30 % и больше против прошлой успешной сверки (от 10 участников); пришла пустая группа
// после непустой. Принять новое состояние — scripts/deploy-server.sh identity sync --force.
//
// Одна сверка на все экземпляры службы — аренда в osp_auth.meta (пулер базы в режиме транзакций: блокировка на подключение
// здесь не держится). Группа читается вне транзакции, запись — одной короткой транзакцией.
import { randomUUID } from 'node:crypto'
import { normEmail } from './identity.js'
import { fullNameOf } from './oidc.js'

export const SYNC_DEFAULTS = { throttleMs: 15_000, leaseMs: 120_000, startDelayMs: 5_000 }
const LEASE_KEY = 'kc_sync_lease'
const STATE_KEY = 'kc_sync_state'

export function breakerReasons({ prevMembers, members, links, revoke, kcSyncRequests, withdraw }) {
  const reasons = []
  if (prevMembers > 0 && members === 0) reasons.push('empty')
  if (prevMembers >= 10 && members < prevMembers * 0.7) reasons.push('drop')
  if (revoke > Math.max(10, links * 0.2)) reasons.push('revoke')
  if (withdraw > Math.max(10, kcSyncRequests * 0.2)) reasons.push('withdraw')
  return reasons
}

export function createAccessSync({ db, kcAdmin, identity, sessions, issuer, linkByEmail = false, orgs = null, log = null, now = Date.now,
  owner = randomUUID(), options = {} }) {
  const o = { ...SYNC_DEFAULTS, ...options }
  let running = null
  let last = null // { at, result }

  const event = (tx, kind, detail) => tx.query('insert into osp_auth.events (user_id, kind, detail) values (null, $1, $2)', [kind, JSON.stringify(detail)])

  // Срок аренды — по часам базы (экземпляры службы сравнивают его с now() той же базы).
  async function takeLease() {
    return db.write(null, async (tx) => {
      await tx.mark('auth')
      const r = await tx.query(`insert into osp_auth.meta (key, value, updated_at)
          values ($1, json_build_object('owner', $2::text, 'until', now() + make_interval(secs => $3))::text, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()
          where (osp_auth.meta.value::jsonb ->> 'until')::timestamptz < now() or osp_auth.meta.value::jsonb ->> 'owner' = $2
        returning key`, [LEASE_KEY, owner, o.leaseMs / 1000])
      return r.rows.length > 0
    })
  }

  const releaseLease = () => db.write(null, async (tx) => {
    await tx.mark('auth')
    await tx.query(`delete from osp_auth.meta where key = $1 and value::jsonb ->> 'owner' = $2`, [LEASE_KEY, owner])
  }).catch((err) => log?.warn({ code: err?.code }, 'kc sync lease release'))

  async function apply(members, force) {
    const enabled = members.filter((m) => m.enabled)
    const enabledIds = new Set(enabled.map((m) => m.id))
    return db.write(null, async (tx) => {
      await tx.mark('auth')
      const links = new Map((await tx.query('select subject, user_id from osp_auth.identity_links where issuer = $1', [issuer])).rows
        .map((r) => [String(r.subject).toLowerCase(), r.user_id]))
      const requests = new Map((await tx.query(`select id, subject, status, origin, email, full_name, first_seen_at
        from osp_auth.identity_requests where issuer = $1`, [issuer])).rows.map((r) => [String(r.subject).toLowerCase(), r]))
      const stateRow = (await tx.query('select value from osp_auth.meta where key = $1', [STATE_KEY])).rows[0]
      let prevMembers = 0
      try { prevMembers = Number(JSON.parse(stateRow?.value || '{}').members) || 0 } catch { prevMembers = 0 }

      const out = { created: 0, linked: 0, updated: 0, withdrawn: 0, revoked: 0, members: enabled.length, held: false, reasons: [] }
      for (const m of enabled) {
        if (links.has(m.id)) continue
        const email = normEmail(m.email)
        const fullName = fullNameOf({ family_name: m.lastName, given_name: m.firstName })
        if (linkByEmail) {
          const r = await identity.linkByEmailTx(tx, { subject: m.id, email, via: 'kc_sync' })
          await tx.mark('auth')
          if (r?.userId) { out.linked++; links.set(m.id, r.userId); continue }
        }
        const q = requests.get(m.id)
        if (q) {
          if (q.status === 'pending' && (q.email !== email || (fullName && q.full_name !== fullName))) {
            await tx.query('update osp_auth.identity_requests set email = $2, full_name = coalesce($3, full_name) where id = $1', [q.id, email, fullName])
            out.updated++
          }
          continue
        }
        const ins = await tx.query(`insert into osp_auth.identity_requests (issuer, subject, email, full_name, origin)
          values ($1, $2, $3, $4, 'kc_sync') on conflict (issuer, subject) do nothing returning id`, [issuer, m.id, email, fullName])
        if (ins.rows.length) {
          out.created++
          await event(tx, 'sso.request.create', { origin: 'kc_sync' })
        }
      }

      const withdrawIds = [...requests.values()]
        .filter((q) => q.status === 'pending' && q.origin === 'kc_sync' && !q.first_seen_at && !enabledIds.has(String(q.subject).toLowerCase()))
        .map((q) => q.id)
      const kcSyncRequests = [...requests.values()].filter((q) => q.status === 'pending' && q.origin === 'kc_sync' && !q.first_seen_at).length
      const goneUsers = [...links.entries()].filter(([subject]) => !enabledIds.has(subject)).map(([, userId]) => userId)
      await tx.mark('internal')
      const withSessions = goneUsers.length
        ? (await tx.query(`select distinct user_id from osp_session.sessions where auth_source = 'keycloak' and revoked_at is null
            and user_id = any($1::uuid[])`, [goneUsers])).rows.map((r) => r.user_id)
        : []
      out.reasons = breakerReasons({ prevMembers, members: enabled.length, links: links.size, revoke: withSessions.length, kcSyncRequests, withdraw: withdrawIds.length })
      out.held = !force && out.reasons.length > 0

      if (!out.held) {
        for (const userId of withSessions) {
          if (await sessions.revokeKeycloakInTx(tx, userId, 'sso_access_revoked')) out.revoked++
        }
        await tx.mark('auth')
        if (withdrawIds.length) {
          const del = await tx.query(`delete from osp_auth.identity_requests where id = any($1::uuid[]) and status = 'pending'
            and origin = 'kc_sync' and first_seen_at is null`, [withdrawIds])
          out.withdrawn = del.rowCount
          if (out.withdrawn) await event(tx, 'sso.request.withdraw', { count: out.withdrawn })
        }
        await tx.query(`insert into osp_auth.meta (key, value, updated_at) values ($1, $2, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()`, [STATE_KEY, JSON.stringify({ at: new Date(now()).toISOString(), members: enabled.length })])
      }
      await tx.mark('auth')
      await event(tx, 'sso.sync', { ...out, force: Boolean(force) })
      return out
    })
  }

  // Одна сверка: группа (вне транзакции) → запись. → итог | { busy: true } (идёт в другом экземпляре)
  async function once({ force = false } = {}) {
    if (!(await takeLease())) return { busy: true }
    try {
      const members = await kcAdmin.groupMembers()
      const result = await apply(members, force)
      log?.info({ ...result }, 'kc access sync')
      // Реестр организаций СУ-10 и организации участников (src/lib/auth/orgs.js): ошибка — сверка организаций пропускается,
      // прежний кэш остаётся, сверка группы не страдает.
      if (orgs) {
        try {
          await orgs.afterSync(members, { held: result.held })
        } catch (err) {
          log?.warn({ code: err?.code, status: err?.status }, 'org sync')
        }
      }
      return result
    } finally {
      await releaseLease()
    }
  }

  // Параллельный вызов ждёт текущий прогон. throttle — частый вызов со страницы получает прошлый итог.
  async function run({ force = false, throttle = false } = {}) {
    if (throttle && !force && last && now() - last.at < o.throttleMs) return { ...last.result, cached: true }
    running ??= once({ force }).then((result) => {
      if (!result.busy) last = { at: now(), result }
      return result
    }).finally(() => { running = null })
    return running
  }

  function start(intervalMs) {
    const tick = () => run().catch((err) => log?.warn({ code: err?.code || err?.name, status: err?.status }, 'kc access sync'))
    const first = setTimeout(tick, o.startDelayMs)
    first.unref?.()
    const timer = setInterval(tick, intervalMs)
    timer.unref?.()
    return () => { clearTimeout(first); clearInterval(timer) }
  }

  return { run, start, owner }
}
