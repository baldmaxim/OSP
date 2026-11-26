// Черновик просмотра кабинета от имени подрядчика (решение пользователя 25.11.2026: кабинет в просмотре — 1 в 1 как у подрядчика).
// Записи кабинета (services/contractorBids.js) при включённом черновике не уходят на сервер, а ложатся сюда — в память страницы.
// Отдельный маленький модуль: его включает страница кабинета, а снимает RoleContext, когда просмотр заканчивается (не очистка страницы:
// React снимает эффекты от родителя к детям, и прощальная запись цен из BidWorkspace ушла бы на сервер уже без черновика).
let current = null

export function setCabinetPreview(counterpartyId) {
  if (!counterpartyId) { current = null; return }
  if (current?.cp === counterpartyId) return
  current = {
    cp: counterpartyId,
    rates: new Map(), // tenderId → Map(`${kind}|${item_key}|${unit_key}` → строка цены | { deleted: true })
    forms: new Map(), // tenderId → { id поля: значение }
    company: null, // { id поля: значение } | null
    access: new Map(), // tenderId → доступ после «Участвовать»
    participation: new Map(), // tenderId → отметка участия («declined»)
    supply: new Map(), // tenderId → { status, requested_at, decided_at }
  }
}

export const cabinetSandbox = () => current
