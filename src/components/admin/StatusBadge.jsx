// Бейдж статуса пользователя. Статус выводится из реальных данных user_roles:
//   blocked  — is_blocked = true (миграция 20260920: блокировка — явный признак);
//   active   — is_approved = true;
//   pending  — заявка на регистрацию / приглашение, ещё не подтверждён.
// Раньше «заблокирован» вычислялся как «не подтверждён, но входил», и без отметки
// входа (last_login_at пуст у многих) заблокированный показывался «Приглашён».
// Цвет не единственный признак — рядом всегда текст и точка-индикатор (доступность).
const STATUS_META = {
  active: { cls: 'adm-sbadge-active', label: 'Активен' },
  pending: { cls: 'adm-sbadge-pending', label: 'Приглашён' },
  blocked: { cls: 'adm-sbadge-blocked', label: 'Заблокирован' },
}

export function userStatus(u) {
  if (u.is_blocked) return 'blocked'
  if (u.is_approved) return 'active'
  // Колонки is_blocked ещё нет (миграция 20260920 не применена) — прежнее правило.
  if (u.is_blocked === undefined && u.last_login_at) return 'blocked'
  return 'pending'
}

// Поля user_roles для перевода пользователя в статус. Заблокированный всегда
// не подтверждён (ограничение user_roles_blocked_not_approved).
export function statusPatch(status, byName = null) {
  if (status === 'active') return { is_approved: true, is_blocked: false, blocked_at: null, blocked_by_name: null }
  if (status === 'blocked') return { is_approved: false, is_blocked: true, blocked_at: new Date().toISOString(), blocked_by_name: byName }
  return { is_approved: false, is_blocked: false, blocked_at: null, blocked_by_name: null }
}

// Ошибка «нет колонки блокировки»: 42703 от Postgres или PGRST204 из кэша схемы.
export function isBlockColumnMissing(err) {
  return (err?.code === '42703' || err?.code === 'PGRST204') && /is_blocked|blocked_at|blocked_by_name/.test(err?.message || '')
}
export const BLOCK_MIGRATION_HINT = 'Блокировка недоступна: в базе не применена миграция 20260920_user_roles_is_blocked.'

export default function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending
  return (
    <span className={`adm-sbadge ${meta.cls}`}>
      <span className="adm-sdot" aria-hidden />
      {meta.label}
    </span>
  )
}
