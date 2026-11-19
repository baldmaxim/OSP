// Создание заявки на проверку ДП/ДС — общее для доски (/doc-check-requests) и кнопки «+ Заявка на заключение ДП» в «Реестре по
// договорам» (19.11.2026: заявки на заключение ДП живут на доске, отдельного раздела /dp-requests нет). Запреты — в базе:
// doc_check_requests_write_guard (подающий с правом только создавать — только в «Новые заявки», работу отдела снимает) и
// s3_documents_doc_check_guard (файлы своей заявки — пока она в «Новых»).
import { db } from '../api'
import { DOC_CHECK_CONCEPT_CATEGORY } from '../utils/docCheckHelpers'
import { fetchAllRows } from '../utils/fetchAllRows'
import { uploadFile } from './s3'

// Объекты для выбора в форме: с привязкой к объектам в «Ролях» — только свои (остальное база всё равно не примет).
export const loadPickerObjects = (scopedObjectIds) => fetchAllRows((from, to) => {
  let q = db.from('objects').select('id, name, status')
  if (scopedObjectIds?.length) q = q.in('id', scopedObjectIds)
  return q.order('status', { ascending: true }).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to)
})

// Верх колонки: номер для новой карточки, когда список доски не загружен (кнопка в реестре договоров). Подающему база всё равно
// ставит заявку наверх «Новых».
export async function topSortOrder(status) {
  const { data, error } = await db
    .from('doc_check_requests')
    .select('sort_order')
    .eq('status', status)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data?.[0]?.sort_order || 0) + 1
}

// files — [{ file, category }]: строки ещё нет, поэтому сначала заявка, затем файлы. Файл не загрузился — заявка остаётся (подающий
// добавит его в окне заявки, пока она в «Новых»), остальные грузятся. → { id, failed: [{ name, category, message }] }.
export async function createDocCheckRequest({ payload, status, sortOrder, author, files = [] }) {
  const { data, error } = await db
    .from('doc_check_requests')
    .insert({ ...payload, status, sort_order: sortOrder, created_by_name: author })
    .select('id')
    .single()
  if (error) throw error
  const failed = []
  for (const { file, category } of files) {
    try {
      await uploadFile({ file, ownerType: 'doc_check_request', ownerId: data.id, category })
    } catch (err) {
      failed.push({ name: file.name, category, message: err?.message || String(err) })
    }
  }
  return { id: data.id, failed }
}

// Текст о незагруженных файлах. Понятийное соглашение — отдельной строкой: без него заявка на заключение ДП неполная.
export function failedFilesText(failed) {
  if (!failed?.length) return ''
  const lines = failed.map(f => `${f.name}: ${f.message}`)
  const concept = failed.some(f => f.category === DOC_CHECK_CONCEPT_CATEGORY)
  return `Заявка создана, но не все файлы загрузились:\n${lines.join('\n')}`
    + (concept ? '\n\nПонятийное соглашение добавьте в окне заявки («Документы»), пока она в «Новых заявках».' : '')
}
