// Массовая загрузка ПСДЦ: сопоставление имени файла с документом.
//
// Документ назначается автоматически ТОЛЬКО при одном однозначном совпадении:
//   • явный глобальный ID в имени: «ID 123», «ИД_123», «id-123»;
//   • номер договора целиком, как отдельный фрагмент имени (не короче 3
//     символов или с буквами — «1», «12» слишком легко совпадают случайно);
//   • номер ДС («ДС 3», «доп. соглашение № 3») внутри дерева найденного договора.
// Название контрагента или похожее название работ основанием не являются.
// Если кандидатов несколько — это «неоднозначно», документ не назначается.

const EXT_RE = /\.(xlsx|xlsm|xls)$/i

export function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/№/g, ' ')
    .replace(/[^\p{L}\p{N}.-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

const BOUNDARY = new Set(['_', '-', '.'])

// Фрагмент встречается в имени целиком: слева и справа граница или край строки.
function containsToken(haystack, needle) {
  if (!needle) return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? '_' : haystack[at - 1]
    const afterIdx = at + needle.length
    const after = afterIdx >= haystack.length ? '_' : haystack[afterIdx]
    if (BOUNDARY.has(before) && BOUNDARY.has(after)) return true
    from = at + 1
  }
}

const strongNumber = (n) => n.length >= 3 || /\p{L}/u.test(n)

// docs: [{ id, display_id, record_type, contract_number, root_contract_id, deleted_at, … }]
export function buildDocumentMatcher(docs) {
  const live = (docs || []).filter((d) => !d.deleted_at)
  const byDisplayId = new Map(live.map((d) => [String(d.display_id), d]))
  const contracts = []
  const amendmentsByRoot = new Map()
  for (const d of live) {
    const number = normalizeForMatch(d.contract_number)
    if (d.record_type === 'dp') {
      if (number && strongNumber(number)) contracts.push({ doc: d, number })
    } else if (number) {
      const root = d.root_contract_id || d.parent_contract_id
      if (!amendmentsByRoot.has(root)) amendmentsByRoot.set(root, [])
      amendmentsByRoot.get(root).push({ doc: d, number })
    }
  }
  return { byDisplayId, contracts, amendmentsByRoot }
}

export function matchFileName(fileName, matcher) {
  const base = String(fileName || '').replace(EXT_RE, '')
  const lower = base.toLowerCase().replace(/ё/g, 'е')
  const name = normalizeForMatch(base)
  const candidates = new Map()
  const reasons = []

  for (const m of lower.matchAll(/(?:^|[^\p{L}\p{N}])(?:id|ид)[\s_№#:.-]*(\d{1,15})(?!\d)/gu)) {
    const doc = matcher.byDisplayId.get(m[1])
    if (doc) {
      candidates.set(doc.id, doc)
      reasons.push(`ID ${m[1]}`)
    } else {
      reasons.push(`ID ${m[1]} не найден`)
    }
  }

  const dsNumbers = [...lower.matchAll(/(?:^|[^\p{L}\p{N}])(?:дс|доп\.?\s*соглашени[ея]|дополнительное\s*соглашение)[\s_№#:.-]*([\p{L}\p{N}][\p{L}\p{N}/-]*)/gu)]
    .map((m) => normalizeForMatch(m[1]))
    .filter(Boolean)

  const contractHits = matcher.contracts.filter((c) => containsToken(name, c.number)).map((c) => c.doc)

  if (dsNumbers.length > 0) {
    for (const contract of contractHits) {
      const amendments = matcher.amendmentsByRoot.get(contract.id) || []
      const found = amendments.filter((a) => dsNumbers.includes(a.number))
      if (found.length === 0) reasons.push(`в договоре № ${contract.contract_number} нет ДС № ${dsNumbers.join(', ')}`)
      for (const a of found) {
        candidates.set(a.doc.id, a.doc)
        reasons.push(`ДС № ${a.doc.contract_number} договора № ${contract.contract_number}`)
      }
    }
  } else {
    for (const contract of contractHits) {
      candidates.set(contract.id, contract)
      reasons.push(`№ договора ${contract.contract_number}`)
    }
  }

  const list = [...candidates.values()]
  if (list.length === 1) return { status: 'unique', doc: list[0], candidates: list, reason: reasons.join('; ') }
  if (list.length > 1) {
    return {
      status: 'ambiguous',
      doc: null,
      candidates: list,
      reason: `Несколько подходящих документов: ${list.map((d) => `ID ${d.display_id}`).join(', ')}`,
    }
  }
  return { status: 'none', doc: null, candidates: [], reason: reasons.length ? reasons.join('; ') : 'В имени файла нет ID или номера документа' }
}
