ALTER TABLE object_estimate_items
  ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN object_estimate_items.is_approved IS 'Смета утверждена — редактирование заблокировано';
