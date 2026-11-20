// Реестр расценок → «Расценки от снабжения СУ-10» → «Загрузить из Excel» (миграция 20270224_supply_registry_import): справочники
// для распознавания, запись порциями, список загрузок и удаление загрузки. Разбор и распознавание — utils/supplyRegistryImport.
//
// Права — в базе: читает читатель реестра (сотрудник), загружает и удаляет загрузку право правки «Реестра расценок».
// Запись — функцией supply_registry_import порциями до IMPORT_CHUNK строк: первая порция заводит загрузку, следующие
// добавляются к ней; такая же расценка пропускается базой (уникальный индекс). Порция упала — уже записанное этой
// загрузкой удаляется целиком (загрузка с каскадом), чтобы файл не остался наполовину.
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { importPayload, registryRowKey } from '../utils/supplyRegistryImport'

const IMPORT_CHUNK = 500
const IMPORT_FIELDS = 'id, file_name, options, created_by_name, created_at'

// Нет таблиц или функции (миграция 20270224 не применена, шлюз их ещё не знает).
export function isMissingImport(err) {
  const msg = String(err?.message || '')
  return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(err?.code)
    || (/supply_registry_(imports|rates|import)/.test(msg) && /does not exist|schema cache|could not find|not allowed|не разрешен/i.test(msg))
}

function fail(err, text) {
  if (err?.code === '42501') throw new Error('Нет права правки реестра расценок')
  throw new Error(`${text}: ${err?.message || err}`)
}

// Есть ли загрузка в базе (миграция применена): true / false; другая ошибка — true (кнопка видна, окно скажет, в чём дело).
export async function importAvailable() {
  const { error } = await db.from('supply_registry_imports').select('id').limit(1)
  return !(error && isMissingImport(error))
}

export async function listImports() {
  const rows = await fetchAllRows((from, to) => db.from('supply_registry_imports').select(IMPORT_FIELDS)
    .order('created_at', { ascending: false }).order('id').range(from, to))
  // Число строк — у последних загрузок (их немного; окно показывает список целиком, но считать сотни незачем).
  const counted = await Promise.all(rows.slice(0, 30).map(async (r) => {
    const { count, error } = await db.from('supply_registry_rates').select('id', { count: 'exact', head: true }).eq('import_id', r.id)
    return { ...r, rows: error ? null : count ?? null }
  }))
  return [...counted, ...rows.slice(30).map((r) => ({ ...r, rows: null }))]
}

// Справочники распознавания: объекты, тендеры (без удалённых), ключи расценок реестра (показать «уже в реестре»), загрузки.
export async function loadImportContext() {
  const [objects, tenders, registry, imports] = await Promise.all([
    fetchAllRows((from, to) => db.from('objects').select('id, name').order('name').order('id').range(from, to)),
    fetchAllRows((from, to) => db.from('tenders').select('id, work_description, object_id, public_tender_number, tender_type')
      .is('deleted_at', null).order('created_at', { ascending: false }).order('id').range(from, to)),
    fetchAllRows((from, to) => db.from('supply_rates_registry').select('id, item_name, unit, price, object_id, rate_date')
      .order('id').range(from, to)),
    listImports(),
  ])
  return { objects, tenders, existing: new Set(registry.map(registryRowKey)), imports }
}

// lines — строки окна со status 'ok'. Ответ: { importId, added, skipped }. onProgress(записано строк, всего).
export async function importRegistryRates(fileName, options, lines, { onProgress } = {}) {
  let importId = null
  let added = 0
  let skipped = 0
  let done = 0
  for (let i = 0; i < lines.length; i += IMPORT_CHUNK) {
    const part = lines.slice(i, i + IMPORT_CHUNK)
    const { data, error } = await db.rpc('supply_registry_import', {
      p_import: importId, p_file_name: fileName, p_options: options || {}, p_rows: part.map(importPayload),
    })
    if (error) {
      if (importId) {
        const undo = await db.from('supply_registry_imports').delete().eq('id', importId).select('id')
        const undone = !undo.error && undo.data?.length
        fail(error, undone ? `Загрузка прервана на строке ${i + 1} из ${lines.length}, записанное этой загрузкой убрано`
          : `Загрузка прервана на строке ${i + 1} из ${lines.length}; записанные ${added} строк остались — удалите загрузку в списке`)
      }
      fail(error, 'Расценки не загружены')
    }
    const res = Array.isArray(data) ? data[0] : data
    importId = res?.import_id || importId
    added += Number(res?.added) || 0
    skipped += Number(res?.skipped) || 0
    done += part.length
    onProgress?.(done, lines.length)
  }
  // Все строки оказались уже в базе — пустая загрузка в списке не нужна (лучшее усилие).
  if (importId && added === 0) {
    await db.from('supply_registry_imports').delete().eq('id', importId)
    importId = null
  }
  return { importId, added, skipped }
}

// Удалить загрузку со всеми её строками. Правила по строкам не дают удалить без права молча (0 строк) — это тоже отказ.
export async function deleteImport(id) {
  const { data, error } = await db.from('supply_registry_imports').delete().eq('id', id).select('id')
  if (error) fail(error, 'Загрузка не удалена')
  if (!data?.length) throw new Error('Загрузка не удалена: её уже удалили или нет права правки реестра')
}
