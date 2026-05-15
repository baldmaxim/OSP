-- Task 197: soft delete контрагентов — переносим в «Удалённые», админ может удалить безвозвратно
ALTER TABLE counterparties ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_counterparties_deleted_at ON counterparties(deleted_at);
COMMENT ON COLUMN counterparties.deleted_at IS 'Время мягкого удаления; NULL = активный контрагент';
