// task 398/406/407/408: общие хелперы сопоставления расценок снабжения (tender_vor_supply_rates)
// с материалами ВОР. Вынесены из TenderDetailPage, чтобы TenderProposalsCompare
// («Сравнение КП») считал ключ расценки ИДЕНТИЧНО — иначе колонка «Цена от снабжения»
// в сравнении не совпала бы с тем, что показывает вкладка «Расценки снабжения».

// task 406/407: нормализация наименования для сопоставления расценок снабжения и
// материалов ВОР. Имена «выглядят одинаково», но не совпадали из-за невидимых отличий:
// символ диаметра (Ø/∅/⌀/Ө в разных файлах), десятичная запятая vs точка, латиница/кириллица.
// Детерминированно (без нечёткости): 1) NFC+lower; 2) десятичный разделитель → точка
// (цифры/разрядность сохраняем, чтобы Ø12,7 ≠ Ø1,27); 3) кириллические гомоглифы → латиница
// (только реально неразличимые буквы); 4) выбросить всё, кроме латиницы/кириллицы/цифр/точки —
// это единообразно удаляет ЛЮБОЙ символ диаметра, пробелы и пунктуацию на обеих сторонах.
const NN_HOMOGLYPH = { а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' }
const computeNormName = (s) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1.$2')
    .replace(/[авеёкмнорстух]/g, (c) => NN_HOMOGLYPH[c])
    .replace(/[^a-zа-я0-9.]+/g, '')

// Кэш: таблицы «Сравнение КП» и снабжения зовут нормализацию по нескольку раз на
// каждую позицию при каждой перерисовке, а функция чистая и дорогая (NFC + 3 regex).
const NN_CACHE = new Map()
const NN_CACHE_LIMIT = 100000
export const normName = (s) => {
  const key = String(s ?? '')
  let value = NN_CACHE.get(key)
  if (value === undefined) {
    value = computeNormName(key)
    if (NN_CACHE.size >= NN_CACHE_LIMIT) NN_CACHE.clear()
    NN_CACHE.set(key, value)
  }
  return value
}

// task 398: ключ расценки снабжения — (ВОР-документ ∣ наименование материала, нормализованное).
export const supplyKey = (estimateName, name) =>
  `${estimateName || 'Основная смета'}∣${normName(name)}`

// task 409: загруженная из файла снабжения цена — это ЦЕНА ЗА ЕДИНИЦУ (supply_price).
// Возвращает её, либо null если расценки нет / цена не положительная (0/пусто/нечисло).
export const supplyUnitPrice = (ratesMap, estimateName, name) => {
  const p = ratesMap?.get(supplyKey(estimateName, name))
  return p != null && Number.isFinite(Number(p)) && Number(p) > 0 ? Number(p) : null
}

// task 409: итог от снабжения = объём материалов × цена за единицу.
// null, если нет цены или объём отсутствует/некорректен/<=0 (не считаем ошибочно).
export const supplyTotal = (unitPrice, volume) => {
  const v = Number(volume)
  if (unitPrice == null || !Number.isFinite(v) || v <= 0) return null
  return unitPrice * v
}

// Миграция 20261020: цена за единицу для расчёта сумм. Когда снабжение вводило итоговую сумму, база хранит
// точную цену (сумма / объём) рядом с ценой в копейках — по ней сумма в карточке совпадает с введённой.
// Прежние строки и импорт Excel — только supply_price.
export const rateUnitPrice = (r) => {
  const exact = r?.supply_price_exact
  if (exact != null && exact !== '' && Number.isFinite(Number(exact))) return Number(exact)
  return Number(r?.supply_price)
}

// Миграция 20261023: день расценки — по Москве; из других тендеров берутся цены не старше 3 месяцев по дням
// (граница включительно), как в базе: дата ≥ сегодня − 3 месяца (конец месяца — как в PostgreSQL: 31.05 → 28.02).
export const moscowToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now)

export function freshSince(today) {
  const [y, m, d] = String(today).split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 - 3, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(d, last))
  return first.toISOString().slice(0, 10)
}

export const isFreshPriceDate = (date, today = moscowToday()) => !!date && String(date).slice(0, 10) >= freshSince(today)

// «2026-10-12» → «12.10.2026».
export const fmtPriceDate = (date) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}
