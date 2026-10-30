-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261118_dc_request_submission_access.sql (Supabase): функция и триггер
-- подписи статуса ОКС — как после 20261108 (кто и когда сменил статус; менять может любой сотрудник, ответственный
-- сам не ставится). Данные НЕ меняются — статусы, комментарии и ответственные заявок сохраняются.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.dc_requests_submission_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.submission_check IS NOT DISTINCT FROM OLD.submission_check THEN
    NEW.submission_by := OLD.submission_by;
    NEW.submission_by_name := OLD.submission_by_name;
    NEW.submission_at := OLD.submission_at;
  ELSIF TG_OP = 'INSERT' AND NEW.submission_check = 'not_checked' THEN
    NEW.submission_by := NULL;
    NEW.submission_by_name := NULL;
    NEW.submission_at := NULL;
  ELSE
    NEW.submission_by := auth.uid();
    NEW.submission_by_name := (SELECT nullif(btrim(ur.full_name), '') FROM public.user_roles ur
                               WHERE ur.user_id = auth.uid() LIMIT 1);
    NEW.submission_at := now();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS dc_requests_submission_stamp ON public.dc_requests;
CREATE TRIGGER dc_requests_submission_stamp
  BEFORE INSERT OR UPDATE OF submission_check, submission_by, submission_by_name, submission_at ON public.dc_requests
  FOR EACH ROW EXECUTE FUNCTION public.dc_requests_submission_stamp();

COMMENT ON COLUMN public.dc_requests.submission_resp_user_id IS
  'Ответственный за статус ОКС — сотрудник «Отдела по удорожанию» (user_roles.user_id)';

COMMIT;
