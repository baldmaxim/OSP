-- Этапы тендера: даты подготовки ВОР (сметный отдел) и даты тендерной процедуры (ОСП).
-- Существующие start_date/end_date по смыслу — "сроки работ" (когда подрядчик выполняет работы).

ALTER TABLE tenders ADD COLUMN IF NOT EXISTS vor_start_date DATE;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS vor_end_date DATE;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS tender_start_date DATE;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS tender_end_date DATE;

COMMENT ON COLUMN tenders.vor_start_date IS 'Дата начала подготовки ВОР (сметный отдел)';
COMMENT ON COLUMN tenders.vor_end_date IS 'Дата окончания подготовки ВОР';
COMMENT ON COLUMN tenders.tender_start_date IS 'Дата начала тендерной процедуры (ОСП)';
COMMENT ON COLUMN tenders.tender_end_date IS 'Дата окончания тендерной процедуры';
