// Заявка на ДС ↔ договор (миграция 20261109): номер договора и номер ДС — раздельно.
//
//   dc_requests.contract_id  — договор (ДП) реестра «Договоры и ДС», к которому подаётся заявка;
//   dc_requests.ds_number    — номер самого ДС (как и раньше, текстом);
//   dc_requests.amendment_id — ДС реестра, в которое заявка занесена («занесена в допник»).
//
// Привязка автоматическая там, где она однозначна: у контрагента по объекту один договор — он и подставляется;
// у договора есть ДС с тем же номером, что «№ ДС» заявки, — заявка считается занесённой в него. Иначе договор и
// ДС выбирают в реестре заявок. Одни правила на реестр заявок и карточку контрагента. Модуль без зависимостей:
// его проверяют тесты.

// Номер документа без регистра, пробелов, дефисов, точек и косых — так же, как миграция 20261109 сравнивала
// номера договоров прежних заявок.
export function normalizeDocNumber(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_./\\–—-]/g, '')
}

// Номер ДС для сравнения: «ДС №5», «ДС-5», «дс5», «5», «ДС №5 от 12.01.26» → «5»; «ДС №5а» → «5а». Без номера в
// начале или со ссылкой на другое ДС дальше («№1 к ДС18 к дог …» — приложение к ДС 18) — весь номер целиком:
// такое совпадёт только с точно таким же.
export function dsNumberKey(value) {
  const raw = String(value ?? '').toLowerCase().trim()
  if (!raw) return ''
  const m = raw.match(/^(?:доп(?:\.|олнительное)?\s*соглашение|дс)?\s*[-–—№#]?\s*(\d+)([а-яa-z](?![а-яa-z]))?/)
  if (!m || /дс|доп/.test(raw.slice(m[0].length))) return normalizeDocNumber(raw)
  return m[1] + (m[2] || '')
}

const isLiveContract = (c) => !!c && !c.deleted_at && c.record_type === 'dp'

// Договоры контрагента для выбора в заявке; внутри — свежие выше. Объект заявки выбран — только договоры этого
// объекта (решение 28.10: договоры других объектов не предлагаются), за ними — договоры без объекта: они не
// «другого объекта», а не заполнены в реестре. Объекта нет — все договоры контрагента.
// contracts — [{ id, record_type, deleted_at, counterparty_id, object_id, contract_number, contract_date, … }];
// parties — Map(id договора → Set(id контрагентов)) из contract_counterparties (договор с несколькими сторонами).
export function contractChoicesFor(contracts, counterpartyId, objectId = null, parties = null) {
  if (!counterpartyId) return []
  const own = (contracts || []).filter(c => isLiveContract(c)
    && (c.counterparty_id === counterpartyId || parties?.get(c.id)?.has(counterpartyId))
    && (!objectId || !c.object_id || c.object_id === objectId))
  const rank = (c) => (objectId && c.object_id === objectId ? 0 : 1)
  return own.sort((a, b) => rank(a) - rank(b)
    || String(b.contract_date || '').localeCompare(String(a.contract_date || ''))
    || String(a.contract_number || '').localeCompare(String(b.contract_number || ''), 'ru'))
}

// Договор, который подставляется сам: единственный договор контрагента по объекту заявки.
export function autoContractFor(contracts, counterpartyId, objectId, parties = null) {
  if (!counterpartyId || !objectId) return null
  const onObject = contractChoicesFor(contracts, counterpartyId, objectId, parties).filter(c => c.object_id === objectId)
  return onObject.length === 1 ? onObject[0] : null
}

// ДС договора (все уровни дерева): root_contract_id указывает на договор.
export function amendmentsOf(contracts, contractId) {
  if (!contractId) return []
  return (contracts || [])
    .filter(c => !c.deleted_at && c.record_type !== 'dp' && (c.root_contract_id === contractId || c.parent_contract_id === contractId))
    .sort((a, b) => String(a.contract_date || '').localeCompare(String(b.contract_date || ''))
      || Number(a.display_id || 0) - Number(b.display_id || 0))
}

// ДС, в которое занесена заявка, по номеру: единственное ДС договора с тем же номером, что «№ ДС» заявки.
export function matchAmendment(dsNumber, amendments) {
  const key = dsNumberKey(dsNumber)
  if (!key) return null
  const found = (amendments || []).filter(a => dsNumberKey(a.contract_number) === key)
  return found.length === 1 ? found[0] : null
}

// Карточка контрагента: отработана ли заявка (этап «Завершено») и занесена ли она в ДС (amendment_id) — два
// разных признака: заявку могут занести в ДС и раньше, чем закроют.
export const DC_WORK_STATE = {
  contract_check: { label: 'Проверка по договору', className: 'is-check' },
  in_work: { label: 'В работе', className: 'is-work' },
  completed: { label: 'Отработана', className: 'is-done' },
}
export const dcWorkState = (req) => DC_WORK_STATE[req?.status] || DC_WORK_STATE.contract_check

export function summarizeDcRequests(requests) {
  const list = requests || []
  return {
    total: list.length,
    done: list.filter(r => r.status === 'completed').length,
    inDs: list.filter(r => r.amendment_id).length,
  }
}

// Заявки по договорам: [{ contract | null, requests }] — договоры свежие выше, заявки без договора — в конце.
// docs — Map(id → договор / ДС); договор, которого нет в docs (удалён), считается «не указан».
export function groupDcRequestsByContract(requests, docs) {
  const groups = new Map()
  for (const r of requests || []) {
    const contract = (r.contract_id && docs?.get(r.contract_id)) || null
    const key = contract ? contract.id : ''
    if (!groups.has(key)) groups.set(key, { contract, requests: [] })
    groups.get(key).requests.push(r)
  }
  return [...groups.values()].sort((a, b) => (!a.contract) - (!b.contract)
    || String(b.contract?.contract_date || '').localeCompare(String(a.contract?.contract_date || ''))
    || String(a.contract?.contract_number || '').localeCompare(String(b.contract?.contract_number || ''), 'ru'))
}

// Подпись договора / ДС: «№ П-15/26 от 02.03.2026» (без номера — «без номера»).
export function contractLabel(doc) {
  if (!doc) return ''
  const num = doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'
  const d = doc.contract_date ? String(doc.contract_date).slice(0, 10).split('-').reverse().join('.') : ''
  return d ? `${num} от ${d}` : num
}

// Подпись ДС: номер уже со словом «ДС» / «доп. соглашение» — как есть («ДС №3 от 10.05.2026»), иначе «ДС № 3 от …».
export function amendmentLabel(doc) {
  if (!doc) return 'ДС'
  const num = String(doc.contract_number || '').trim()
  const head = !num ? 'ДС без номера' : /^(дс|доп)/i.test(num) ? num : `ДС № ${num}`
  const d = doc.contract_date ? String(doc.contract_date).slice(0, 10).split('-').reverse().join('.') : ''
  return d ? `${head} от ${d}` : head
}
