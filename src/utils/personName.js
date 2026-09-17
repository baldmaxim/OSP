// «Костомаров Дмитрий Викторович» → «Костомаров Д. В.» — для узких столбцов
// таблиц; полное ФИО показывайте в подсказке.
export function shortPersonName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return parts[0] || ''
  return `${parts[0]} ${parts.slice(1, 3).map(x => x[0].toUpperCase() + '.').join(' ')}`
}
