// Статус участника тендера (tender_counterparties.status): подписи одни в реестре
// тендеров и в карточке (ParticipantStatusSelect), цвета — классы tc-st-<статус>
// в ParticipantStatusSelect.css (у тёмной темы свои).
export const PARTICIPANT_STATUS_OPTIONS = [
  { value: 'request_sent', label: 'Запрос отправлен' },
  { value: 'accepted_for_work', label: 'Принято в работу' },
  { value: 'proposal_provided', label: 'КП предоставлено' },
  { value: 'declined', label: 'Отказ' },
]

// Пустой статус — «Запрос отправлен», как значение по умолчанию в базе.
export function participantStatusKey(status) {
  return PARTICIPANT_STATUS_OPTIONS.some(o => o.value === status) ? status : 'request_sent'
}

export function participantStatusLabel(status) {
  return PARTICIPANT_STATUS_OPTIONS.find(o => o.value === status)?.label || status || ''
}
