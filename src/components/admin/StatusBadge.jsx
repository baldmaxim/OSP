// Бейдж статуса пользователя. Статус выводится из реальных данных user_roles:
//   active   — is_approved = true;
//   pending  — заявка на регистрацию (не подтверждён, ни разу не входил);
//   blocked  — доступ отозван (не подтверждён, но раньше входил).
// Цвет не единственный признак — рядом всегда текст и точка-индикатор (доступность).
const STATUS_META = {
  active: { cls: 'adm-sbadge-active', label: 'Активен' },
  pending: { cls: 'adm-sbadge-pending', label: 'Приглашён' },
  blocked: { cls: 'adm-sbadge-blocked', label: 'Заблокирован' },
}

export function userStatus(u) {
  if (u.is_approved) return 'active'
  if (u.last_login_at) return 'blocked'
  return 'pending'
}

export default function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending
  return (
    <span className={`adm-sbadge ${meta.cls}`}>
      <span className="adm-sdot" aria-hidden />
      {meta.label}
    </span>
  )
}
