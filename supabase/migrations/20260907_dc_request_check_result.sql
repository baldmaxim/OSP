-- Заявки на ДС: промежуточный этап «Итог проверки» между «Проверка по договору»
-- и «В работе».
--
-- После сверки с договором юрист оформляет вывод (и прикладывает отчёт по
-- документам — файлы s3_documents с doc_category='check_report', миграции для
-- этого не нужно, категория — свободный TEXT). Пока вывод не готов, заявка не
-- должна считаться взятой в работу, поэтому этап отдельный.
--
-- Цепочка: contract_check → check_result → in_work → completed.
-- Миграция идемпотентна.

ALTER TABLE dc_requests DROP CONSTRAINT IF EXISTS dc_requests_status_check;
ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_status_check
  CHECK (status IN ('contract_check', 'check_result', 'in_work', 'completed'));

COMMENT ON COLUMN dc_requests.status IS
  'Этап заявки: contract_check (проверка по договору) → check_result (итог проверки) → in_work (в работе) → completed (завершено)';
