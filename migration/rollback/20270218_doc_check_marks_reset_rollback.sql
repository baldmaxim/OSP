-- АВАРИЙНЫЙ ОТКАТ 20270218_doc_check_marks_reset (обе базы): заявкам на проверку ДП/ДС возвращаются цвет и приоритет, которые
-- были до сброса (из osp_private.doc_check_marks_backup_20270218, обе базы). Только тем заявкам, у
-- которых с тех пор не появилось своего цвета или приоритета. updated_at не меняется. Таблица прежних значений остаётся
-- (удалить вручную, когда откат больше не понадобится). Видны значения будут только прежней сборкой сайта: новая цветов и
-- приоритетов не показывает.
-- Supabase — SQL Editor; база Яндекса — psql под владельцем с отметкой служебной операции:
--   SELECT pg_catalog.set_config('application_name', 'osp:internal', false);  -- до BEGIN, иначе правила по строкам скроют заявки
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  v_backup regclass := to_regclass('osp_private.doc_check_marks_backup_20270218');
  v_touch boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'trg_doc_check_requests_updated_at' AND NOT tgisinternal);
  v_n bigint;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'doc_check_requests' AND column_name IN ('priority', 'color')) < 2 THEN
    RAISE NOTICE 'Колонок цвета и приоритета нет — возвращать некуда';
    RETURN;
  END IF;
  EXECUTE $c$COMMENT ON COLUMN public.doc_check_requests.priority IS 'Приоритет: high | normal | low, NULL — не указан'$c$;
  EXECUTE $c$COMMENT ON COLUMN public.doc_check_requests.color IS
    'Цвет карточки на доске: red | orange | yellow | green | teal | blue | violet | pink'$c$;
  IF v_backup IS NULL THEN
    RAISE NOTICE 'Таблицы прежних значений нет — возвращать нечего';
    RETURN;
  END IF;
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests DISABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
  EXECUTE format('UPDATE public.doc_check_requests r SET priority = b.priority, color = b.color
                  FROM %s b
                  WHERE b.request_id = r.id AND r.priority IS NULL AND r.color IS NULL', v_backup);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests ENABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
  RAISE NOTICE 'Возвращены цвет и приоритет: % заявок', v_n;
END
$$;

COMMIT;
