// Учётки входа остаются в Supabase Auth. Служебным функциям портала (список пользователей для
// администратора, подтверждение почты, удаление учётки) нужна их копия в базе — таблица auth.users
// (migration/target/sql/load-single-owner.sql): идентификатор, почта, даты. Паролей в ней нет.
// Копия обновляется из Supabase Auth служебным ключом — перед показом списка администратору, не чаще
// раза в минуту.
const SYNC_INTERVAL_MS = 60_000
const PAGE = 1000

const UPSERT = `insert into auth.users (id, aud, role, email, email_confirmed_at, last_sign_in_at, created_at, updated_at, raw_user_meta_data)
  select x.id, x.aud, x.role, x.email, x.email_confirmed_at, x.last_sign_in_at, x.created_at, x.updated_at, x.user_metadata
  from jsonb_to_recordset($1::jsonb) as x(id uuid, aud text, role text, email text, email_confirmed_at timestamptz,
    last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz, user_metadata jsonb)
  on conflict (id) do update set email = excluded.email, email_confirmed_at = excluded.email_confirmed_at,
    last_sign_in_at = excluded.last_sign_in_at, updated_at = excluded.updated_at, raw_user_meta_data = excluded.raw_user_meta_data`

// Действия с учётками входа — клиент Supabase со служебным ключом.
export function createAuthAdmin(getServiceAuthClient) {
  const admin = () => getServiceAuthClient().auth.admin
  return {
    async listUsers() {
      const users = []
      for (let page = 1; ; page++) {
        const { data, error } = await admin().listUsers({ page, perPage: PAGE })
        if (error) throw new Error(`auth listUsers: ${error.status || error.message}`)
        users.push(...(data?.users || []))
        if ((data?.users || []).length < PAGE) return users
      }
    },
    async deleteUser(id) {
      const { error } = await admin().deleteUser(id)
      // Учётки уже нет — цель достигнута.
      if (error && error.status !== 404) throw new Error(`auth deleteUser: ${error.status || error.message}`)
    },
    async confirmEmail(id) {
      const { error } = await admin().updateUserById(id, { email_confirm: true })
      if (error) throw new Error(`auth confirmEmail: ${error.status || error.message}`)
    },
  }
}

export function createAuthUsersMirror({ db, authAdmin, now = Date.now }) {
  let syncedAt = 0
  let running = null
  async function sync({ force = false } = {}) {
    if (!force && now() - syncedAt < SYNC_INTERVAL_MS) return false
    running ??= (async () => {
      const users = (await authAdmin.listUsers()).map((u) => ({
        id: u.id, aud: u.aud || null, role: u.role || null, email: u.email || null,
        email_confirmed_at: u.email_confirmed_at || null, last_sign_in_at: u.last_sign_in_at || null,
        created_at: u.created_at || null, updated_at: u.updated_at || null, user_metadata: u.user_metadata || null,
      }))
      if (users.length) await db.write(null, (tx) => tx.query(UPSERT, [JSON.stringify(users)]))
      syncedAt = now()
      return users.length
    })().finally(() => { running = null })
    await running
    return true
  }
  return { sync }
}
