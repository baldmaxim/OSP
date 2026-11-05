// Победители тендера для показа: строки tender_winners (несколько — при разделении по корпусам и системам), а если их
// нет — основной победитель tenders.winner_counterparty_id. Выборка — TENDER_WINNERS_SELECT.
export const TENDER_WINNERS_SELECT = 'winner_counterparty_id, winner:counterparties!winner_counterparty_id(id, name), tender_winners(counterparty_id, scope_note, counterparties(id, name))'

export function tenderWinnersOf(tender) {
  const rows = tender?.tender_winners || []
  if (rows.length > 0) {
    return rows.map(w => ({ id: w.counterparty_id, name: w.counterparties?.name || '—', scope: w.scope_note || '' }))
  }
  return tender?.winner ? [{ id: tender.winner.id, name: tender.winner.name, scope: '' }] : []
}

// База без таблицы победителей или связи с ней: выборка без них, страница работает.
export const isMissingWinnersError = (err) => ['PGRST200', 'PGRST205', '42P01'].includes(String(err?.code || ''))
  && /winner/i.test(String(err?.message || '') + String(err?.details || ''))
