// Статус контрагента (counterparties.status, ENUM counterparty_status): действующий, «Малые суммы», чёрный список.
// «Малые суммы» (limited, миграция 20261114, решение пользователя 29.10.2026) — жёлтый: привлекать можно, но только
// на небольшие суммы. Такой контрагент остаётся во вкладке «Активные»; в «Чёрный список» уходит только blacklist.

export const CP_STATUS_ACTIVE = 'active'
export const CP_STATUS_LIMITED = 'limited'
export const CP_STATUS_BLACKLIST = 'blacklist'

export const CP_LIMITED_LABEL = 'Малые суммы'
export const CP_LIMITED_HINT = 'Можно привлекать только на небольшие суммы'

// Подписи в реестре и карточке. Неизвестное значение — «Активный», как раньше.
const STATUS_LABEL = { active: 'Активный', limited: CP_LIMITED_LABEL, blacklist: 'Чёрный список' }
export const cpStatusLabel = (status) => STATUS_LABEL[status] || STATUS_LABEL.active

// Колонка «Статус» файла импорта: «Черный список» / «Чёрный список», «Малые суммы»; остальное — действующий.
export function cpStatusFromText(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/ё/g, 'е')
  if (t === 'черный список') return CP_STATUS_BLACKLIST
  if (t === CP_LIMITED_LABEL.toLowerCase()) return CP_STATUS_LIMITED
  return CP_STATUS_ACTIVE
}

// База ещё без значения limited (миграция 20261114 не применена): PostgreSQL отвечает 22P02
// «invalid input value for enum counterparty_status».
export const isLimitedStatusMissing = (error) =>
  error?.code === '22P02' && /counterparty_status/.test(String(error?.message || ''))

export const LIMITED_MISSING_TEXT = `Статус «${CP_LIMITED_LABEL}» появится после обновления базы (миграция 20261114).`
