-- Задача 391: новые даты в реестре договоров.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS accepted_date DATE,   -- Дата принятия в работу ДП
  ADD COLUMN IF NOT EXISTS signed_date DATE;     -- Дата подписания

COMMENT ON COLUMN contracts.accepted_date IS 'Дата принятия договора в работу (ДП)';
COMMENT ON COLUMN contracts.signed_date IS 'Дата подписания договора';
