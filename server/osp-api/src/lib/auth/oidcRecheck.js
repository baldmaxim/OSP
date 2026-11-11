// Перепроверка сессии СУ-10 (вход через Keycloak): своего refresh у портала нет, поэтому раз в OIDC_RECHECK_SEC (5 минут)
// работы сервер обменивает refresh token сессии в Keycloak и проверяет новый access token. Так блокировка учётки, выход из
// всех порталов и отзыв доступа на auth.su10.ru/manage доходят до ОСП не позже чем через 5 минут работы.
//
// Отзывают сессию: invalid_grant (SSO истёк, учётка заблокирована, вышли везде) — 401 OSP_SSO_REQUIRED; нет роли доступа к
// порталу — 403 OSP_NO_PORTAL_ACCESS; чужой sub — 401 OSP_SSO_REQUIRED; организация учётки (src/lib/auth/orgs.js) — 403
// OSP_ORG_UNMAPPED / OSP_ORG_DENIED, смена контрагента — 401 OSP_ORG_CHANGED (тогда закрыты все сессии пользователя). Всё остальное (сеть, 5xx, таймаут,
// ошибка клиента, ключи realm) — сбой контура, а не решение о человеке: работа продолжается до kc_checked_at + час
// (OIDC_MAX_OFFLINE_SEC), повтор не чаще раза в минуту, потом 503 OSP_SSO_UNAVAILABLE — без отзыва.
//
// Одна перепроверка на сессию, сколько бы экземпляров службы и запросов ни пришло: аренда в строке сессии (владелец, срок
// 10 с, захват — UPDATE … WHERE kc_checked_at = прежнее AND аренда свободна), запись итога — только владельцем. В процессе —
// общее обещание; параллельные запросы ждут итог до 5 с, не дождались — пускаются, пока не вышел час без проверки.
//
// Простаивающая вкладка: срок подошёл, а действий пользователя не было дольше OIDC_ACTIVITY_WINDOW_SEC (30 минут) — фоновый
// запрос получает 401 OSP_IDLE без отзыва, опрос встаёт до первого действия. Иначе брошенная вкладка продлевала бы SSO во все
// порталы контура до 30 дней.
import { randomUUID } from 'node:crypto'
import { kcAad } from './sessions.js'

export const RECHECK_ERRORS = {
  idle: { status: 401, code: 'OSP_IDLE', message: 'Вкладка долго не использовалась — продолжите работу' },
  ssoRequired: { status: 401, code: 'OSP_SSO_REQUIRED', message: 'Вход в СУ-10 завершён — войдите заново' },
  noAccess: { status: 403, code: 'OSP_NO_PORTAL_ACCESS', message: 'Доступ к порталу отозван в СУ-10' },
  unavailable: { status: 503, code: 'OSP_SSO_UNAVAILABLE', message: 'Вход СУ-10 временно недоступен — повторите позже' },
  revoked: { status: 401, code: 'OSP_SESSION_REVOKED', message: 'Сессия завершена — войдите заново' },
  // Организация учётки СУ-10 (src/lib/auth/orgs.js): все сессии пользователя уже закрыты в той же транзакции.
  orgUnmapped: { status: 403, code: 'OSP_ORG_UNMAPPED', message: 'Организация не сопоставлена с контрагентом ОСП — обратитесь к администратору ОСП' },
  orgDenied: { status: 403, code: 'OSP_ORG_DENIED', message: 'Учётка СУ-10 не числится в организации СУ-10 — обратитесь к администратору ОСП' },
  orgChanged: { status: 401, code: 'OSP_ORG_CHANGED', message: 'Организация учётки СУ-10 изменилась — войдите заново' },
}
const ORG_KEYS = { unmapped: 'orgUnmapped', denied: 'orgDenied', changed: 'orgChanged' }
const OK = Object.freeze({ ok: true })
const failWith = (key) => ({ ok: false, ...RECHECK_ERRORS[key] })
const ms = (v) => (v == null ? null : new Date(v).getTime())

export function createRecheck({ db, oidc, sessions, box, orgs = null, recheckMs = 300_000, activityWindowMs = 1_800_000, maxOfflineMs = 3_600_000,
  leaseMs = 10_000, retryMs = 60_000, waitMs = 5_000, pollMs = 250, now = Date.now, log = null, owner = randomUUID() }) {
  const inflight = new Map() // id_hash → обещание итога
  const sleep = (t) => new Promise((resolve) => { setTimeout(resolve, t).unref?.() })
  const withinGrace = (checkedAt) => checkedAt != null && now() < checkedAt + maxOfflineMs
  const graceOr = (checkedAt) => (withinGrace(checkedAt) ? OK : failWith('unavailable'))

  async function deny(session, reason, key) {
    sessions.forget(session.idHash)
    await db.write(null, async (tx) => {
      await tx.mark('internal')
      await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = $2 where id_hash = $1 and revoked_at is null`,
        [session.idHash, reason])
      await tx.mark('auth')
      await tx.query('insert into osp_auth.events (user_id, kind, detail) values ($1, $2, $3)',
        [session.userId, 'sso.recheck.denied', JSON.stringify({ reason })])
    }).catch((err) => log?.warn({ code: err?.code }, 'sso recheck revoke'))
    return failWith(key)
  }

  // Сбой контура: следующая попытка — не раньше чем через минуту; аренду отпускаем.
  async function postpone(session) {
    const r = await db.write(null, (tx) => tx.query(`update osp_session.sessions
        set kc_retry_after = now() + make_interval(secs => $3), kc_check_owner = null, kc_check_lease_until = null
      where id_hash = $1 and kc_check_owner = $2 returning kc_retry_after`, [session.idHash, owner, retryMs / 1000]))
      .catch(() => null)
    if (r?.rows?.[0]) sessions.patch(session.idHash, { kcRetryAfter: ms(r.rows[0].kc_retry_after) })
    return graceOr(session.kcCheckedAt)
  }

  async function claim(session) {
    return db.write(null, async (tx) => {
      const r = await tx.query(`update osp_session.sessions
          set kc_check_owner = $2, kc_check_lease_until = now() + make_interval(secs => $3)
        where id_hash = $1 and revoked_at is null and auth_source = 'keycloak'
          and kc_checked_at is not distinct from $4::timestamptz
          and (kc_check_lease_until is null or kc_check_lease_until < now())
          and (kc_retry_after is null or kc_retry_after <= now())
        returning kc_refresh_enc, kc_subject`, [session.idHash, owner, leaseMs / 1000, session.kcCheckedAt == null ? null : new Date(session.kcCheckedAt)])
      if (r.rows.length) return { claimed: r.rows[0] }
      const cur = await tx.query(`select kc_checked_at, kc_check_lease_until, kc_retry_after, revoked_at,
          kc_check_lease_until > now() as leased, kc_retry_after > now() as later
        from osp_session.sessions where id_hash = $1`, [session.idHash])
      return { current: cur.rows[0] || null }
    })
  }

  // Другой экземпляр (или другой запрос) держит аренду: ждём его итог, не дольше waitMs.
  async function waitForOther(session) {
    const until = now() + waitMs
    while (now() < until) {
      await sleep(pollMs)
      const row = (await db.read(null, (tx) => tx.query(`select kc_checked_at, revoked_at from osp_session.sessions where id_hash = $1`,
        [session.idHash]))).rows[0]
      if (!row || row.revoked_at) return failWith('revoked')
      const checked = ms(row.kc_checked_at)
      if (checked !== session.kcCheckedAt) {
        sessions.patch(session.idHash, { kcCheckedAt: checked })
        return OK
      }
    }
    return graceOr(session.kcCheckedAt)
  }

  async function runCheck(session) {
    let step
    try {
      step = await claim(session)
    } catch (err) {
      log?.warn({ code: err?.code }, 'sso recheck claim')
      return graceOr(session.kcCheckedAt)
    }
    if (!step.claimed) {
      const cur = step.current
      if (!cur || cur.revoked_at) return failWith('revoked')
      const checked = ms(cur.kc_checked_at)
      if (checked !== session.kcCheckedAt) {
        sessions.patch(session.idHash, { kcCheckedAt: checked, kcRetryAfter: ms(cur.kc_retry_after) })
        return OK
      }
      if (cur.leased) return waitForOther(session)
      if (cur.later) sessions.patch(session.idHash, { kcRetryAfter: ms(cur.kc_retry_after) })
      return graceOr(session.kcCheckedAt)
    }

    let refreshToken
    try {
      refreshToken = box.decrypt(step.claimed.kc_refresh_enc, kcAad(session.idHash))
    } catch {
      // Ключа нет в окружении или строка чужая — сессию не перепроверить никогда: вход заново.
      return deny(session, 'sso_token_unreadable', 'ssoRequired')
    }
    let result
    try {
      result = await oidc.refresh(refreshToken)
    } catch (err) {
      if (err?.code === 'invalid_grant') return deny(session, 'sso_expired', 'ssoRequired')
      log?.warn({ code: err?.detail || err?.code }, 'sso recheck unavailable')
      return postpone(session)
    }
    const subject = String(step.claimed.kc_subject || '').toLowerCase()
    if (result.access.subject !== subject) return deny(session, 'sso_subject', 'ssoRequired')
    if (!result.access.hasAccess) return deny(session, 'sso_access_revoked', 'noAccess')

    // Организация — по новому access token. Отказ и смена контрагента закрывают все сессии пользователя в той же транзакции
    // (src/lib/auth/orgs.js). Сбой базы — не решение о человеке: как прочие сбои, повтор через минуту в пределах часа.
    if (orgs) {
      let org
      try {
        org = await orgs.applyOnRecheck({ userId: session.userId, subject, orgIds: result.access.orgIds || [] })
      } catch (err) {
        log?.warn({ code: err?.code }, 'sso recheck org')
        return postpone(session)
      }
      if (!org.ok) {
        sessions.forget(session.idHash)
        return failWith(ORG_KEYS[org.key] || 'orgUnmapped')
      }
    }

    const aad = kcAad(session.idHash)
    let written
    try {
      written = await db.write(null, (tx) => tx.query(`update osp_session.sessions set kc_refresh_enc = $3,
          kc_id_token_enc = coalesce($4, kc_id_token_enc), kc_sid = coalesce($5, kc_sid),
          kc_checked_at = date_trunc('milliseconds', now()), kc_retry_after = null, kc_check_owner = null, kc_check_lease_until = null
        where id_hash = $1 and kc_check_owner = $2 and revoked_at is null returning kc_checked_at`,
      [session.idHash, owner, box.encrypt(result.refreshToken, aad), result.idToken ? box.encrypt(result.idToken, aad) : null,
        result.access.sid || null]))
    } catch (err) {
      log?.warn({ code: err?.code }, 'sso recheck save')
      return graceOr(session.kcCheckedAt)
    }
    // Аренду успели потерять (запрос шёл дольше 10 с) или сессию отозвали — итог не записан; прежний refresh по-прежнему
    // действует (отзыв refresh token в realm выключен), следующий запрос перепроверит.
    if (!written.rows.length) return graceOr(session.kcCheckedAt)
    sessions.patch(session.idHash, { kcCheckedAt: ms(written.rows[0].kc_checked_at), kcRetryAfter: null })
    return OK
  }

  // → { ok: true } | { ok: false, status, code, message }
  async function ensure(session, { active = false } = {}) {
    if (session.authSource !== 'keycloak') return OK
    const t = now()
    if (session.kcCheckedAt != null && t - session.kcCheckedAt < recheckMs) return OK
    if (!active && t - (session.lastActivityAt ?? 0) > activityWindowMs) return failWith('idle')
    // Недавно не вышло — до kc_retry_after не стучимся: решает час без проверки.
    if (session.kcRetryAfter != null && t < session.kcRetryAfter) return graceOr(session.kcCheckedAt)
    let job = inflight.get(session.idHash)
    if (!job) {
      job = runCheck(session).finally(() => inflight.delete(session.idHash))
      inflight.set(session.idHash, job)
    }
    const TIMEOUT = Symbol('timeout')
    const result = await Promise.race([job, sleep(waitMs).then(() => TIMEOUT)])
    if (result === TIMEOUT) return graceOr(session.kcCheckedAt)
    return result
  }

  return { ensure, owner }
}
