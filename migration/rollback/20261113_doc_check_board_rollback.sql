-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261113_doc_check_board.sql (Supabase): доска заявок на проверку ДП/ДС —
-- как до миграции (без исполнителей, срока, приоритета, цвета, меток, архива и колонки «Проверка документов»).
-- ВНИМАНИЕ: эти данные теряются — перед откатом снимите их выгрузкой:
--   select id, status, assignee_ids, due_date, priority, color, labels, archived_at from public.doc_check_requests
--   where status = 'tax_clause' or cardinality(assignee_ids) > 0 or due_date is not null or priority is not null
--      or color is not null or cardinality(labels) > 0 or archived_at is not null;
-- Заявки со статусом tax_clause возвращаются «В работу» — иначе прежний список статусов их не пропустит.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

UPDATE public.doc_check_requests SET status = 'in_progress' WHERE status = 'tax_clause';
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_status_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_status_check
  CHECK (status IN ('new', 'in_progress', 'edo', 'signal', 'accounting', 'done', 'awaiting_scan'));

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_priority_check;
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_color_check;
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_labels_check;
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_assignees_check;
ALTER TABLE public.doc_check_requests
  DROP COLUMN IF EXISTS assignee_ids,
  DROP COLUMN IF EXISTS due_date,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS labels,
  DROP COLUMN IF EXISTS archived_at;

COMMIT;
