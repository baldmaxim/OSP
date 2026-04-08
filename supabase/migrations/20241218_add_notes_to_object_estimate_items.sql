ALTER TABLE object_estimate_items
  ADD COLUMN IF NOT EXISTS notes TEXT;

COMMENT ON COLUMN object_estimate_items.notes IS 'Примечание к позиции сметы';
