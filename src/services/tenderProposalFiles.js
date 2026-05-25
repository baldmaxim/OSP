// Сервис для работы с файлами КП/документов по тендеру (task 290).
// Промежуточный слой поверх s3.js — добавляет метаданные file_kind / proposal_group_id /
// version_label, чтобы выделять «коммерческое предложение» и группировать его версии.
import { supabase } from '../supabase'
import { deleteDocument, uploadFile } from './s3'

// Возвращает структуру для UI:
//   {
//     proposals: [{ groupId, latest, older: [...] }, ...]  // группы КП, в каждой последняя версия впереди
//     attachments: [...]                                   // прочие документы (новые сверху)
//   }
export async function fetchProposalFiles(tenderId, counterpartyId) {
  if (!tenderId || !counterpartyId) return { proposals: [], attachments: [] }

  const { data, error } = await supabase
    .from('tender_proposal_files')
    .select('*, s3:s3_documents!s3_document_id(*)')
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

// Удаляет файл КП/документа. ON DELETE CASCADE на FK s3_document_id снесёт строку
// tender_proposal_files автоматически вслед за s3_documents.
export async function deleteProposalFile(file) {
  const s3doc = file.s3
  if (!s3doc?.id || !s3doc?.s3_key) {
    throw new Error('deleteProposalFile: ожидается file.s3 со связкой s3_documents')
  }
  await deleteDocument(s3doc)
}
