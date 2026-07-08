-- Soft-delete для заявок на ДС: удалённые заявки уходят во вкладку «Удаленные»
-- (аналогично договорам). Восстановить может редактор, удалить безвозвратно — только админ.
ALTER TABLE dc_requests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_dc_requests_deleted_at ON dc_requests(deleted_at);
