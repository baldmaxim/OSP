-- Soft delete для тендеров: вместо физического удаления выставляем deleted_at,
-- чтобы запись можно было восстановить во вкладке «Удалённые тендеры».

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenders_deleted_at ON tenders(deleted_at) WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN tenders.deleted_at IS 'Метка мягкого удаления. NULL — активный тендер; если задано — тендер скрыт во всех вкладках, кроме «Удалённые».';
