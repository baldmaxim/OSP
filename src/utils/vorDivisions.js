// Подразделение, готовящее ВОР (tenders.vor_division, миграция 20260927).
//
// Одно поле тендера в двух разделах: столбец «Подразделение» в «ВОРах и РД» и
// плашка под описанием работ в реестре «Тендеры — Основное строительство».
// Правка в одном разделе видна в другом: обе страницы читают и пишут только эту
// колонку, а изменения коллег приходят онлайн-подпиской на tenders
// (useRealtimeTable). Подписи и коды — только здесь, CHECK в базе — те же коды.
export const VOR_DIVISIONS = [
  { value: 'monolith', label: 'Монолит' },
  { value: 'nvf_spk', label: 'НВФ/СПК' },
  { value: 'general', label: 'Общестроительные работы' },
  { value: 'hvac_water', label: 'ОВиВК' },
  { value: 'electrical', label: 'ЭОМ/СС' },
]

export const VOR_DIVISION_LABEL = Object.fromEntries(VOR_DIVISIONS.map(d => [d.value, d.label]))

// Значение фильтра «Подразделение» для тендеров без подразделения — в обоих
// разделах (фильтр «ВОРов и РД» и заголовок «Описание работ» реестра).
export const NO_VOR_DIVISION = '__none__'

export const DIVISION_MIGRATION_HINT = 'Подразделение недоступно: в базе не применена миграция 20260927_tender_vor_division.'

export function isMissingDivisionColumnError(err) {
  return (err?.code === '42703' || err?.code === 'PGRST204') && /vor_division/.test(String(err?.message || ''))
}

// Запись в журнал тендера о смене подразделения — одинаковая из обоих разделов.
// oldValue / next — коды (или null).
export function vorDivisionLogPayload(oldValue, next) {
  const oldLabel = VOR_DIVISION_LABEL[oldValue] || null
  const newLabel = VOR_DIVISION_LABEL[next] || null
  return {
    fieldName: 'vor_division',
    oldValue: oldLabel,
    newValue: newLabel,
    description: newLabel
      ? (oldLabel ? `Сменено подразделение ВОР: ${oldLabel} → ${newLabel}` : `Указано подразделение ВОР: ${newLabel}`)
      : `Снято подразделение ВОР (было: ${oldLabel})`,
  }
}
