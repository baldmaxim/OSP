import { useCallback, useState } from 'react'
import './TenderCounterpartyFiles.css'

// Галочка «Свернуть всё» над таблицей участников тендера (29.10.2026, по просьбе пользователя): в
// раскрытой строке реестра тендеров — справа от «Копировать email», во вкладке «Участники» карточки — рядом
// с «Пригласить участников». Включена — весь тендер компактно: у каждого участника вместо списка файлов
// строка-сводка (сколько КП и документов, проверка), из контактов — первый (ФИО и телефон, остальные — в
// подсказке), примечание — одной строкой, без вида работ; подрядчик — в одну-две строки. Стрелка сводки
// раскрывает КП одного участника. Выбор общий для реестра и карточки и помнится в браузере.
// (Сначала галочка сворачивала только КП — пользователь имел в виду весь тендер.)

const KEY = 'tenders:participantsCollapsed'

const read = () => {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function useParticipantsCollapsed() {
  const [collapsed, setCollapsedState] = useState(read)
  const setCollapsed = useCallback((value) => {
    setCollapsedState(value)
    try { localStorage.setItem(KEY, value ? '1' : '0') } catch { /* приватное окно */ }
  }, [])
  return [collapsed, setCollapsed]
}

const IconCheck = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export default function ParticipantsCollapseToggle({ collapsed, onChange }) {
  return (
    <label
      className={`tcpf-collapse-toggle${collapsed ? ' is-on' : ''}`}
      title={collapsed
        ? 'Показать участников полностью: КП, документы, все контакты и примечания'
        : 'Свернуть участников тендера: КП — строкой-сводкой, первый контакт, примечание одной строкой'}
    >
      <input type="checkbox" checked={collapsed} onChange={(e) => onChange(e.target.checked)} />
      <span className="tcpf-collapse-box" aria-hidden><IconCheck /></span>
      <span>Свернуть всё</span>
    </label>
  )
}
