import './BlacklistMark.css'

// «ЧС» рядом с названием контрагента из чёрного списка (counterparties.status = 'blacklist'): маленькая плашка с
// красной обводкой, как у аффилированных компаний в карточке контрагента (решение пользователя 06.11.2026 — участники
// и победители в «Тендерах»). Стили — свои: страница может открыться без CSS «Контрагентов».
export default function BlacklistMark({ status }) {
  if (status !== 'blacklist') return null
  return <span className="bl-mark" title="Контрагент в чёрном списке">ЧС</span>
}
