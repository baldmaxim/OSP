// Источники окна цен позиции в расценке снабжением (utils/supplyPriceSearch), кроме цен тендеров (supplyPricing.loadOtherTenderRates).
//
// Реестр СУ-10 — загрузки из Excel и строки счетов и КП тендеров: то же представление supply_rates_registry, что вкладка «Расценки от
// снабжения СУ-10» и её «Проверить по файлу» (право — сотрудник, osp_registry_reader; подрядчику — пусто). Цены тендеров в нём — копия
// tender_vor_supply_rates (их окно берёт оттуда, с id цены), поэтому читаются только supply_import и supply_doc. Весь реестр за всё
// время (25 тыс. строк, ~8 МБ до сжатия) — не при открытии страницы, а после того как она загрузилась и затихла (решает вызывающий),
// и один раз на 10 минут для всех тендеров вкладки браузера.
import { db } from '../api'
import { fetchAllRowsParallel, fetchAllRows } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'

const VIEW = 'supply_rates_registry'
const SOURCES = ['supply_import', 'supply_doc']
const BASE_COLS = 'id,source_type,source_name,item_name,unit,price,tender_id,tender_desc,object_name,rate_date'
// Подробности (миграции 20270227 и 20270306): поставщик и ссылка на счёт загрузки, файл строки счёта. Нет колонок — без них.
const DETAIL_COLS = ',contractor_label,invoice_url,source_file,doc_id'
const CACHE_MS = 10 * 60 * 1000

let cached = null // { at, promise }

// Каждый источник — своим запросом: с отбором по одному source_type база отбрасывает остальные ветки объединения и идёт по индексу
// (замер 26.11.2026 на проде: ≈26 мс на страницу загрузок и ≈10 мс на страницу строк счетов), а отбор по обоим сразу сортирует всё
// объединение — ≈0,5 с на каждую из ≈25 страниц.
async function readRegistry(cols) {
  const parts = await Promise.all(SOURCES.map((source) => fetchAllRowsParallel((from, to, withCount) => db.from(VIEW)
    .select(cols, withCount ? { count: 'exact' } : undefined)
    .eq('source_type', source)
    .order('id').range(from, to))))
  return parts.flat()
}

// Строки реестра (как в представлении) или null — реестр не читается (нет представления, сеть). Право (раздел «Реестр расценок»)
// проверяет вызывающий до запроса: отказ шлюза ушёл бы в телеметрию ошибок при каждом открытии расценки. Ошибка не запоминается.
const isMissingColumn = (e) => ['42703', 'PGRST204'].includes(String(e?.code || ''))
export function loadRegistryPrices() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.promise
  const promise = readRegistry(BASE_COLS + DETAIL_COLS)
    .catch((e) => {
      if (isMissingColumn(e)) return readRegistry(BASE_COLS)
      throw e
    })
    .catch(() => null)
  const entry = { at: Date.now(), promise }
  cached = entry
  promise.then((rows) => { if (!rows && cached === entry) cached = null })
  return promise
}

// Реестр изменился (загрузка из Excel на вкладке реестра) — следующее окно прочитает его заново.
export function forgetRegistryPrices() {
  cached = null
}

// Документ исходной позиции цен других тендеров — для «документ: …» в окне и «Взять» (документ прикладывается к позиции, где своего
// нет): rows — строки цен тендеров (utils/supplyPriceSearch.tenderPriceRows). Ответ — Map id цены → { url, doc_id, doc_name, doc_key }
// (только у тех, где документ есть). Ошибка — пустой ответ: цена берётся и без документа.
const docCache = new Map() // id цены → документ или null
// Ключи наименований уходят в адрес запроса (предел шлюза — 8 КБ, utils/inChunks), а кириллица в адресе — по 6 байт на букву:
// порция — не больше URL_KEYS_BUDGET байт в адресе.
const URL_KEYS_BUDGET = 3000
function keysByUrlBudget(keys) {
  const out = []
  let part = []
  let size = 0
  for (const k of keys) {
    const len = encodeURIComponent(`"${k}",`).length
    if (part.length && size + len > URL_KEYS_BUDGET) {
      out.push(part)
      part = []
      size = 0
    }
    part.push(k)
    size += len
  }
  if (part.length) out.push(part)
  return out
}
export async function loadRateDocs(rows) {
  const out = new Map()
  const want = []
  for (const r of rows || []) {
    if (r.source !== 'tender') continue
    if (docCache.has(r.id)) { const d = docCache.get(r.id); if (d) out.set(r.id, d); continue }
    want.push(r)
  }
  if (!want.length) return out
  try {
    const links = []
    const tenders = [...new Set(want.map((r) => r.tenderId))]
    for (const ids of chunkList(tenders, 40)) {
      const keys = [...new Set(want.filter((r) => ids.includes(r.tenderId)).map((r) => r.materialKey))]
      for (const part of keysByUrlBudget(keys)) {
        links.push(...await fetchAllRows((from, to) => db.from('tender_supply_links')
          .select('id, tender_id, estimate_name, material_key, url, s3_document_id')
          .in('tender_id', ids).in('material_key', part)
          .order('id', { ascending: true }).range(from, to)))
      }
    }
    const byPos = new Map(links.map((l) => [`${l.tender_id}|${l.estimate_name}|${l.material_key}`, l]))
    const docIds = [...new Set(links.map((l) => l.s3_document_id).filter(Boolean))]
    const docs = new Map()
    for (const ids of chunkList(docIds, 100)) {
      const { data, error } = await db.from('s3_documents').select('id, file_name, s3_key').in('id', ids)
      if (error) throw error
      for (const d of data || []) docs.set(d.id, d)
    }
    for (const r of want) {
      const l = byPos.get(`${r.tenderId}|${r.estimateName}|${r.materialKey}`)
      const d = l?.s3_document_id ? docs.get(l.s3_document_id) : null
      const doc = d ? { url: null, doc_id: d.id, doc_name: d.file_name, doc_key: d.s3_key } : l?.url ? { url: l.url, doc_id: null, doc_name: null, doc_key: null } : null
      if (docCache.size > 5000) docCache.clear()
      docCache.set(r.id, doc)
      if (doc) out.set(r.id, doc)
    }
  } catch {
    // Документы — подсказка: без них окно и «Взять» работают.
  }
  return out
}
