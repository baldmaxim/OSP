-- Task 246: «тендер на материалы» больше не отдельный тендер с участниками.
-- Учёт материалов теперь — простые поля прямо на основном тендере:
--   materials_proposal_link     (уже существует) — ссылка на КП по материалам
--   materials_proposal_deadline (уже существует) — срок предоставления КП
--   materials_status            (новое поле)     — статус по материалам
-- Дочерние тендеры на материалы (tender_type='materials') НЕ удаляются.

ALTER TABLE tenders
    ADD COLUMN IF NOT EXISTS materials_status TEXT NOT NULL DEFAULT 'not_started';

ALTER TABLE tenders DROP CONSTRAINT IF EXISTS valid_materials_status;
ALTER TABLE tenders
    ADD CONSTRAINT valid_materials_status
    CHECK (materials_status IN ('not_started', 'in_progress', 'completed', 'not_required'));

COMMENT ON COLUMN tenders.materials_status IS 'Статус по материалам основного тендера: not_started | in_progress | completed | not_required';
