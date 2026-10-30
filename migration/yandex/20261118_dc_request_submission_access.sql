-- «Статус ОКС» в /dc-requests — дело «Отдела по удорожанию» (решение пользователя 30.10.2026). Тело
-- supabase/migrations/20261118_dc_request_submission_access.sql: меняется только функция триггера той же таблицы —
-- правила по строкам и список шлюза не меняются; функция — с правами вызывающего (не служебная, отметки пропуска нет).
--
--  • Статус ОКС, комментарий и ответственного меняет только сотрудник отдела: роль udoroj… или с «удорож» в названии
--    (roles). Остальным — 42501; без вошедшего (служебная операция) — без проверки.
--  • Смена статуса ОКС: кто и когда — как раньше, и тот же вошедший — ответственный (ФИО из user_roles, иначе почта).
--  • Нужны 20261108 и 20261117. Повтор безопасен.
CREATE OR REPLACE FUNCTION public.dc_requests_submission_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touched boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_touched := NEW.submission_check IS DISTINCT FROM OLD.submission_check
              OR NEW.submission_comment IS DISTINCT FROM OLD.submission_comment
              OR NEW.submission_resp_user_id IS DISTINCT FROM OLD.submission_resp_user_id
              OR NEW.submission_resp_name IS DISTINCT FROM OLD.submission_resp_name;
  ELSE
    v_touched := NEW.submission_check <> 'not_checked' OR NEW.submission_comment IS NOT NULL
              OR NEW.submission_resp_user_id IS NOT NULL;
  END IF;
  IF v_touched AND v_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid
      AND (ur.role ILIKE 'udoroj%'
           OR EXISTS (SELECT 1 FROM public.roles r WHERE r.key = ur.role AND r.label ILIKE '%удорож%'))
  ) THEN
    RAISE EXCEPTION 'Статус ОКС меняет только отдел по удорожанию' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.submission_check IS NOT DISTINCT FROM OLD.submission_check THEN
    NEW.submission_by := OLD.submission_by;
    NEW.submission_by_name := OLD.submission_by_name;
    NEW.submission_at := OLD.submission_at;
  ELSIF TG_OP = 'INSERT' AND NEW.submission_check = 'not_checked' THEN
    NEW.submission_by := NULL;
    NEW.submission_by_name := NULL;
    NEW.submission_at := NULL;
  ELSE
    NEW.submission_by := v_uid;
    NEW.submission_by_name := (SELECT nullif(btrim(ur.full_name), '') FROM public.user_roles ur
                               WHERE ur.user_id = v_uid LIMIT 1);
    NEW.submission_at := now();
    IF v_uid IS NOT NULL THEN
      NEW.submission_resp_user_id := v_uid;
      NEW.submission_resp_name := left((SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), ''))
                                        FROM public.user_roles ur WHERE ur.user_id = v_uid LIMIT 1), 300);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS dc_requests_submission_stamp ON public.dc_requests;
CREATE TRIGGER dc_requests_submission_stamp
  BEFORE INSERT OR UPDATE OF submission_check, submission_comment, submission_by, submission_by_name, submission_at,
    submission_resp_user_id, submission_resp_name ON public.dc_requests
  FOR EACH ROW EXECUTE FUNCTION public.dc_requests_submission_stamp();

COMMENT ON COLUMN public.dc_requests.submission_resp_user_id IS
  'Ответственный за статус ОКС — сотрудник «Отдела по удорожанию»: тот, кто поставил статус (ставит триггер), или назначенный';
