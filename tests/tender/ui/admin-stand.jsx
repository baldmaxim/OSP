// «Администрирование» целиком (route=/admin): пользователи — из памяти (user_roles + get_auth_users), остальные вкладки —
// как есть на стенде. Люди вымышленные.
//   adminUsers=N — сколько пользователей (по умолчанию 1: один найденный поиском — меню «Ещё» у нижнего края таблицы).
import AdminPage from '../../../src/pages/AdminPage'

const params = new URLSearchParams(window.location.search)
const count = Math.max(1, Number(params.get('adminUsers') || 1))
const fdb = window.__fakeDb
const at = (days) => new Date(Date.now() - days * 86400000).toISOString()
const users = Array.from({ length: count }, (_, i) => ({
  id: `adm-u-${i + 1}`,
  email: `user${i + 1}@example.invalid`,
  created_at: at(30 + i),
  last_sign_in_at: i % 2 ? at(i) : null,
  email_confirmed_at: at(30 + i),
}))
fdb.user_roles = users.map((u, i) => ({
  id: `adm-r-${i + 1}`, user_id: u.id, email: u.email, role: i === 0 ? 'economist' : 'engineer', is_approved: true, is_blocked: false,
  full_name: i === 0 ? 'Петрова Анна Сергеевна' : `Сотрудник ${i + 1}`, work_phone: '', work_email: '',
  object_ids: ['obj-1'], object_id: null, counterparty_id: null, created_at: u.created_at,
}))
window.__fakeRpc = { ...(window.__fakeRpc || {}), get_auth_users: async () => ({ data: users, error: null }) }

export default function AdminStand() {
  return <AdminPage />
}
