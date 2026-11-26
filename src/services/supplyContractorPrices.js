// Столбец «Цены подрядчику» в расценке снабжения (SupplyPricingPanel, решение пользователя 25.11.2026): инженер ОСП или
// администратор открывает подрядчику основного тендера цены снабжения выбранных позиций. Функции базы — из миграции 20270303
// (bid_supply_list / bid_supply_items / bid_supply_grant / bid_supply_decide, решает osp_supply_engineer()); здесь — только запись
// решения в историю основного тендера (раньше её писала строка «Тендеров на материалы»).
import { db } from '../api'
import { sanitizeDeep, sanitizeUserText } from '../utils/text'

// Решение — в историю основного тендера (событие field_updated, поле supply_prices_access, как прежде). Ошибка истории не мешает
// решению: оно уже записано.
export async function logSupplyAccess(mainId, { counterpartyId, name, text, byName = null, byRole = null }) {
  if (!mainId) return
  try {
    const { error } = await db.from('tender_audit_log').insert([{
      tender_id: mainId,
      event_type: 'field_updated',
      field_name: 'supply_prices_access',
      old_value: null,
      new_value: sanitizeDeep({ id: counterpartyId, name: name || null, text }),
      description: sanitizeUserText(`Цены снабжения подрядчику ${name || '—'}: ${text}`) || null,
      changed_by_role: byRole,
      changed_by_name: byName,
    }])
    if (error) console.error('Не удалось записать историю тендера:', error.message || error)
  } catch (e) {
    console.error('Ошибка записи истории тендера:', e?.message || e)
  }
}
