-- Отметка о внесении договора в систему Larix. После заключения договора сотрудник
-- заносит его в Larix; здесь фиксируем факт (larix_entered), присвоенный там номер
-- (larix_number) и кто/когда отметил (larix_entered_at / larix_entered_by).
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS larix_entered BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS larix_number TEXT,
  ADD COLUMN IF NOT EXISTS larix_entered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS larix_entered_by TEXT;

COMMENT ON COLUMN contracts.larix_entered IS 'Договор внесён в систему Larix';
COMMENT ON COLUMN contracts.larix_number IS 'Номер договора в системе Larix';
COMMENT ON COLUMN contracts.larix_entered_at IS 'Когда отмечено внесение в Larix';
COMMENT ON COLUMN contracts.larix_entered_by IS 'Кто отметил внесение в Larix (ФИО/e-mail)';
