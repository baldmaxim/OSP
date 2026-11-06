// Откуда цена, скопированная из другого тендера (окно SupplyPriceOriginDialog). Только решения, без запросов.
//
// Документ цены — то, что прикреплено к исходной позиции (колонка «Документ», tender_supply_links). Его часто нет: на копии 05.11.2026
// документ есть у 107 своих цен из 1 232. Но цену могли взять из счёта, загруженного к тендеру целиком, не прикрепив к позиции,
// поэтому ищем её и в строках счетов и КП исходного тендера. Найденное — предположение: так и пишем на экране.
import { normName } from './supplyRateHelpers.js'
import { nameScore } from './supplySimilarity.js'

const PRICE_NEAR = 0.005
const NAME_MIN = 0.5

// Строки документов исходного тендера, откуда могла прийти цена: то же наименование (или выбрано для этой позиции) либо та же цена
// при похожем наименовании. offers — [{ doc, offer }]. Ответ — [{ doc, line, sameName, samePrice }], самые вероятные первыми.
export function priceSourceLines(offers, { name, price }) {
  const key = normName(name)
  const out = []
  for (const { doc, offer } of offers || []) {
    for (const line of offer.lines || []) {
      const sameName = line.k === key || !!line.also?.includes(key) || normName(line.name) === key
      const samePrice = price > 0 && Math.abs(line.price - price) <= Math.max(0.01, price * PRICE_NEAR)
      if (sameName || (samePrice && nameScore(line.name, name) >= NAME_MIN)) out.push({ doc, line, sameName, samePrice })
    }
  }
  const rank = (x) => (x.sameName && x.samePrice ? 3 : x.samePrice ? 2 : 1)
  return out.sort((a, b) => rank(b) - rank(a))
}

// Как цена попала в исходный тендер (price_input): человек ввёл сам или она пришла из Excel; колонки ещё не было — до 16.10.2026.
export function priceInputText(input) {
  if (input === 'unit' || input === 'total') return 'цену ввели вручную'
  if (input === 'import') return 'цена загружена из Excel-файла'
  return 'цена загружена до 16.10.2026, когда файлы к ценам не прикреплялись'
}
