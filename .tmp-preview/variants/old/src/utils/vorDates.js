// Срок подготовки ВОР: начало — дата создания тендера (не вводится вручную),
// окончание — tenders.vor_end_date. Прежнее поле vor_start_date больше не
// показывается: у старых тендеров там могли стоять произвольные даты.

// created_at (timestamptz) → 'YYYY-MM-DD' по местному времени: тендер, созданный
// в 01:00 по Москве, не должен «начинаться» накануне из-за UTC.
export function vorStartDate(tender) {
  if (!tender?.created_at) return null
  const d = new Date(tender.created_at)
  if (Number.isNaN(d.getTime())) return null
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
