import { useCallback, useState } from 'react'
import './TenderCounterpartyFiles.css'

// Галочка «Свернуть КП» над таблицей участников тендера (29.10.2026, по просьбе пользователя —
// раньше файлы участника прятались под «Файлы: N КП»): в раскрытой строке реестра тендеров —
// рядом с «Копировать email», во вкладке «Участники» карточки — рядом с «Пригласить участников».
// Включена — у каждого участника вместо списка файлов одна строка-сводка (сколько КП и
// документов, проверка); нажатие на сводку раскрывает только этого участника. Выбор общий для
// реестра и карточки и помнится в браузере.

const KEY = 'tenders:kpCollapsed'

const read = () => {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function useKpCollapsed() {
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

export default function KpCollapseToggle({ collapsed, onChange }) {
  return (
    <label
      className={`tcpf-collapse-toggle${collapsed ? ' is-on' : ''}`}
      title={collapsed
        ? 'Показать КП и документы всех участников'
        : 'Свернуть КП и документы участников до строки-сводки'}
    >
      <input type="checkbox" checked={collapsed} onChange={(e) => onChange(e.target.checked)} />
      <span className="tcpf-collapse-box" aria-hidden><IconCheck /></span>
      <span>Свернуть КП</span>
    </label>
  )
}
