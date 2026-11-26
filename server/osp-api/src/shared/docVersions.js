// КОПИЯ src/utils/docVersions.js — не править здесь: правка в оригинале, затем node scripts/sync-osp-api-shared.mjs
// Версии файлов списка (s3_documents.version_group_id, миграция 20270307; решение пользователя 26.11.2026): новую версию ВОР
// прикрепляют к прежнему файлу, а не отдельным документом. Группа — файлы с одним version_group_id; без группы (NULL) — файл
// сам по себе, группа из одного файла — тоже обычный файл.
//
// Номер версии не хранится: порядок по времени загрузки внутри группы (created_at, затем id) — версия 1 самая ранняя,
// последняя — текущая. Удалили версию — следующие сдвигаются (1, 3 → 1, 2), порядок прежний. Так же «текущую» выбирает база
// для кабинета подрядчика (bid_vor_superseded, миграция 20270307) — правила не должны расходиться.
//
// Общий модуль страницы и службы osp-api (scripts/sync-osp-api-shared.mjs): по нему и окно «ВОРы и РД», и автозагрузка позиций
// снабжения (supplyAutoImport) понимают, какой файл текущий.
import { normName } from './supplyRateHelpers.js'

// Колонка группы есть (миграция применена): списки читаются через «*» или с колонкой — достаточно ключа в строке.
export const hasVersionColumn = (docs) => (docs || []).some((d) => d && Object.hasOwn(d, 'version_group_id'))

const groupKeyOf = (d) => (d.version_group_id ? `g:${d.version_group_id}` : `d:${d.id}`)
const timeOf = (d) => {
  const t = Date.parse(d?.created_at || '')
  return Number.isNaN(t) ? 0 : t
}
// Раньше загружен — раньше в группе. Одна миллисекунда — по строке времени (микросекунды базы), затем по id.
export const olderFirst = (a, b) => timeOf(a) - timeOf(b)
  || String(a.created_at || '').localeCompare(String(b.created_at || ''))
  || String(a.id).localeCompare(String(b.id))

// Группы списка: [{ key, groupId, versions: [{ doc, no }] от первой к последней, current, count }], сначала группы с самой
// свежей текущей версией (как прежний список «новые сверху»).
export function versionGroups(docs) {
  const byKey = new Map()
  for (const d of docs || []) {
    if (!d) continue
    const k = groupKeyOf(d)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(d)
  }
  const groups = []
  for (const [key, list] of byKey) {
    list.sort(olderFirst)
    groups.push({
      key,
      groupId: list[0].version_group_id || null,
      versions: list.map((doc, i) => ({ doc, no: i + 1 })),
      current: list[list.length - 1],
      count: list.length,
    })
  }
  return groups.sort((a, b) => olderFirst(b.current, a.current))
}

// Только текущие версии (для «Скачать всё», счётчиков, снабжения).
export const currentVersions = (docs) => versionGroups(docs).map((g) => g.current)

// Текущие версии с перечнем id всех версий группы (version_ids, от первой к текущей): по ним снабжение узнаёт ВОР, к которому
// был привязан прежний файл (supplyAutoImport.targetNameForFile).
export const currentWithVersionIds = (docs) => versionGroups(docs)
  .map((g) => ({ ...g.current, version_ids: g.versions.map((v) => v.doc.id) }))

// Имя без отметок редакции: «ВОР ОВ изм.1», «ВОР ОВ v2», «ВОР ОВ от 03.11.2026 версия 2», «ВОР ОВ (1)», «ВОР_ОВ» — одно «ВОР ОВ»
// (в виде ключа normName: без регистра, пробелов и знаков). Номер раздела («ЭОМ-3», «14.6») — не отметка: остаётся.
// Им же снабжение решает, спросить ли «новая версия?» (supplyVorVersions.versionQuestions).
const VERSION_MARKS = [
  /(^|[\s([,;.-])(?:v|ver|версия|вер|ред|редакция|изм|изменение|rev)\s*\.?\s*№?\s*\d+(?:\.\d+)?(?=$|[\s)\],;.-])/gu,
  /(^|\s)от\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?=$|[\s),;])/gu,
  /(^|[\s(])\d{1,2}\.\d{1,2}\.\d{4}(?=$|[\s),;])/gu,
  /(^|[\s(])\d{4}-\d{2}-\d{2}(?=$|[\s),;])/gu,
  /(\s*)\(\d{1,2}\)\s*$/u,
]
export function versionlessName(name) {
  let s = String(name ?? '').normalize('NFC').toLowerCase().replace(/_+/g, ' ')
  for (const re of VERSION_MARKS) s = s.replace(re, '$1 ')
  return normName(s)
}

const baseName = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '').trim()
// Excel в любом виде — один вид файла; остальное — по расширению.
const kindOf = (fileName) => {
  const ext = (/\.([^.]+)$/.exec(String(fileName || '').toLowerCase()) || [])[1] || ''
  return /^xls[xmb]?$/.test(ext) ? 'excel' : ext
}

// Новый файл похож на новую версию файла списка: тот же вид файла и то же имя без отметок редакции («ВОР ОВ» → «ВОР ОВ изм.1»,
// «ВОР 2026-10-09» → «ВОР 2026-11-20»). → группа или null; похожих несколько — null: выбирает человек. Только подсказка —
// загружается так, как выбрал человек.
export function suggestVersionGroup(fileName, groups) {
  const key = versionlessName(baseName(fileName))
  if (!key) return null
  const kind = kindOf(fileName)
  const hits = (groups || []).filter((g) => g.versions.some((v) => kindOf(v.doc.file_name) === kind
    && versionlessName(baseName(v.doc.file_name)) === key))
  return hits.length === 1 ? hits[0] : null
}

// Ответ базы «колонки версий нет» (миграция 20270307 не применена): чтение — 42703, запись — PGRST204.
export const isMissingVersionColumn = (err) => (err?.code === '42703' || err?.code === 'PGRST204')
  && /version_group_id/.test(String(err?.message || ''))

// Список без прежних версий: в группе — последняя версия каждого вида (книга Excel отдельно от прочих: подрядчику ведомость нужна
// в Excel — так же текущую выбирает bid_vor_superseded). Файлы без группы — все, порядок списка прежний.
const isWorkbook = (d) => /\.(xlsx|xlsm|xls)$/i.test(String(d?.file_name || ''))
export function withoutOlderVersions(docs) {
  const latest = new Map()
  for (const d of docs || []) {
    if (!d?.version_group_id) continue
    const k = `${d.version_group_id}|${isWorkbook(d)}`
    const was = latest.get(k)
    if (!was || olderFirst(was, d) < 0) latest.set(k, d)
  }
  return (docs || []).filter((d) => !d?.version_group_id || latest.get(`${d.version_group_id}|${isWorkbook(d)}`) === d)
}
