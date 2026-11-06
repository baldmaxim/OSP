// Руководитель контрагента — подпись в выборе контрагента рядом с ИНН (06.11.2026, решение пользователя: в «Заявке на ДС»
// одноимённые компании — «ООО Мастер» с разными ИНН — различать ещё и по гендиректору).
//
// Своего поля у контрагента нет, ЕГРЮЛ не подключён, а `contracts.gen_director_name` на копии 02.11 заполнено у одного
// договора. Поэтому руководитель — контакт карточки контрагента (`counterparty_contacts`) с должностью руководителя.
// Должность пишут как попало (копия 02.11: «Генеральный Директор» — 155, «Генеральный директор » с пробелом, «ГЕНЕРАЛЬНЫЙ
// ДИРЕКТОР», «ген. директор», «Актуальный генеральный директор»), поэтому сравнение — без регистра и лишних пробелов.
// Не руководитель: заместитель, коммерческий, исполнительный, «по развитию», «проекта», «временно исполняющий» и т. п.

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

// Чем ниже число, тем важнее: у контрагента с гендиректором и «Директором» показываем гендиректора.
export const HEAD_KINDS = {
  gen: { rank: 0, label: 'Ген. директор' },
  dir: { rank: 1, label: 'Директор' },
  head: { rank: 2, label: 'Руководитель' },
  ip: { rank: 3, label: 'ИП' },
}

// Должность контакта → вид руководителя или null.
export function headKind(position) {
  const p = norm(position).replace(/[?!.,;:]+$/, '')
  if (!p || /(^|[^а-я])зам/.test(p)) return null
  // «Генеральный директор» в начале; после него — конец или не буква («Генеральный Директор АО …» — тоже он).
  if (/^(актуальный )?(генеральный|ген\.?) ?директор([^а-я]|$)/.test(p) || /^гендиректор([^а-я]|$)/.test(p)) return 'gen'
  if (p === 'директор') return 'dir'
  if (p === 'руководитель') return 'head'
  if (p === 'индивидуальный предприниматель' || p === 'ип') return 'ip'
  return null
}

// «Нет контакта», «-», пустое — не ФИО.
function personOf(fullName) {
  const name = String(fullName ?? '').replace(/\s+/g, ' ').trim()
  if (!/[a-zа-яё]/i.test(name) || norm(name) === 'нет контакта') return null
  return name
}

// Строки counterparty_contacts (counterparty_id, full_name, position, updated_at) → Map(counterparty_id → { name, label }).
// Из нескольких руководителей одного вида — изменённый позже («Актуальный генеральный директор» сменил прежнего).
export function counterpartyHeads(contacts) {
  const best = new Map()
  for (const c of contacts || []) {
    const kind = headKind(c?.position)
    const name = kind && c.counterparty_id ? personOf(c.full_name) : null
    if (!name) continue
    const rank = HEAD_KINDS[kind].rank
    const at = String(c.updated_at || '')
    const prev = best.get(c.counterparty_id)
    if (prev && (prev.rank < rank || (prev.rank === rank && prev.at >= at))) continue
    best.set(c.counterparty_id, { rank, at, name, label: HEAD_KINDS[kind].label })
  }
  const heads = new Map()
  for (const [id, h] of best) heads.set(id, { name: h.name, label: h.label })
  return heads
}

// Отбор строк в запросе — с запасом (точный разбор — headKind): чтобы не читать все контакты реестра.
export const HEAD_POSITION_FILTER = 'position.ilike.*директор*,position.ilike.*руководител*,position.ilike.*предпринимател*,position.ilike.ип'
