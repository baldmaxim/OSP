-- Дополнительные поля для тендеров:
-- cost_plan_link — ссылка на план затрат (Google/Yandex Drive)
-- cost_plan_responsible_id — ответственный сотрудник за план затрат
-- summary_proposal_link — ссылка на сводную таблицу КП (Google/Yandex Drive)

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cost_plan_link TEXT;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cost_plan_responsible_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS summary_proposal_link TEXT;

CREATE INDEX IF NOT EXISTS idx_tenders_cost_plan_responsible_id ON tenders(cost_plan_responsible_id);

COMMENT ON COLUMN tenders.cost_plan_link IS 'Ссылка на план затрат (Google/Yandex Drive)';
COMMENT ON COLUMN tenders.cost_plan_responsible_id IS 'Ответственный сотрудник за план затрат (из таблицы contacts)';
COMMENT ON COLUMN tenders.summary_proposal_link IS 'Ссылка на сводную таблицу КП (Google/Yandex Drive)';
