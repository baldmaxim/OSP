import './TgPublishToggle.css'

// Галочка «Проверка РД» под тендерным пакетом (миграция 20260917): рабочая
// документация в пакете проверена. Внешне и по поведению — как «Публикация в ТГ»
// (те же стили .tgpub): зелёная, когда отмечено; кто и когда — в подсказке.
// Клик (для редакторов) переключает состояние; onToggle(tenderId, next).

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

const IconBox = ({ checked }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    {checked && <path d="M8 12.5l2.6 2.6L16 9" />}
  </svg>
)

export default function RdCheckToggle({ tender, canEdit = false, onToggle }) {
  const checked = !!tender.rd_checked
  const label = 'Проверка РД'
  const cls = `tgpub ${checked ? 'is-pub' : 'is-unpub'}`

  const title = checked
    ? `РД проверена${tender.rd_checked_by ? ` · ${tender.rd_checked_by}` : ''}${tender.rd_checked_at ? ` · ${fmtDate(tender.rd_checked_at)}` : ''}`
    : 'Отметить, что РД в тендерном пакете проверена'

  if (!canEdit) {
    return (
      <span className={`${cls} is-readonly`} title={checked ? title : 'РД не проверена'}>
        <IconBox checked={checked} /> <span>{label}</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-pressed={checked}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(tender.id, !checked) }}
    >
      <IconBox checked={checked} /> <span>{label}</span>
    </button>
  )
}
