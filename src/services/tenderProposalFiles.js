// Сервис для работы с файлами КП/документов по тендеру (task 290).
// Промежуточный слой поверх s3.js — добавляет метаданные file_kind / proposal_group_id /
// version_label, чтобы выделять «коммерческое предложение» и группировать его версии.
import { supabase } from '../supabase'
import { deleteDocument, uploadFile } from './s3'
import { fetchAllRows } from '../utils/fetchAllRows'

// task 431: статусы проверки КП аналитиком-экономистом.
export const KP_REVIEW_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  HAS_REMARKS: 'has_remarks',
}
export const KP_REVIEW_LABEL = {
  pending: 'На проверке',
  approved: 'Проверено',
  has_remarks: 'Есть замечания',
}

// Возвращает структуру для UI:
//   {
//     proposals: [{ groupId, latest, older: [...] }, ...]  // группы КП, в каждой последняя версия впереди
//     attachments: [...]                                   // прочие документы (новые сверху)
//   }
export async function fetchProposalFiles(tenderId, counterpartyId) {
  if (!tenderId || !counterpartyId) return { proposals: [], attachments: [] }

  const { data, error } = await supabase
    .from('tender_proposal_files')
    .select('*, s3:s3_documents!s3_document_id(*), review_note_s3:s3_documents!review_note_s3_document_id(*)')
    .eq('tender_id', tenderId)
    .eq('counterparty_id', counterpartyId)
    .order('created_at', { ascending: false })

  if (error) throw error

  const proposalsMap = new Map()
  const attachments = []
  for (const row of data || []) {
    if (row.file_kind === 'attachment') {
      attachments.push(row)
    } else {
      // Должен быть proposal_group_id; на всякий случай fallback на row.id —
      // тогда КП без группы будет одиночным элементом.
      const key = row.proposal_group_id || row.id
      if (!proposalsMap.has(key)) proposalsMap.set(key, [])
      proposalsMap.get(key).push(row)
    }
  }

  const proposals = Array.from(proposalsMap.entries()).map(([groupId, files]) => ({
    groupId,
    latest: files[0],          // newest version
    older: files.slice(1),     // older versions (already DESC by created_at)
  }))
  // Группы — самые свежие сверху (по дате последней версии).
  proposals.sort((a, b) => new Date(b.latest.created_at) - new Date(a.latest.created_at))

  return { proposals, attachments }
}

// Загружает файл в S3 и регистрирует в tender_proposal_files.
// fileKind: 'commercial_proposal' | 'attachment'
// proposalGroupId: для нового КП — null (сгенерируется новая группа);
//                  для вариации к существующему КП — передать groupId этой группы.
export async function addProposalFile({
  tenderId,
  counterpartyId,
  file,
  fileKind,
  proposalGroupId = null,
  versionLabel = null,
}) {
  const s3doc = await uploadFile({ file, ownerType: 'tender', ownerId: tenderId })

  const group_id =
    fileKind === 'commercial_proposal'
      ? (proposalGroupId || crypto.randomUUID())
      : null

  const { data, error } = await supabase
    .from('tender_proposal_files')
    .insert({
      tender_id: tenderId,
      counterparty_id: counterpartyId,
      s3_document_id: s3doc.id,
      file_kind: fileKind,
      proposal_group_id: group_id,
      version_label: versionLabel?.trim() || null,
    })
    .select('*, s3:s3_documents!s3_document_id(*)')
    .single()

  if (error) {
    // Откат: если в БД не легло — убираем уже залитый S3-объект и s3_documents-запись.
    try { await deleteDocument(s3doc) } catch { /* best effort */ }
    throw error
  }
  return data
}

// task 431: проставить результат проверки КП аналитиком.
// status: 'approved' (проверено, ОК) | 'has_remarks' (есть замечания) | 'pending' (вернуть на проверку).
// Замечания (review_note) и файл замечаний сохраняются только для has_remarks.
// Опциональный файл замечаний:
//   remarksFile        — новый File для загрузки (заменяет текущий);
//   removeRemarksFile  — снять текущий файл без загрузки нового;
//   tenderId           — владелец S3 при загрузке (owner_type='tender');
//   currentRemarksDoc  — текущая запись s3_documents файла замечаний (для замены/очистки).
export async function setProposalReview(fileId, {
  status,
  note = '',
  reviewer = '',
  remarksFile = null,
  removeRemarksFile = false,
  tenderId = null,
  currentRemarksDoc = null,
}) {
  // Вычисляем итоговую ссылку на файл замечаний.
  let uploadedDoc = null
  let noteDocId = currentRemarksDoc?.id || null
  if (status !== 'has_remarks') {
    noteDocId = null // нет замечаний → файла тоже нет
  } else if (remarksFile) {
    uploadedDoc = await uploadFile({ file: remarksFile, ownerType: 'tender', ownerId: tenderId })
    noteDocId = uploadedDoc.id
  } else if (removeRemarksFile) {
    noteDocId = null
  }

  const payload = {
    review_status: status,
    review_note: status === 'has_remarks' ? (note?.trim() || null) : null,
    reviewed_at: status === 'pending' ? null : new Date().toISOString(),
    reviewed_by: status === 'pending' ? null : (reviewer?.trim() || null),
    review_note_s3_document_id: noteDocId,
  }
  const { data, error } = await supabase
    .from('tender_proposal_files')
    .update(payload)
    .eq('id', fileId)
    .select('*, s3:s3_documents!s3_document_id(*), review_note_s3:s3_documents!review_note_s3_document_id(*)')
    .single()
  if (error) {
    // Откат только что залитого файла, если запись не прошла.
    if (uploadedDoc) { try { await deleteDocument(uploadedDoc) } catch { /* best effort */ } }
    throw error
  }
  // Старый файл замечаний больше не нужен (заменён или снят) — убираем из S3,
  // чтобы не оставлять orphan (запись уже разлинкована апдейтом выше).
  if (currentRemarksDoc?.id && currentRemarksDoc.id !== noteDocId && currentRemarksDoc.s3_key) {
    try { await deleteDocument(currentRemarksDoc) } catch { /* best effort */ }
  }
  return data
}

// task 431 (цепочка замечаний): инженер отмечает, что замечания по КП отправлены
// Отметка «занесено в сводную таблицу» — промежуточный этап между проверкой
// аналитиком и отправкой замечаний контрагенту. Нужен обеим веткам: и КП без
// замечаний, и КП с замечаниями сначала попадают в сводную.
export async function setSummaryAdded(fileId, { added, author = '' }) {
  const payload = added
    ? { summary_added: true, summary_added_at: new Date().toISOString(), summary_added_by: author?.trim() || null }
    : { summary_added: false, summary_added_at: null, summary_added_by: null }
  const { data, error } = await supabase
    .from('tender_proposal_files')
    .update(payload)
    .eq('id', fileId)
    .select('*, s3:s3_documents!s3_document_id(*), review_note_s3:s3_documents!review_note_s3_document_id(*)')
    .single()
  if (error) throw error
  return data
}

// контрагенту (sent=true) или снимает отметку (sent=false). sender — ФИО/e-mail.
export async function setRemarksSent(fileId, { sent, sender = '' }) {
  const payload = sent
    ? { remarks_sent: true, remarks_sent_at: new Date().toISOString(), remarks_sent_by: sender?.trim() || null }
    : { remarks_sent: false, remarks_sent_at: null, remarks_sent_by: null }
  const { data, error } = await supabase
    .from('tender_proposal_files')
    .update(payload)
    .eq('id', fileId)
    .select('*, s3:s3_documents!s3_document_id(*), review_note_s3:s3_documents!review_note_s3_document_id(*)')
    .single()
  if (error) throw error
  return data
}

// task 431: очередь КП на проверку (вкладка «Проверка КП»). Тянет все КП-файлы
// (file_kind='commercial_proposal') с джойном тендера/объекта/контрагента/ответственного.
// statuses — массив статусов (null = все); objectIds — ограничение по объектам (scope сотрудника).
export async function fetchProposalFilesForReview({ statuses = null, objectIds = null } = {}) {
  return fetchAllRows((from, to) => {
    let q = supabase
      .from('tender_proposal_files')
      .select(`id, tender_id, counterparty_id, version_label, created_at,
               review_status, review_note, reviewed_at, reviewed_by, review_required,
               remarks_sent, remarks_sent_at, remarks_sent_by,
               summary_added, summary_added_at, summary_added_by,
               s3:s3_documents!s3_document_id(*),
               review_note_s3:s3_documents!review_note_s3_document_id(*),
               counterparties(name),
               tenders!inner(id, work_description, object_id, objects(name),
                 responsible_contact:contacts!responsible_contact_id(full_name))`)
      .eq('file_kind', 'commercial_proposal')
      // Только КП, загруженные с момента запуска (легаси-бэклог в очередь не попадает).
      .eq('review_required', true)
    if (statuses && statuses.length) q = q.in('review_status', statuses)
    if (objectIds && objectIds.length) q = q.in('tenders.object_id', objectIds)
    return q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)
  })
}

// Удаляет файл КП/документа. ON DELETE CASCADE на FK s3_document_id снесёт строку
// tender_proposal_files автоматически вслед за s3_documents.
export async function deleteProposalFile(file) {
  const s3doc = file.s3
  if (!s3doc?.id || !s3doc?.s3_key) {
    throw new Error('deleteProposalFile: ожидается file.s3 со связкой s3_documents')
  }
  // Прикреплённый файл замечаний не удаляется каскадом (он лишь SET NULL) — сносим явно,
  // иначе останется orphan в S3 после удаления самого КП.
  const remarksDoc = file.review_note_s3
  if (remarksDoc?.id && remarksDoc?.s3_key) {
    try { await deleteDocument(remarksDoc) } catch { /* best effort */ }
  }
  await deleteDocument(s3doc)
}
