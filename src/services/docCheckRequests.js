// Создание заявки на проверку ДП/ДС — общее для доски (/doc-check-requests) и кнопки «+ Заявка на заключение ДП» в «Реестре по
// договорам» (19.11.2026: заявки на заключение ДП живут на доске, отдельного раздела /dp-requests нет). Запреты — в базе:
// doc_check_requests_write_guard (подающий с правом только создавать — только в «Новые заявки», работу отдела снимает) и
// s3_documents_doc_check_guard (файлы своей заявки — пока она в «Новых»).
import { db } from '../api'
import { DOC_CHECK_CONCEPT_CATEGORY, TENDER_FIELD, isMissingBoardColumn } from '../utils/docCheckHelpers'
import { fetchAllRows } from '../utils/fetchAllRows'
import { uploadFile } from './s3'

// Тендеры для привязки «Заключения ДП» (20270221) — те же колонки, что у выбора тендера в форме договора: их шлюз отдаёт и с правом
// «Договоры» (просмотр), а оно есть у подающих (руководитель строительства, экономист объекта) и у отдела. Постранично: тендеров
// больше тысячи. Нет права читать тендеры — отказ (вызывающий показывает тендер без номера).
export const loadPickerTenders = () => fetchAllRows((from, to) => db
  .from('tenders')
  .select('id, object_id, work_description, winner_counterparty_id, status, public_tender_number, parent_tender_id, deleted_at')
  .order('created_at', { ascending: false })
  .order('id', { ascending: true })
  .range(from, to))

// Есть ли у заявок колонка тендера (миграция 20270221): там, где выборки доски нет (кнопка в «Реестре по договорам»). До миграции
// поле не показывается и не пишется — иначе вставка упала бы на неизвестной колонке. Ошибка другого рода — тоже «нет»: заявку
// без тендера подать можно, а с ошибкой — нет.
export async function hasTenderColumn() {
  const { error } = await db.from('doc_check_requests').select(`id, ${TENDER_FIELD}`).limit(1)
  if (error && !isMissingBoardColumn(error)) console.warn('Колонку тендера заявок проверить не удалось:', error.message)
  return !error
}

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
