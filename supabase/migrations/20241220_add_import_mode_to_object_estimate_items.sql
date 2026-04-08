ALTER TABLE object_estimate_items
  ADD COLUMN IF NOT EXISTS import_mode VARCHAR(20) DEFAULT 'separate';

COMMENT ON COLUMN object_estimate_items.import_mode IS 'Режим импорта: separate (материалы и работы) или combined (комплекты)';
