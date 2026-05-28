-- task 356: добавляем раздел 'rates_registry' (Реестр расценок) в права ролей.
-- Раздел объединяет все источники расценок: КП от подрядчиков (tender_counterparty_proposals),
-- ДП/ДС, и расценки от снабжения СУ-10. Видеть могут все сотрудники, редактировать —
-- только инженеры/экономисты/админ (для модерации). Пока редактирование не используется
-- (страница read-only), но право заранее настраиваем.

INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
  ('admin', 'rates_registry', true, true),
  ('engineer', 'rates_registry', true, true),
  ('economist', 'rates_registry', true, true),
  ('lawyer', 'rates_registry', true, false),
  ('construction_manager', 'rates_registry', true, false)
ON CONFLICT (role, section) DO NOTHING;
