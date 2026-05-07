-- Статус плана затрат у тендера — отдельный от статуса самого тендера.
-- Позволяет ответственному за план затрат отмечать свой прогресс независимо
-- от хода тендерной процедуры (например, план может быть готов до завершения тендера).

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cost_plan_status TEXT NOT NULL DEFAULT 'not_started';

ALTER TABLE tenders DROP CONSTRAINT IF EXISTS valid_cost_plan_status;
ALTER TABLE tenders
    ADD CONSTRAINT valid_cost_plan_status
    CHECK (cost_plan_status IN ('not_started', 'in_progress', 'completed'));

CREATE INDEX IF NOT EXISTS idx_tenders_cost_plan_status ON tenders(cost_plan_status);

COMMENT ON COLUMN tenders.cost_plan_status IS 'Статус плана затрат: not_started | in_progress | completed';
