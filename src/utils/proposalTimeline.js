// Лента файлов участника тендера — ячейка «КП / Документы» (TenderCounterpartyFiles)
// в раскрытой строке реестра тендеров и во вкладке «Участники» карточки.
//
// КП и документы идут по времени загрузки: старые сверху, новые снизу — так видно,
// когда и в каком порядке подрядчик присылал КП. Версии одного КП (общий
// proposal_group_id) нумеруются по порядку загрузки; последняя версия — текущая,
// у прежних — дата, когда их заменила следующая. Проверяет
// tests/tender/participant-files.test.mjs.

const time = (row) => {
  const t = new Date(row?.created_at).getTime()
  return Number.isNaN(t) ? 0 : t
}

// Старые сверху; одна и та же секунда — по id, чтобы порядок не прыгал между загрузками.
export function byUploadTime(a, b) {
  return time(a) - time(b) || String(a.id).localeCompare(String(b.id))
}

// rows — строки tender_proposal_files одного участника (с встраиванием s3).
// Возвращает { proposals: [{ file, version, versions, replacedAt, groupId }], attachments: [row] }.
export function buildFilesTimeline(rows) {
  const sorted = [...(rows || [])].sort(byUploadTime)
  const groups = new Map()
  for (const row of sorted) {
    if (row.file_kind === 'attachment') continue
    // КП без группы (не должно быть) — одиночная версия.
    const key = row.proposal_group_id || row.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const proposals = []
  const attachments = []
  for (const row of sorted) {
    if (row.file_kind === 'attachment') {
      attachments.push(row)
      continue
    }
    const groupId = row.proposal_group_id || row.id
    const group = groups.get(groupId)
    const i = group.indexOf(row)
    proposals.push({
      file: row,
      groupId,
      version: i + 1,
      versions: group.length,
      replacedAt: i < group.length - 1 ? group[i + 1].created_at : null,
    })
  }
  return { proposals, attachments }
}

// Текущие (последние) версии КП участника — варианты «новая версия КП …» в окне загрузки.
export function currentProposals(proposals) {
  return proposals.filter(p => !p.replacedAt)
}

// КП участника по группам версий (29.10.2026, «чтобы было видно структуру КП»): каждое КП —
// свой блок, в нём версии по порядку загрузки, последняя — текущая. КП — по первой загрузке,
// старые сверху. proposals — из buildFilesTimeline. Возвращает [{ groupId, items, current }].
export function groupProposals(proposals) {
  const groups = new Map()
  for (const p of proposals || []) {
    if (!groups.has(p.groupId)) groups.set(p.groupId, { groupId: p.groupId, items: [] })
    groups.get(p.groupId).items.push(p)
  }
  return [...groups.values()].map(g => ({ ...g, current: g.items[g.items.length - 1] }))
}

// Проверка текущих версий КП — для свёрнутой ячейки: сколько проверено, с замечаниями, ждёт
// проверки. КП без проверки (review_required не true) не считаются.
export function reviewSummary(groups) {
  const sum = { approved: 0, has_remarks: 0, pending: 0 }
  for (const { current } of groups || []) {
    const file = current?.file
    if (file?.review_required !== true) continue
    const status = file.review_status || 'pending'
    sum[status in sum ? status : 'pending'] += 1
  }
  return sum
}
