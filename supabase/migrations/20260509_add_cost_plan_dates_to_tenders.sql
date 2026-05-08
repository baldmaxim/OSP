-- Сроки выполнения плана затрат: начало и окончание (диапазон).
-- Используется на странице «Планы затрат» вместо колонки «Сроки тендера».

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cost_plan_start_date DATE;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS cost_plan_end_date DATE;

COMMENT ON COLUMN tenders.cost_plan_start_date IS 'Срок выполнения плана затрат: начало';
COMMENT ON COLUMN tenders.cost_plan_end_date IS 'Срок выполнения плана затрат: окончание';
