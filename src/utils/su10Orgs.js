// «Организации СУ-10» (вкладка «Администрирование», окно «Сопоставить…», заявки на доступ, карточка контрагента): подписи и
// фильтры. Решения о доступе принимает сервер (server/osp-api/src/lib/auth/orgs.js); здесь — только показ.

// Итог организации учётки (описание с сервера: describeOrg).
export const ORG_RESULT_TEXT = {
  unknown_subject: 'организация в СУ-10 ещё не известна',
  none: 'в СУ-10 без организации',
  ambiguous: 'в СУ-10 несколько организаций — ошибка данных СУ-10',
  unknown: 'организации нет в реестре СУ-10',
  inactive: 'организация не действует в реестре СУ-10',
  own: 'своя организация СУ-10',
  unmapped: 'организация не сопоставлена с контрагентом',
  counterparty: 'организация сопоставлена',
}
// Подсказки «какой это контрагент» (server/osp-api/src/lib/orgMatch.js).
export const REASON_TEXT = {
  inn: 'ИНН совпал', inn_soft: 'ИНН похож', inn_hint: 'ИНН из BillHub', inn_in_name: 'ИНН в названии',
  name: 'то же название', name_similar: 'похожее название', domain: 'домен почты',
}
export const FLAG_TEXT = {
  blacklist: 'в чёрном списке', hint_name: 'проверьте: в BillHub другое название', checksum: 'ИНН не прошёл проверку',
  duplicate: 'есть дубли', main_record: 'основная запись среди дублей', claimed: 'кандидат и у другой организации',
}
export const STATE_TEXT = { active: 'действует', missing: 'нет в реестре СУ-10', invalid: 'ошибка в реестре СУ-10' }
export const KIND_TEXT = { own: 'своя', contractor: 'подрядчик' }

export const counterpartyLabel = (c) => (c ? `№ ${c.number ?? '—'} ${c.name || 'без названия'}` : '')

// Сотрудники ОСП в «не своей» организации без исключения: не войдут.
export const employeesWithoutException = (org) => (Array.isArray(org?.employees) ? org.employees.filter((e) => !e.exception) : [])

// Что с организацией: linked — связь действует; broken — связь есть, но не действует (организация выбыла, контрагент удалён
// или в ЧС); unlinked — подрядчик без связи; own — своя; invalid — ошибка или нет в реестре без связи.
export function orgStatus(org) {
  if (org.kind === 'own' && org.state === 'active') return 'own'
  if (org.counterparty) return org.usable ? 'linked' : 'broken'
  if (org.state !== 'active') return 'invalid'
  return 'unlinked'
}

export const ORG_FILTERS = [
  { key: 'unlinked', label: 'Без связи' },
  { key: 'attention', label: 'Не действует' },
  { key: 'linked', label: 'Связанные' },
  { key: 'all', label: 'Все' },
]

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim()

// Фильтр вкладки. «Без связи» в режиме входа через СУ-10 — только подрядчики, у которых есть учётки с доступом или заявки
// (остальные — в «Все»); до переключения учёток не видно, поэтому — все подрядчики без связи.
export function filterOrgs(orgs, { filter = 'unlinked', query = '', keycloak = false } = {}) {
  const q = norm(query)
  return (orgs || []).filter((o) => {
    const status = orgStatus(o)
    if (filter === 'unlinked') {
      if (status !== 'unlinked') return false
      if (keycloak && !(o.accounts > 0 || o.requests > 0)) return false
    } else if (filter === 'attention') {
      if (!(status === 'broken' || employeesWithoutException(o).length > 0)) return false
    } else if (filter === 'linked') {
      if (status !== 'linked') return false
    }
    if (!q) return true
    const hay = norm([o.name, o.inn, o.counterparty?.name, o.counterparty?.inn, o.counterparty?.number != null ? `№ ${o.counterparty.number}` : ''].join(' '))
    return q.split(' ').every((w) => hay.includes(w))
  })
}

// Сколько подрядчиков без связи не попало в «Без связи» (нет учёток и заявок) — для подсказки.
export const hiddenUnlinked = (orgs, keycloak) => (keycloak ? (orgs || []).filter((o) => orgStatus(o) === 'unlinked' && !(o.accounts > 0 || o.requests > 0)).length : 0)
