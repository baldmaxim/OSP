// Реестр СУ-10 целиком — для проверки файла (окно «Проверить по файлу» вкладки «Расценки от снабжения СУ-10»). Читается то же
// представление, что таблица вкладки и её выгрузка в Excel: право — раздел «Реестр расценок» (в базе, osp_registry_reader).
//
// Весь реестр в браузере, а не поиск в базе на каждую строку файла: позиции ищутся тем же расчётом, что в тендерах на материалы
// (utils/supplyDocMatch), по всем наименованиям сразу, и миграция не нужна. 26 тыс. строк на 25.11.2026 — около 10 МБ до сжатия.
// Реестр меняется загрузками из Excel и пересчётом цен тендеров, поэтому указатель живёт 10 минут, а загрузка или удаление файла на
// вкладке его сбрасывают (forgetSupplyCheckIndex).
import { db } from '../api'
import { fetchAllRowsParallel } from '../utils/fetchAllRows'
import { supplyCheckIndex } from '../utils/supplyRegistryCheck'

const VIEW = 'supply_rates_registry'
const COLS = 'id,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date'
// Подробности загруженной строки (миграция 20270227): поставщик по папке и ссылка на счёт. Без миграции колонок нет — вкладка знает
// это заранее (details: false), окно читает без них.
const DETAIL_COLS = ',contractor_label,doc_number,invoice_url'
const CACHE_MS = 10 * 60 * 1000

let cached = null // { at, details, promise }

// Указатель реестра (supplyCheckIndex). onProgress(прочитано строк, всего строк) — пока читается; onIndexing() — строки прочитаны,
// строится указатель (около секунды-двух на всём реестре). Ошибка и пустой реестр не запоминаются.
export function loadSupplyCheckIndex({ details = false, onProgress, onIndexing } = {}) {
  if (cached && cached.details === details && Date.now() - cached.at < CACHE_MS) return cached.promise
  let read = 0
  let total = null
  let entry = null
  const cols = COLS + (details ? DETAIL_COLS : '')
  const promise = fetchAllRowsParallel(async (from, to, withCount) => {
    const res = await db.from(VIEW).select(cols, withCount ? { count: 'exact' } : undefined).order('id').range(from, to)
    if (Number.isFinite(res.count)) total = res.count
    read += res.data?.length || 0
    onProgress?.(read, total)
    return res
  }).then(async (rows) => {
    // Построение указателя останавливает страницу — сначала отрисуем подпись.
    onIndexing?.()
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    const index = supplyCheckIndex(rows)
    if (!index.rowCount && cached === entry) cached = null
    return index
  })
  entry = { at: Date.now(), details, promise }
  cached = entry
  promise.catch(() => { if (cached === entry) cached = null })
  return promise
}

// Реестр изменился (загрузка из Excel, удаление загрузки, пересчёт) — следующая проверка прочитает его заново.
export function forgetSupplyCheckIndex() {
  cached = null
}
