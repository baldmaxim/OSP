-- task 431 (цепочка «Есть замечания»): после того как аналитик-экономист предоставил
-- замечания по КП (review_status='has_remarks'), инженер отправляет эти замечания
-- контрагенту. Фиксируем факт отправки: remarks_sent + кто/когда.
ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS remarks_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS remarks_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remarks_sent_by TEXT;

COMMENT ON COLUMN tender_proposal_files.remarks_sent IS
  'Замечания по КП отправлены контрагенту (инженером)';
COMMENT ON COLUMN tender_proposal_files.remarks_sent_at IS
  'Когда отмечена отправка замечаний контрагенту';
COMMENT ON COLUMN tender_proposal_files.remarks_sent_by IS
  'Кто отметил отправку замечаний (ФИО/e-mail)';
