-- Task 208: новый статус плана затрат «Не требуется» (not_required).
-- Поведение в UI: уходит во вкладку «Завершено» (как completed), но не требует ссылки на план.
ALTER TABLE tenders DROP CONSTRAINT IF EXISTS valid_cost_plan_status;
ALTER TABLE tenders
    ADD CONSTRAINT valid_cost_plan_status
    CHECK (cost_plan_status IN ('not_started', 'in_progress', 'completed', 'not_required'));

COMMENT ON COLUMN tenders.cost_plan_status IS 'Статус плана затрат: not_started | in_progress | completed | not_required';
