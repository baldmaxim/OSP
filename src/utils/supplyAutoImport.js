// Автозагрузка позиций ВОР в расценку снабжением (без кнопки) и подстановка цены в одинаковые позиции.
// Только решения «что сделать» — без запросов; выполняет SupplyPricingPanel. Правило пользователя: сначала
// файлы ВОР из «ВОРов и РД» (лист «Материалы»), если ни один не дал позиций — вкладка «ВОР» карточки.
import { normName } from './supplyRateHelpers.js'

const baseName = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '').trim()
export const fileVersion = (doc) => `file:${doc.id}:${doc.created_at}`
// vor2 — позиции из вкладки «ВОР» отбираются по коду «мат» (isSupplyMaterial, 19.10): прежние списки (vor:…, с
// шапкой и анкетой ВОР) перечитываются один раз сами — цены не трогаются.
export const estimateVersion = (sig) => `vor2:${sig.count}:${sig.latest || ''}`

// Список из файла разобран до расчёта формул (в карте колонок нет calc), а у позиций нет объёма: в файле ВОР из Estimat объём —
// формула без сохранённого значения (18.11.2026, тендер № 772). Такой файл служба osp-api перечитывает один раз — уже с расчётом;
// после этого calc в карте есть, и без объёмов (объёма нет и в файле) список больше не трогается. volume_gaps — признак из её
// запроса (позиции она не читает), иначе — по самим позициям.
const FORMULAS_MARK = 1
export const needsVolumeRecalc = (s) => !!s && !(Number(s.column_map?.calc) >= FORMULAS_MARK)
  && (s.volume_gaps ?? (s.positions || []).some((p) => p?.volume == null && !p?.units?.length)) === true

// Имя ВОР для файла: прежняя привязка этого файла (в том числе как прежней версии ВОР — prior_document_ids, миграция
// 20261029) → ВОР карточки с тем же именем (без учёта регистра и пробелов) → прежний список с тем же именем файла →
// имя файла без расширения. Прежняя версия ВОР, которую заменили файлом с другим именем, так не заводит отдельный ВОР:
// её ВОР уже занят новым файлом, и она отмечается как устаревшая.
export function targetNameForFile(doc, sources, cardDocNames = []) {
  const bound = sources.find((s) => s.s3_document_id === doc.id)
    || sources.find((s) => Array.isArray(s.prior_document_ids) && s.prior_document_ids.includes(doc.id))
  if (bound) return bound.estimate_name
  const base = baseName(doc.file_name) || 'ВОР'
  const key = normName(base)
  const card = cardDocNames.find((n) => normName(n) === key)
  if (card) return card
  const byFile = sources.find((s) => s.file_name && normName(baseName(s.file_name)) === key)
  return byFile ? byFile.estimate_name : base
}

// Файлы, которые надо (пере)загрузить: ещё не загружены этой версией. Новые — первыми; два файла в одно
// имя ВОР — берётся новый, старый отмечается skipped (позиции дал бы устаревший файл). recalc — файлы, уже загруженные этой
// версией, но разобранные до расчёта формул и без объёмов (needsVolumeRecalc): их перечитывает только служба. Отдельно от jobs:
// страница по jobs показывает «ещё не загружены» и «не загрузился», а такой список загружен.
export function planFileImports(files, sources, cardDocNames = []) {
  const jobs = []
  const skipped = []
  const recalc = []
  const taken = new Set()
  const sorted = [...files].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  for (const doc of sorted) {
    const name = targetNameForFile(doc, sources, cardDocNames)
    const existing = sources.find((s) => s.estimate_name === name) || null
    if (taken.has(name)) { skipped.push({ doc, name }); continue }
    taken.add(name)
    if (existing && existing.s3_document_id === doc.id && existing.source_version === fileVersion(doc)) {
      if (needsVolumeRecalc(existing)) recalc.push({ doc, name, existing })
      continue
    }
    jobs.push({ doc, name, existing })
  }
  return { jobs, skipped, recalc }
}

// Вкладка «ВОР» карточки — только если позиций из файлов нет: новые ВОР и перезагруженные (другая версия).
// docs — Map(estimate_name → позиции), signatures — Map(estimate_name → { count, latest }).
export function planTabImports(sources, docs, signatures) {
  if (sources.some((s) => s.source === 'vor_file')) return []
  const jobs = []
  for (const [name, positions] of docs) {
    const existing = sources.find((s) => s.estimate_name === name) || null
    // Материалов нет: новый список не заводим, а прежний (собранный старым правилом) — обновляем до пустого.
    if (!positions.length && !existing) continue
    const version = estimateVersion(signatures.get(name) || { count: 0 })
    if (existing && existing.source_version === version) continue
    jobs.push({ name, existing, positions, version })
  }
  return jobs
}

// Списки позиций, которые больше не нужны и цен у которых нет: из вкладки «ВОР», когда появились файлы;
// от удалённого файла. С ценами — остаются (цены не трогаем никогда).
export function planCleanup(sources, rates) {
  const priced = new Set(rates.map((r) => r.estimate_name))
  const hasFiles = sources.some((s) => s.source === 'vor_file' && s.s3_document_id)
  return sources.filter((s) => !priced.has(s.estimate_name) && (
    (s.source === 'vor_tab' && hasFiles) || (s.source === 'vor_file' && !s.s3_document_id)
  ))
}

// «Полностью одинаковые» позиции: то же наименование (ключ normName) и те же единицы измерения.
export const unitSignature = (p) => (p.units ? p.units.map((u) => u.unit) : [p.unit])
  .map((u) => String(u ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).sort().join('|')
