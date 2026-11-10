// Запросы ручных команд связей с СУ-10 (src/identity-cli.js). Отметку osp:auth ставит только модуль входа — поэтому они здесь,
// а команда занимается только вводом и выводом. Почта и ФИО читаются только для выгрузки пользователей команде auth.

async function hasSuperadmins(tx) {
  return (await tx.query("select to_regclass('public.superadmins') is not null as ok")).rows[0].ok
}

// Одобренные незаблокированные пользователи и суперадминистраторы: id, почта, ФИО.
export async function exportUsers(db) {
  return db.read(null, async (tx) => {
    await tx.mark('internal')
    const sa = await hasSuperadmins(tx)
    return (await tx.query(`select u.id, u.email, r.full_name from auth.users u left join public.user_roles r on r.user_id = u.id
      where (r.is_approved = true and r.is_blocked is not true)${sa ? ' or exists (select 1 from public.superadmins s where s.user_id = u.id)' : ''}
      order by u.email`)).rows
  })
}

export async function userIds(db) {
  return db.read(null, async (tx) => {
    await tx.mark('internal')
    return (await tx.query('select id from auth.users')).rows.map((r) => r.id)
  })
}

// Связи этого issuer → { bySubject: Map(sub → user_id), byUser: Map(user_id → sub) }
export async function readLinks(db, issuer) {
  return db.read(null, async (tx) => {
    await tx.mark('auth')
    const { rows } = await tx.query('select subject, user_id from osp_auth.identity_links where issuer = $1', [issuer])
    return {
      bySubject: new Map(rows.map((r) => [String(r.subject).toLowerCase(), r.user_id])),
      byUser: new Map(rows.map((r) => [r.user_id, String(r.subject).toLowerCase()])),
    }
  })
}

// Файл связей — одной транзакцией (конфликт уникальности откатывает всё).
export async function insertLinks(db, issuer, rows) {
  await db.write(null, async (tx) => {
    await tx.mark('auth')
    for (const r of rows) {
      await tx.query(`insert into osp_auth.identity_links (issuer, subject, user_id, source) values ($1, $2, $3, 'link_file')`, [issuer, r.kc, r.osp])
    }
    await tx.query('insert into osp_auth.events (user_id, kind, detail) values (null, $1, $2)', ['sso.link', JSON.stringify({ source: 'link_file', count: rows.length })])
  })
}

// Для отчёта: одобренные (и кто из них администратор), связанные, у кого есть пароль ОСП, заявки по статусам.
export async function linksReport(db, issuer) {
  return db.read(null, async (tx) => {
    await tx.mark('internal')
    const sa = await hasSuperadmins(tx)
    const superadmin = sa ? ' or exists (select 1 from public.superadmins s where s.user_id = u.id)' : ''
    const approved = (await tx.query(`select u.id, (r.role = 'admin'${superadmin}) as admin
      from auth.users u left join public.user_roles r on r.user_id = u.id
      where (r.is_approved = true and r.is_blocked is not true)${superadmin}`)).rows
    await tx.mark('auth')
    const linked = new Set((await tx.query('select user_id from osp_auth.identity_links where issuer = $1', [issuer])).rows.map((x) => x.user_id))
    const withPassword = new Set((await tx.query('select user_id from osp_auth.credentials')).rows.map((x) => x.user_id))
    const requests = (await tx.query('select status, count(*)::int as n from osp_auth.identity_requests where issuer = $1 group by status', [issuer])).rows
    return { approved, linked, withPassword, requests }
  })
}

// Закрыть действующие сессии вида kind ('keycloak' | 'password'). → сколько
export async function revokeSessionsOfKind(db, kind) {
  return db.write(null, async (tx) => {
    await tx.mark('internal')
    const r = await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = 'auth_mode'
      where revoked_at is null and auth_source = $1`, [kind])
    return r.rowCount
  })
}
