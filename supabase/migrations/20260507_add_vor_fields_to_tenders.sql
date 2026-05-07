-- Поля для ВОР (Ведомость Объёмов Работ) — аналогично плану затрат:
-- vor_link — ссылка на документ ВОР (Google/Yandex Drive)
-- vor_responsible_id — ответственный сотрудник
-- vor_status — статус ВОР (not_started | in_progress | completed)

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS vor_link TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS vor_responsible_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS vor_status TEXT NOT NULL DEFAULT 'not_started';

ALTER TABLE tenders DROP CONSTRAINT IF EXISTS valid_vor_status;
ALTER TABLE tenders
    ADD CONSTRAINT valid_vor_status
    CHECK (vor_status IN ('not_started', 'in_progress', 'completed'));

CREATE INDEX IF NOT EXISTS idx_tenders_vor_responsible_id ON tenders(vor_responsible_id);
CREATE INDEX IF NOT EXISTS idx_tenders_vor_status ON tenders(vor_status);

COMMENT ON COLUMN tenders.vor_link IS 'Ссылка на ВОР (Google/Yandex Drive)';
COMMENT ON COLUMN tenders.vor_responsible_id IS 'Ответственный сотрудник за ВОР (из contacts)';
COMMENT ON COLUMN tenders.vor_status IS 'Статус ВОР: not_started | in_progress | completed';
