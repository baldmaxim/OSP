-- «Статус ОКС» и «Комментарий» в /dc-requests (столбцы перед «Действиями»): подаётся ли ДС заказчику. У всех заявок
-- по умолчанию «Не проверено»; кто и когда сменил статус, ставит база (триггер) — со страницы подпись не подменить.
--
--  • submission_check (статус ОКС) — not_checked «Не проверено» | submitted «Подано заказчику» (номер письма — в
--    комментарии) | accepted «Принято в работу (будет подаваться)» (срок) | not_submitted «Не будет подаваться»
--    (причина) | incomplete «Неполный комплект» (чего не хватает);
--  • submission_comment — комментарий к статусу ОКС, до 2000 символов;
--  • submission_by / submission_by_name / submission_at — кто и когда сменил статус: вошедший и его ФИО из
--    user_roles при смене значения (и при создании заявки сразу не с «Не проверено»), иначе прежние. Правка одного
--    комментария подпись не меняет. Триггер — с правами вызывающего: свою строку user_roles сотрудник читает сам.
-- Правила по строкам не меняются — колонки той же таблицы. Повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261108_dc_request_submission_check.sql.
-- Проверка: migration/backup/checks/20261108.sql; откат — migration/rollback/20261108_dc_request_submission_check_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests
  ADD COLUMN IF NOT EXISTS submission_check text NOT NULL DEFAULT 'not_checked',
  ADD COLUMN IF NOT EXISTS submission_comment text,
  ADD COLUMN IF NOT EXISTS submission_by uuid,
  ADD COLUMN IF NOT EXISTS submission_by_name text,
  ADD COLUMN IF NOT EXISTS submission_at timestamptz;

ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_submission_check_check;
ALTER TABLE public.dc_requests ADD CONSTRAINT dc_requests_submission_check_check
  CHECK (submission_check IN ('not_checked', 'submitted', 'accepted', 'not_submitted', 'incomplete'));
ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_submission_comment_check;
ALTER TABLE public.dc_requests ADD CONSTRAINT dc_requests_submission_comment_check
  CHECK (char_length(submission_comment) <= 2000);

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

COMMENT ON COLUMN public.dc_requests.submission_check IS
  'Статус ОКС — подаётся ли ДС заказчику: not_checked | submitted | accepted | not_submitted | incomplete';
COMMENT ON COLUMN public.dc_requests.submission_comment IS
  'Комментарий к статусу ОКС: номер письма, срок подачи, причина, чего не хватает';
COMMENT ON COLUMN public.dc_requests.submission_by IS 'Кто сменил статус ОКС (ставит триггер)';
COMMENT ON COLUMN public.dc_requests.submission_by_name IS 'ФИО сменившего статус ОКС из user_roles (ставит триггер)';
COMMENT ON COLUMN public.dc_requests.submission_at IS 'Когда сменили статус ОКС (ставит триггер)';

COMMIT;
