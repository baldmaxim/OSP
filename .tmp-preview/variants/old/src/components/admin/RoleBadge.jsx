// Компактный цветной бейдж роли. Цвет — по известному ключу роли, иначе нейтральный.
const ROLE_CLASS = {
  admin: 'adm-rbadge-admin',
  superuser: 'adm-rbadge-admin',
  superadmin: 'adm-rbadge-admin',
  engineer: 'adm-rbadge-engineer',
  economist: 'adm-rbadge-economist',
  lawyer: 'adm-rbadge-lawyer',
  otiz: 'adm-rbadge-otiz',
  contractor: 'adm-rbadge-default',
}

export default function RoleBadge({ roleKey, label }) {
  if (!roleKey) return <span className="adm-rbadge adm-rbadge-none" title="Роль не назначена">Без роли</span>
  const cls = ROLE_CLASS[roleKey] || 'adm-rbadge-default'
  const text = label || roleKey
  return <span className={`adm-rbadge ${cls}`} title={text}>{text}</span>
}
