-- «Заявки на проверку ДП/ДС»: дату создания и автора заявки меняет только администратор (решение пользователя 05.11.2026).
-- Правило раздела разрешает править заявку всем сотрудникам с правом правки, поэтому без запрета в базе поля администратора
-- в форме ничего бы не защищали: их можно было бы записать прямым запросом.
--  • меняются created_at или created_by_name и вошёл не администратор (is_admin(): роль admin или superadmins) — 42501;
--  • без вошедшего (служебная операция) — без проверки; новая заявка — без проверки: автора ставит страница;
--  • только триггер и его функция с правами вызывающего, данные не меняются. Повтор безопасен.
CREATE OR REPLACE FUNCTION public.doc_check_requests_created_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Дату создания и автора заявки меняет только администратор' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS doc_check_requests_created_guard ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_created_guard
  BEFORE UPDATE OF created_at, created_by_name ON public.doc_check_requests
  FOR EACH ROW
  WHEN (NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name)
  EXECUTE FUNCTION public.doc_check_requests_created_guard();

COMMENT ON COLUMN public.doc_check_requests.created_at IS 'Дата создания заявки: меняет только администратор (триггер doc_check_requests_created_guard)';
COMMENT ON COLUMN public.doc_check_requests.created_by_name IS 'Кто создал заявку, текстом: меняет только администратор (триггер doc_check_requests_created_guard)';
