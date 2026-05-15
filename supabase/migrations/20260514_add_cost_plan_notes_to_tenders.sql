-- Task 177: примечание к плану затрат (отображается на странице "Планы затрат").
-- Отдельная колонка от общего tenders.notes, чтобы не смешивать пометки по разным разрезам.
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cost_plan_notes TEXT;
COMMENT ON COLUMN tenders.cost_plan_notes IS 'Примечание по плану затрат (свободный текст на странице «Планы затрат»)';
