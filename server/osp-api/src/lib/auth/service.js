// Свой вход: проверка пароля, сессии, смена и сброс пароля, учётки от администратора.
//
// Гарантии (tests/osp-api/own-auth.test.mjs):
//   • вход по уже заменённому паролю сессии не получает: пароль проверяется вне транзакции (расчёт долгий), а
//     сессия создаётся в одной транзакции только при той же версии пароля, что была проверена (FOR UPDATE).
//     Сброс, смена и перенос пароля повышают версию и отзывают сессии в той же транзакции;
//   • ответ на неудачу один для любой учётки (несуществующей, заблокированной, с прежним или новым
//     отпечатком), время — одинаковое (passwords.js). Статус сообщается только после верного пароля;
//   • перебор: по нормализованной почте после 5 неудач — пауза 1 мин, затем вдвое длиннее, до 15 мин; хранится
//     в базе. Вытесняются только строки несуществующих почт без действующей блокировки;
//   • пароли (osp_auth) читаются и пишутся только с отметкой 'auth', учётки и сессии — с 'internal'.
import { CANARY_AAD, CANARY_TEXT } from './secretBox.js'
import { hashPassword, needsRehash } from './passwords.js'
import { checkNewPassword, generateTemporaryPassword } from './policy.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const LOCK_AFTER = 5
export const FAILURES_CAP = 50_000

export const AUTH_ERRORS = {
  invalid: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' },
  locked: { status: 429, code: 'too_many_attempts', message: 'Слишком много неудачных попыток входа' },
  pending: { status: 403, code: 'PENDING_APPROVAL', message: 'Учётная запись ожидает одобрения администратора' },
  blocked: { status: 403, code: 'ACCOUNT_BLOCKED', message: 'Учётная запись заблокирована' },
  pilot: { status: 403, code: 'OSP_AUTH_PILOT', message: 'Вход через портал пока включён только для проверки — войдите прежним способом' },
  busy: { status: 503, code: 'OSP_AUTH_BUSY', message: 'Сервер входа занят, повторите вход через несколько секунд' },
}

const fail = (key, extra = {}) => ({ ok: false, ...AUTH_ERRORS[key], ...extra })

export function createAuthService({ db, box, verifier, sessions, blocklist, mode = 'own', pilotIds = [], logger = null }) {
  let superadminsTable = null // есть ли public.superadmins (на проде — да; в тестовых базах может не быть)
  // Новый отпечаток — через очередь расчётов проверяющего (passwords.js), до открытия транзакции.
  const newHash = (password) => (verifier.hash ? verifier.hash(password) : hashPassword(password))
  const busyOr = async (fn) => {
    try {
      return await fn()
    } catch (err) {
      if (err?.code === 'OSP_AUTH_BUSY') return { busy: true }
      throw err
    }
  }

  const event = (tx, userId, kind, detail = {}) =>
    tx.query('insert into osp_auth.events (user_id, kind, detail) values ($1, $2, $3)', [userId, kind, JSON.stringify(detail)])

  async function hasSuperadmins(tx) {
    if (superadminsTable === null) {
      const { rows } = await tx.query("select to_regclass('public.superadmins') is not null as ok")
      superadminsTable = rows[0].ok
    }
    return superadminsTable
  }

  async function isSuperadminTx(tx, userId) {
    if (!(await hasSuperadmins(tx))) return false
    const { rows } = await tx.query('select exists (select 1 from public.superadmins where user_id = $1) as ok', [userId])
    return rows[0].ok
  }

  const isSuperadmin = (userId) => db.read(null, (tx) => isSuperadminTx(tx, userId))

  // Учётка, пароль и счётчик неудач — одним чтением.
  async function readAccount(email) {
    return db.read(null, async (tx) => {
      const { rows } = await tx.query(`select osp_private.email_norm($1) as norm, u.id, u.email, u.raw_user_meta_data as meta,
          r.user_id is not null as has_roles, r.role, r.is_approved, r.is_blocked, r.full_name
        from (select 1) one
        left join auth.users u on osp_private.email_norm(u.email) = osp_private.email_norm($1)
        left join public.user_roles r on r.user_id = u.id`, [email])
      const acc = rows[0]
      await tx.mark('auth')
      const failures = (await tx.query('select failures, locked_until from osp_auth.login_failures where email_norm = $1', [acc.norm])).rows[0] || null
      const cred = acc.id
        ? (await tx.query('select secret, version, must_change from osp_auth.credentials where user_id = $1', [acc.id])).rows[0] || null
        : null
      return { acc, failures, cred }
    })
  }

  // Строка пароля → отпечаток; не расшифровалась — null (проверка всё равно идёт холостым расчётом).
  function openSecret(cred, userId) {
    if (!cred) return null
    try {
      return box.decrypt(cred.secret, userId)
    } catch (err) {
      logger?.error({ userId, code: err?.code || 'secret' }, 'auth: пароль не расшифровывается — проверьте OSP_AUTH_KEYS')
      return null
    }
  }

  async function recordFailure(norm, accountExists) {
    return db.write(null, async (tx) => {
      await tx.mark('auth')
      const exists = (await tx.query('select 1 from osp_auth.login_failures where email_norm = $1', [norm])).rows.length > 0
      if (!exists) {
        const { rows } = await tx.query('select count(*)::int as n from osp_auth.login_failures')
        if (rows[0].n >= FAILURES_CAP) {
          // Вытесняем только несуществующие почты без действующей блокировки — защиту настоящей учётки не вытеснить.
          await tx.query(`delete from osp_auth.login_failures where email_norm in (
              select email_norm from osp_auth.login_failures
              where not account_exists and (locked_until is null or locked_until < now())
              order by last_at limit $1)`, [rows[0].n - FAILURES_CAP + 1])
          const left = (await tx.query('select count(*)::int as n from osp_auth.login_failures')).rows[0].n
          if (left >= FAILURES_CAP && !accountExists) return null
        }
      }
      const { rows } = await tx.query(`insert into osp_auth.login_failures as f (email_norm, failures, last_at, account_exists)
          values ($1, 1, now(), $2)
        on conflict (email_norm) do update set failures = f.failures + 1, last_at = now(), account_exists = excluded.account_exists,
          locked_until = case when f.failures + 1 >= ${LOCK_AFTER}
            then now() + least(interval '15 minutes', interval '1 minute' * power(2, f.failures + 1 - ${LOCK_AFTER}))
            else f.locked_until end
        returning failures, locked_until`, [norm, accountExists])
      return rows[0]
    })
  }

  const retryAfter = (lockedUntil) => Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000))

  // → { ok: true, session: { token, csrf, maxAgeSec }, user: { id, email }, mustChange } | { ok: false, status, code, message }
  async function login({ email, password }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { acc, failures, cred } = await readAccount(email)
      if (failures?.locked_until && new Date(failures.locked_until).getTime() > Date.now()) {
        return fail('locked', { retryAfterSec: retryAfter(failures.locked_until) })
      }
      const stored = acc.id ? openSecret(cred, acc.id) : null
      let verdict
      try {
        verdict = await verifier.verify(password, stored)
      } catch (err) {
        if (err?.code === 'OSP_AUTH_BUSY') return fail('busy')
        throw err
      }
      if (!verdict.ok) {
        const f = await recordFailure(acc.norm, Boolean(acc.id))
        if (acc.id) await db.write(null, async (tx) => { await tx.mark('auth'); await event(tx, acc.id, 'login_failed', {}) })
        if (f?.locked_until && new Date(f.locked_until).getTime() > Date.now()) return fail('locked', { retryAfterSec: retryAfter(f.locked_until) })
        return fail('invalid')
      }

      let rehashed = null
      if (needsRehash(stored)) {
        const h = await busyOr(() => newHash(password))
        if (h?.busy) return fail('busy')
        rehashed = box.encrypt(h, acc.id)
      }
      const result = await db.write(null, async (tx) => {
        await tx.mark('auth')
        const now = (await tx.query('select version from osp_auth.credentials where user_id = $1 for update', [acc.id])).rows[0]
        if (!now || String(now.version) !== String(cred.version)) return { retry: true }
        // Пересчёт того же пароля в scrypt. source не меняется: он говорит, где пароль задан (supabase — тот же,
        // что в Supabase: перенос учёток перед переключением обновит его, если его там изменили; own — задан здесь).
        if (rehashed) {
          await tx.query(`update osp_auth.credentials set secret = $2, algo = 'scrypt', version = version + 1, changed_at = now()
            where user_id = $1`, [acc.id, rehashed])
        }
        await tx.query('delete from osp_auth.login_failures where email_norm = $1', [acc.norm])

        await tx.mark('internal')
        const superadmin = await isSuperadminTx(tx, acc.id)
        const role = (await tx.query('select is_approved, is_blocked from public.user_roles where user_id = $1 for share', [acc.id])).rows[0]
        let outcome = null
        if (!role && !superadmin) {
          // Учётка есть, заявки нет (зарегистрировались в Supabase, но не входили) — заявка, как делал фронт.
          const meta = acc.meta || {}
          const contractor = meta.kind === 'contractor'
          await tx.query(`insert into public.user_roles (user_id, email, role, is_approved, full_name, work_phone, requested_company)
              values ($1, $2, $3, false, $4, $5, $6) on conflict (user_id) do nothing`,
          [acc.id, acc.email, contractor ? 'contractor' : 'engineer', meta.full_name || null, contractor ? meta.phone || null : null, contractor ? meta.company || null : null])
          outcome = 'pending'
        } else if (!superadmin && role.is_blocked) outcome = 'blocked'
        else if (!superadmin && !role.is_approved) outcome = 'pending'
        else if (mode === 'both' && !pilotIds.includes(acc.id)) outcome = 'pilot'

        if (outcome) {
          await tx.mark('auth')
          await event(tx, acc.id, 'login_refused', { reason: outcome })
          return { outcome }
        }
        const session = await sessions.createInTx(tx, { userId: acc.id, mustChange: cred.must_change })
        await tx.query('update auth.users set last_sign_in_at = now() where id = $1', [acc.id])
        await tx.query('update public.user_roles set last_login_at = now() where user_id = $1', [acc.id])
        await tx.mark('auth')
        await event(tx, acc.id, 'login', { rehashed: Boolean(rehashed) })
        return { session }
      })
      if (result.retry) continue // пароль сменили между проверкой и записью — проверяем заново по новой версии
      if (result.outcome) return fail(result.outcome)
      return { ok: true, session: result.session, user: { id: acc.id, email: acc.email }, mustChange: Boolean(cred.must_change) }
    }
    return fail('invalid')
  }

  // Смена пароля вошедшим: текущий (или временный) → новый. Остальные сессии отзываются, текущая получает
  // новый id. → { ok: true, session } | { ok: false, status, code, message }
  async function changePassword({ session, currentPassword, newPassword }) {
    const { acc, cred } = await readAccountById(session.userId)
    if (!acc) return { ok: false, status: 401, code: 'OSP_SESSION_REVOKED', message: 'Сессия завершена' }
    const problem = checkNewPassword(newPassword, { email: acc.email, fullName: acc.full_name }, blocklist)
    if (problem) return { ok: false, status: 400, ...problem }
    const stored = openSecret(cred, acc.id)
    let verdict
    try {
      verdict = await verifier.verify(currentPassword, stored)
    } catch (err) {
      if (err?.code === 'OSP_AUTH_BUSY') return fail('busy')
      throw err
    }
    if (!verdict.ok) {
      await recordFailure(acc.norm, true)
      return { ok: false, status: 400, code: 'current_password_invalid', message: 'Текущий пароль указан неверно' }
    }
    const h = await busyOr(() => newHash(newPassword))
    if (h?.busy) return fail('busy')
    const secret = box.encrypt(h, acc.id)
    const result = await db.write(null, async (tx) => {
      await tx.mark('auth')
      const now = (await tx.query('select version from osp_auth.credentials where user_id = $1 for update', [acc.id])).rows[0]
      if (!now || String(now.version) !== String(cred.version)) return { conflict: true }
      await tx.query(`update osp_auth.credentials set secret = $2, algo = 'scrypt', source = 'own', must_change = false,
          version = version + 1, changed_at = now() where user_id = $1`, [acc.id, secret])
      await event(tx, acc.id, 'password_changed', {})
      await tx.mark('internal')
      await sessions.revokeAllInTx(tx, acc.id, 'password_changed')
      return { session: await sessions.createInTx(tx, { userId: acc.id, mustChange: false }) }
    })
    if (result.conflict) return { ok: false, status: 409, code: 'password_changed_meanwhile', message: 'Пароль только что изменили — войдите заново' }
    return { ok: true, session: result.session }
  }

  async function readAccountById(userId) {
    return db.read(null, async (tx) => {
      const { rows } = await tx.query(`select osp_private.email_norm(u.email) as norm, u.id, u.email, r.full_name
        from auth.users u left join public.user_roles r on r.user_id = u.id where u.id = $1`, [userId])
      const acc = rows[0] || null
      if (!acc) return { acc: null, cred: null }
      await tx.mark('auth')
      const cred = (await tx.query('select secret, version, must_change from osp_auth.credentials where user_id = $1', [userId])).rows[0] || null
      return { acc, cred }
    })
  }

  // Временный пароль: отпечаток считается до транзакции (расчёт долгий — подключение к базе не держим).
  async function temporaryPassword() {
    const password = generateTemporaryPassword()
    const h = await busyOr(() => newHash(password))
    return h?.busy ? null : { password, hash: h }
  }

  // Временный пароль — новому или существующему пользователю: must_change, версия +1, все сессии отозваны.
  async function setTemporaryPasswordTx(tx, userId, actorId, kind, temp) {
    const secret = box.encrypt(temp.hash, userId)
    await tx.mark('auth')
    await tx.query(`insert into osp_auth.credentials as c (user_id, secret, version, algo, source, must_change)
        values ($1, $2, 1, 'scrypt', 'own', true)
      on conflict (user_id) do update set secret = excluded.secret, algo = 'scrypt', source = 'own', must_change = true,
        version = c.version + 1, changed_at = now()`, [userId, secret])
    await event(tx, userId, kind, { by: actorId })
    await tx.mark('internal')
    await sessions.revokeAllInTx(tx, userId, kind)
    return temp.password
  }

  // Учётка от администратора: почта подтверждена (её подтвердил администратор), заявка одобрена,
  // временный пароль показывается один раз. → { ok: true, user, temporaryPassword } | { ok: false, … }
  async function adminCreateUser({ actorId, email, fullName, role, counterpartyId = null, objectIds = [] }) {
    const temp = await temporaryPassword()
    if (!temp) return fail('busy')
    try {
      return await db.write(null, async (tx) => {
        await tx.mark('internal')
        const taken = (await tx.query('select 1 from auth.users where osp_private.email_norm(email) = osp_private.email_norm($1)', [email])).rows.length > 0
        if (taken) return { ok: false, status: 409, code: 'email_taken', message: 'Учётная запись с такой почтой уже есть' }
        if (role === 'contractor' && !counterpartyId) {
          return { ok: false, status: 400, code: 'counterparty_required', message: 'Для подрядчика нужна организация' }
        }
        if (await roleUnknown(tx, role)) return { ok: false, status: 400, code: 'role_unknown', message: 'Такой роли нет' }
        const { rows } = await tx.query(`insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
            values (gen_random_uuid(), 'authenticated', 'authenticated', btrim($1), now(), now(), now(), jsonb_build_object('full_name', $2::text))
          returning id, email`, [email, fullName || null])
        const user = rows[0]
        await tx.query(`insert into public.user_roles (user_id, email, role, is_approved, full_name, counterparty_id, object_ids)
            values ($1, $2, $3, true, $4, $5, $6::uuid[])`, [user.id, user.email, role, fullName || null, counterpartyId, objectIds])
        const password = await setTemporaryPasswordTx(tx, user.id, actorId, 'admin_created', temp)
        return { ok: true, user: { id: user.id, email: user.email }, temporaryPassword: password }
      })
    } catch (err) {
      if (err?.code === '23505') return { ok: false, status: 409, code: 'email_taken', message: 'Учётная запись с такой почтой уже есть' }
      if (err?.code === '23503') return { ok: false, status: 400, code: 'reference_unknown', message: 'Организация или объект не найдены' }
      throw err
    }
  }

  async function roleUnknown(tx, role) {
    const { rows } = await tx.query("select to_regclass('public.roles') is not null as ok")
    if (!rows[0].ok) return !['admin', 'engineer', 'contractor'].includes(role)
    return (await tx.query('select 1 from public.roles where key = $1', [role])).rows.length === 0
  }

  async function adminResetPassword({ actorId, userId }) {
    const temp = await temporaryPassword()
    if (!temp) return fail('busy')
    return db.write(null, async (tx) => {
      await tx.mark('internal')
      const exists = (await tx.query('select 1 from auth.users where id = $1', [userId])).rows.length > 0
      if (!exists) return { ok: false, status: 404, code: 'user_not_found', message: 'Пользователь не найден' }
      return { ok: true, temporaryPassword: await setTemporaryPasswordTx(tx, userId, actorId, 'admin_reset', temp) }
    })
  }

  // Удаление учётки администратором: надгробие (повторный перенос из Supabase её не воссоздаст) и функция базы
  // admin_delete_user (сама проверяет права и запрет удалять себя) — одной транзакцией: либо всё, либо ничего.
  async function adminDeleteUser({ who, targetUserId }) {
    if (!UUID.test(String(targetUserId))) return { ok: false, status: 400, code: 'OSP_AUTH_TARGET', message: 'Не указана учётка' }
    try {
      await db.write(who, async (tx) => {
        await tx.mark('internal')
        const email = (await tx.query('select email from auth.users where id = $1', [targetUserId])).rows[0]?.email ?? null
        await tx.mark('auth')
        await tx.query(`insert into osp_auth.tombstones (user_id, email_norm, deleted_by) values ($1, osp_private.email_norm($2), $3)
          on conflict (user_id) do update set deleted_at = now(), deleted_by = excluded.deleted_by`, [targetUserId, email, who.userId])
        await event(tx, targetUserId, 'admin_deleted', { by: who.userId })
        await tx.mark('user')
        await tx.query('select public.admin_delete_user($1)', [targetUserId])
      })
      return { ok: true }
    } catch (err) {
      // Отказ самой функции (не администратор, удаление себя) — как ответ PostgREST.
      if (err?.code === 'P0001' || err?.code === '42501') {
        return { ok: false, status: 400, code: err.code, message: String(err.message || '').slice(0, 200) }
      }
      throw err
    }
  }

  // Готовность: канарейка расшифровывается текущими ключами, и у каждой строки паролей ключ есть в окружении.
  async function readyCheck() {
    await db.read(null, async (tx) => {
      await tx.mark('auth')
      const canary = (await tx.query("select value from osp_auth.meta where key = 'canary'")).rows[0]
      if (!canary) throw new Error('нет канарейки ключа — сначала перенос учёток (accounts-sync)')
      if (box.decrypt(canary.value, CANARY_AAD) !== CANARY_TEXT) throw new Error('канарейка не совпала')
      const { rows } = await tx.query("select distinct split_part(secret, ':', 2) as key_id from osp_auth.credentials")
      const missing = rows.map((r) => r.key_id).filter((id) => !box.hasKey(id))
      if (missing.length) throw new Error(`в OSP_AUTH_KEYS нет ключей: ${missing.join(', ')}`)
    })
  }

  // Очистка: сессии через 7 дней после истечения или отзыва, неудачи — через 24 ч без действующей блокировки,
  // журнал входа — 180 дней. Надгробия не удаляются. Одна служба за раз — блокировка в базе.
  async function cleanup() {
    return db.write(null, async (tx) => {
      const { rows } = await tx.query('select pg_try_advisory_xact_lock(hashtext($1)) as ok', ['osp:auth-cleanup'])
      if (!rows[0].ok) return null
      await tx.mark('internal')
      const s = await tx.query(`delete from osp_session.sessions
        where coalesce(revoked_at, least(idle_expires_at, absolute_expires_at)) < now() - interval '7 days'`)
      await tx.mark('auth')
      const f = await tx.query(`delete from osp_auth.login_failures
        where last_at < now() - interval '24 hours' and (locked_until is null or locked_until < now())`)
      const e = await tx.query("delete from osp_auth.events where at < now() - interval '180 days'")
      return { sessions: s.rowCount, failures: f.rowCount, events: e.rowCount }
    })
  }

  // «Выйти на всех устройствах».
  async function logoutAll(userId) {
    await db.write(null, async (tx) => {
      await tx.mark('internal')
      await sessions.revokeAllInTx(tx, userId, 'logout_all')
      await tx.mark('auth')
      await event(tx, userId, 'logout_all', {})
    })
  }

  return { login, changePassword, logoutAll, adminCreateUser, adminResetPassword, adminDeleteUser, readyCheck, cleanup, isSuperadmin }
}
