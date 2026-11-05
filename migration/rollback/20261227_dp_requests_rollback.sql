-- АВАРИЙНЫЙ ОТКАТ 20261227_dp_requests (обе базы): раздела «Заявка на ДП» больше нет — запреты, уведомления и права убраны.
-- Сами заявки, список получателей и файлы НЕ удаляются: таблицы остаются (без доступа у вошедших), повторное применение миграции
-- продолжит с ними. Пункт меню пропадает у всех, кроме администратора; у него страница подскажет про миграцию.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS s3_documents_dp_request_attach ON public.s3_documents;
DROP TRIGGER IF EXISTS s3_documents_dp_request_detach ON public.s3_documents;
DROP FUNCTION IF EXISTS public.s3_documents_dp_request_guard();
DROP FUNCTION IF EXISTS public.dp_request_my_alerts();
DROP FUNCTION IF EXISTS public.dp_request_alerts_ack(uuid[]);

DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['dp_requests', 'dp_request_alert_recipients', 'dp_request_alerts'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;
    -- Пропуск служебных операций (база Яндекса) остаётся: данные читаются служебно.
    FOR v_policy IN SELECT policyname FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = v_table AND policyname <> 'osp_internal' LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy.policyname, v_table);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', v_table);
    END IF;
  END LOOP;
  IF to_regclass('public.dp_requests') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS dp_requests_guard ON public.dp_requests;
    DROP TRIGGER IF EXISTS dp_requests_alert ON public.dp_requests;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.dp_requests_guard();
DROP FUNCTION IF EXISTS public.dp_requests_alert();
DROP FUNCTION IF EXISTS public.dp_request_scope();

DELETE FROM public.role_permissions WHERE section IN ('dp_requests', 'dp_requests_create');

COMMIT;
