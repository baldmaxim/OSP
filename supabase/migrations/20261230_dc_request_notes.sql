-- «Примечание» в /dc-requests: выпадающая полоса под заявкой, заметки по ходу рассмотрения ДС (решение пользователя
-- 05.11.2026, образец — примечание юриста в реестре договоров). Одно поле на заявку, кто и когда менял — в истории
-- заявки (dc_request_audit_log). Правила по строкам не меняются — колонка той же таблицы. Повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261230_dc_request_notes.sql.
-- Проверка: migration/backup/checks/20261230.sql; откат — migration/rollback/20261230_dc_request_notes_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_notes_check;
ALTER TABLE public.dc_requests ADD CONSTRAINT dc_requests_notes_check CHECK (char_length(notes) <= 5000);

COMMENT ON COLUMN public.dc_requests.notes IS 'Примечание: заметки по ходу рассмотрения ДС';

COMMIT;
