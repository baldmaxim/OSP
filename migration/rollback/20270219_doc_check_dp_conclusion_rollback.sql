-- АВАРИЙНЫЙ ОТКАТ 20270219_doc_check_dp_conclusion (обе базы): заявки на заключение ДП возвращаются в прежний раздел.
--  • Отказ (ничего не меняется), если с перенесёнными заявками на доске уже работали: сменили колонку или тип, писали в
--    переписке, добавили или убрали файлы, удалили или восстановили. Тогда решать вручную: откат потерял бы эту работу.
--  • Иначе: файлы — прежним владельцам и категориям (из резерва), прежние строки dp_requests — неудалённые, как были;
--    уведомления — снова о заявках на ДП (уведомления о заявках доски, созданных после миграции, убираются: прежнему разделу
--    их не показать); копии на доске удаляются вместе с их историей.
--  • Заявки «Заключение ДП», созданные на доске уже после миграции, остаются на доске как «ДП» — не теряются.
--  • Тип заявки доски — снова только ДП и ДС; окно о новой заявке — прежнее (dp_request_my_alerts из 20261227); триггеры и
--    функции миграции убираются. Резерв (osp_private.dp_moved_*_20270219) остаётся — удалить вручную, когда откат не понадобится.
-- Повтор безопасен. Видны заявки снова будут только прежней сборкой сайта (страница /dp-requests).
-- Supabase — SQL Editor; база Яндекса — psql под владельцем с отметкой служебной операции:
--   SELECT pg_catalog.set_config('application_name', 'osp:internal', false);  -- до BEGIN, иначе правила по строкам скроют строки
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  v_req regclass := to_regclass('osp_private.dp_moved_requests_20270219');
  v_files regclass := to_regclass('osp_private.dp_moved_files_20270219');
  v_touch boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'trg_doc_check_requests_updated_at' AND NOT tgisinternal);
  v_status bigint := 0;
  v_talk bigint := 0;
  v_new_files bigint := 0;
  v_gone_files bigint := 0;
  v_deleted bigint := 0;
  v_n bigint;
BEGIN
  IF v_req IS NOT NULL AND v_files IS NOT NULL THEN
    -- С копиями работали? Копии уже нет (откат был) — не в счёт.
    EXECUTE format('SELECT count(*) FROM public.doc_check_requests c JOIN %s b ON b.request_id = c.id
                    WHERE c.status <> ''new'' OR c.doc_type <> ''dp_conclusion'' OR (to_jsonb(c) ->> ''archived_at'') IS NOT NULL', v_req)
      INTO v_status;
    EXECUTE format('SELECT count(*) FROM public.doc_check_requests c JOIN %s b ON b.request_id = c.id
                    WHERE (c.deleted_at IS NULL) IS DISTINCT FROM (b.dp_deleted_at IS NULL)', v_req)
      INTO v_deleted;
    IF to_regclass('public.doc_check_request_comments') IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.doc_check_request_comments m JOIN %s b ON b.request_id = m.request_id', v_req)
        INTO v_talk;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.s3_documents s JOIN %s b ON b.request_id = s.owner_id
                    WHERE s.owner_type = ''doc_check_request'' AND NOT EXISTS (SELECT 1 FROM %s f WHERE f.doc_id = s.id)', v_req, v_files)
      INTO v_new_files;
    EXECUTE format('SELECT count(*) FROM %s f JOIN public.doc_check_requests c ON c.id = f.request_id
                    WHERE NOT EXISTS (SELECT 1 FROM public.s3_documents s WHERE s.id = f.doc_id AND s.owner_type = ''doc_check_request''
                                        AND s.owner_id = f.request_id)', v_files)
      INTO v_gone_files;
    IF v_status + v_deleted + v_talk + v_new_files + v_gone_files > 0 THEN
      RAISE EXCEPTION 'Откат остановлен: с перенесёнными заявками уже работали на доске — колонка, тип или архив: %, удалены или восстановлены: %, сообщений: %, новых файлов: %, убранных файлов: %. Ничего не изменено; решите вручную',
        v_status, v_deleted, v_talk, v_new_files, v_gone_files;
    END IF;

    -- Уведомления — снова о заявках на ДП: сначала ссылка, потом удаление копий (иначе каскад унёс бы уведомления).
    IF to_regclass('public.dp_request_alerts') IS NOT NULL THEN
      DELETE FROM public.dp_request_alerts a WHERE NOT EXISTS (SELECT 1 FROM public.dp_requests d WHERE d.id = a.request_id);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE NOTICE 'Убраны уведомления о заявках доски, созданных после миграции: %', v_n;
      ALTER TABLE public.dp_request_alerts DROP CONSTRAINT IF EXISTS dp_request_alerts_request_id_fkey;
      ALTER TABLE public.dp_request_alerts ADD CONSTRAINT dp_request_alerts_request_id_fkey
        FOREIGN KEY (request_id) REFERENCES public.dp_requests(id) ON DELETE CASCADE;
      IF to_regclass('osp_private.dp_moved_alerts_20270219') IS NOT NULL THEN
        INSERT INTO public.dp_request_alerts (id, request_id, user_id, created_at, read_at)
        SELECT a.id, a.request_id, a.user_id, a.created_at, a.read_at FROM osp_private.dp_moved_alerts_20270219 a
        WHERE EXISTS (SELECT 1 FROM public.dp_requests d WHERE d.id = a.request_id)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    EXECUTE format('UPDATE public.s3_documents s SET owner_type = f.owner_type, doc_category = f.doc_category
                    FROM %s f WHERE s.id = f.doc_id AND s.owner_type = ''doc_check_request''', v_files);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Файлы возвращены заявкам на ДП: %', v_n;

    EXECUTE format('UPDATE public.dp_requests d SET deleted_at = NULL FROM %s b
                    WHERE b.request_id = d.id AND b.dp_deleted_at IS NULL AND d.deleted_at IS NOT NULL', v_req);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Заявки на ДП снова в прежнем разделе: %', v_n;

    EXECUTE format('DELETE FROM public.doc_check_requests c USING %s b WHERE b.request_id = c.id', v_req);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Копии на доске удалены: %', v_n;
  END IF;

  -- Заявки «Заключение ДП», созданные после миграции, — на доске как «ДП» (updated_at не сдвигается).
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests DISABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
  UPDATE public.doc_check_requests SET doc_type = 'dp' WHERE doc_type = 'dp_conclusion';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests ENABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
  RAISE NOTICE 'Заявки доски «Заключение ДП» → «ДП»: %', v_n;
END
$$;

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_doc_type_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_doc_type_check CHECK (doc_type IN ('dp', 'ds'));
COMMENT ON COLUMN public.doc_check_requests.doc_type IS 'dp — договор подряда, ds — дополнительное соглашение';

DROP TRIGGER IF EXISTS doc_check_dp_conclusion_alert ON public.doc_check_requests;
DROP FUNCTION IF EXISTS public.doc_check_dp_conclusion_alert();
DROP TRIGGER IF EXISTS dp_requests_moved ON public.dp_requests;
DROP FUNCTION IF EXISTS public.dp_requests_moved_guard();

-- Окно о новой заявке — как в 20261227.
CREATE OR REPLACE FUNCTION public.dp_request_my_alerts()
  RETURNS TABLE (request_id uuid, request_number integer, object_name text, contract_title text, amount numeric,
                 responsible_name text, responsible_role text, reason text, created_by_name text, alerted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT r.id, r.request_number, o.name::text, r.contract_title, r.amount, r.responsible_name, r.responsible_role, r.reason,
         r.created_by_name, a.created_at
  FROM public.dp_request_alerts a
  JOIN public.dp_requests r ON r.id = a.request_id AND r.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = r.object_id
  WHERE a.user_id = auth.uid() AND a.read_at IS NULL AND public.osp_is_employee()
  ORDER BY a.created_at, a.id
  LIMIT 200
$$;
COMMENT ON TABLE public.dp_request_alerts IS
  'Уведомление получателю о новой заявке на ДП: заводит триггер, read_at ставит dp_request_alerts_ack, когда человек закрыл окно';
COMMENT ON TABLE public.dp_requests IS
  'Заявка на договор подряда (ДП): объект, договор, сумма, ответственный, причина. Файлы — s3_documents, owner_type = dp_request';

COMMIT;
