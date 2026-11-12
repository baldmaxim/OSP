-- АВАРИЙНЫЙ ОТКАТ 20270202_doc_check_tax_clause_remove (обе базы): статус tax_clause — «Проверка документов (исключение
-- налоговой оговорки)» — снова допустим, и заявки, которые миграция убрала как дубли или перенесла в «Завершено», возвращаются
-- в него (по записям миграции в истории; только те, что с тех пор не трогали: всё ещё «Завершено», дубль — всё ещё удалён).
-- В историю каждой — запись о возврате. Страница после 20270202 подписи этого статуса не знает: колонка будет называться
-- «tax_clause» — откатывать вместе с прежней сборкой сайта.
-- Supabase — SQL Editor; база Яндекса — psql под владельцем с отметкой служебной операции:
--   SELECT pg_catalog.set_config('application_name', 'osp:internal', false);  -- до BEGIN, иначе правила по строкам скроют заявки
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_status_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_status_check
  CHECK (status IN ('new', 'in_progress', 'edo', 'signal', 'accounting', 'done', 'awaiting_scan', 'tax_clause'));

DO $$
DECLARE
  c_who constant text := 'Исправление данных 12.11.2026 (миграция 20270202)';
  c_undo constant text := 'Откат миграции 20270202';
  v_touch boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'trg_doc_check_requests_updated_at' AND NOT tgisinternal);
  v_ids uuid[];
BEGIN
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests DISABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;

  -- Дубли: снова на доске, в прежнем статусе.
  SELECT coalesce(array_agg(r.id), '{}') INTO v_ids
  FROM public.doc_check_requests r
  WHERE r.status = 'done' AND r.deleted_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l
                WHERE l.request_id = r.id AND l.event_type = 'soft_deleted' AND l.changed_by_name = c_who)
    AND NOT EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l
                    WHERE l.request_id = r.id AND l.changed_by_name = c_undo);
  UPDATE public.doc_check_requests SET status = 'tax_clause', deleted_at = NULL WHERE id = ANY (v_ids);
  INSERT INTO public.doc_check_request_audit_log (request_id, event_type, description, changed_by_name)
  SELECT id, 'restored', 'Заявка возвращена (откат миграции 20270202)', c_undo FROM unnest(v_ids) AS id;

  -- Перенесённые в «Завершено» и удалённые, у которых миграция сменила только статус.
  SELECT coalesce(array_agg(r.id), '{}') INTO v_ids
  FROM public.doc_check_requests r
  WHERE r.status = 'done'
    AND EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l
                WHERE l.request_id = r.id AND l.event_type = 'status_changed' AND l.changed_by_name = c_who)
    AND NOT EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l
                    WHERE l.request_id = r.id AND l.changed_by_name = c_undo);
  UPDATE public.doc_check_requests SET status = 'tax_clause' WHERE id = ANY (v_ids);
  INSERT INTO public.doc_check_request_audit_log (request_id, event_type, field_name, old_value, new_value, description, changed_by_name)
  SELECT id, 'status_changed', 'status', to_jsonb('done'::text), to_jsonb('tax_clause'::text), 'Откат миграции 20270202', c_undo
  FROM unnest(v_ids) AS id;

  IF v_touch THEN
    ALTER TABLE public.doc_check_requests ENABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
END
$$;

COMMENT ON COLUMN public.doc_check_requests.status IS
  'new | in_progress | edo (выгрузка по ЭДО) | signal (загрузка в Signal) | accounting (загрузка в 1С) | done | awaiting_scan (ждём подписанный бумажный оригинал) | tax_clause (проверка документов: исключение налоговой оговорки)';
COMMIT;
