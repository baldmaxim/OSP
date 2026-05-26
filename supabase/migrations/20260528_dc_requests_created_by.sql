-- Task 309. Снимок имени автора заявки на ДС — чтобы в реестре можно было
-- видеть, кто создал запись, без отдельного join'а.

ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS created_by_name TEXT;

COMMENT ON COLUMN dc_requests.created_by_name IS 'ФИО сотрудника, создавшего заявку (снапшот на момент INSERT)';
