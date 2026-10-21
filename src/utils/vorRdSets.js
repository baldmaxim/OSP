// Правила комплектов РД «ВОРов и РД» без обращения к базе (их проверяет и тест без
// браузера — tests/tender/vor-rd-sets.test.mjs). Запись и чтение — services/vorRdSets.js.

// Ключ владельца: id тендера или заявки (строки «ВОРов и РД» и так различаются по id).
export const rdSetOwnerId = (set) => set.tender_id || set.vor_request_id

// Порядок в списке — он же № п/п.
export function compareRdSets(a, b) {
  return (a.sort_order - b.sort_order)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id).localeCompare(String(b.id))
}

// Адрес http(s) или сетевой путь \\сервер\папка — то же правило, что CHECK в базе.
export function isValidRdLink(value) {
  const v = String(value || '').trim()
  return v.length <= 2000 && /^(https?:\/\/\S|\\\\\S)/i.test(v)
}
