// Договорные расценки целиком — для проверки файла (окно «Проверить по файлу» вкладки Larix). Читается то же
// представление, что и таблица вкладки и её выгрузка в Excel: право — раздел «Реестр расценок» (в базе).
//
// Весь реестр в браузере, а не поиск в базе на каждую строку файла: так нужный размер не теряется среди первых похожих,
// а миграция не нужна. Данные меняются раз в день, поэтому указатель живёт полчаса: второй файл проверяется сразу.
import { db } from '../api'
import { fetchAllRowsParallel } from '../utils/fetchAllRows'
import { contractIndex } from '../utils/larixRateCheck'

const VIEW = 'larix_rates_registry'
const COLS = 'id,item_name,unit,price_material,price_work,comment,project_id,project_name,contractor_id,contractor_name,'
  + 'contract_id,contract_number,contract_date,object_type,osp_contract_id'
const CACHE_MS = 30 * 60 * 1000

let cached = null // { at, promise }

// Указатель реестра (contractIndex). onProgress(прочитано строк, всего строк) — пока читается; ошибка и пустой реестр
// (нет права или ещё не было загрузки) не запоминаются.
export function loadContractIndex({ onProgress } = {}) {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.promise
  let read = 0
  let total = null
  let entry = null
  const promise = fetchAllRowsParallel(async (from, to, withCount) => {
    const res = await db.from(VIEW).select(COLS, withCount ? { count: 'exact' } : undefined).order('id').range(from, to)
    if (Number.isFinite(res.count)) total = res.count
    read += res.data?.length || 0
    onProgress?.(read, total)
    return res
  }).then(async (rows) => {
    // Построение указателя занимает около секунды — сначала отрисуем подпись.
    await new Promise((resolve) => { setTimeout(resolve) })
    if (!rows.length && cached === entry) cached = null
    return contractIndex(rows)
  })
  entry = { at: Date.now(), promise }
  cached = entry
  promise.catch(() => { if (cached === entry) cached = null })
  return promise
}
