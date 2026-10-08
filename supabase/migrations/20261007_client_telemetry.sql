-- Телеметрия для безопасных релизов (страховочный релиз Р1, migration/REFACTORING.md).
--
-- client_versions — какая сборка фронта открыта у каждого вошедшего пользователя.
--   Нужна, чтобы убирать старое на сервере (политику, путь), только когда вкладок
--   со старой сборкой не осталось.
-- client_errors — коды отказов сервера по разделам (42501, 401/403, PGRST*, 57014,
--   5xx). Нужна, чтобы после выкладки сразу видеть, если кого-то заблокировало.
--   Без персональных данных: ни тел запросов, ни фильтров, ни текста ошибок.
--
-- Писать можно только через функции report_* (своя строка, проверка длины,
-- ограничение частоты). Читать — администратору (is_admin()) или из SQL Editor.
-- Фронт вызывает функции мягко: пока миграция не применена, он молча пропускает.
--
-- Миграция идемпотентна, бизнес-данные не трогает.

CREATE TABLE IF NOT EXISTS public.client_versions (
  user_id      uuid PRIMARY KEY,
  build_id     text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_versions_last_seen ON public.client_versions (last_seen_at);

CREATE TABLE IF NOT EXISTS public.client_errors (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  uuid,
  build_id text NOT NULL,
  section  text NOT NULL,
  code     text NOT NULL,
  status   integer
);
CREATE INDEX IF NOT EXISTS idx_client_errors_at ON public.client_errors (at);

ALTER TABLE public.client_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Напрямую таблицы никому не выданы: только чтение администратору.
REVOKE ALL ON public.client_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.client_errors FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_versions TO authenticated;
GRANT SELECT ON public.client_errors TO authenticated;

DROP POLICY IF EXISTS client_versions_select_admin ON public.client_versions;
CREATE POLICY client_versions_select_admin ON public.client_versions
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS client_errors_select_admin ON public.client_errors;
CREATE POLICY client_errors_select_admin ON public.client_errors
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- Своя сборка: одна строка на пользователя, последняя отметка.
CREATE OR REPLACE FUNCTION public.report_client_version(p_build_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_build_id IS NULL OR length(p_build_id) > 40 THEN
    RETURN;
  END IF;
  INSERT INTO public.client_versions (user_id, build_id, last_seen_at)
  VALUES (auth.uid(), p_build_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET build_id = EXCLUDED.build_id, last_seen_at = EXCLUDED.last_seen_at;
END
$fn$;

-- Отказ сервера. Не больше 100 записей на пользователя за 10 минут — даже
-- сломанный клиент не забьёт таблицу. Записи старше 30 дней подчищаются
-- попутно (примерно на каждой сотой вставке).
CREATE OR REPLACE FUNCTION public.report_client_error(
  p_build_id text, p_section text, p_code text, p_status integer
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF auth.uid() IS NULL
     OR p_build_id IS NULL OR length(p_build_id) > 40
     OR p_section IS NULL OR length(p_section) > 100
     OR p_code IS NULL OR length(p_code) > 40 THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.client_errors
      WHERE user_id = auth.uid() AND at > now() - interval '10 minutes') >= 100 THEN
    RETURN;
  END IF;
  INSERT INTO public.client_errors (user_id, build_id, section, code, status)
  VALUES (auth.uid(), p_build_id, p_section, p_code, p_status);
  IF random() < 0.01 THEN
    DELETE FROM public.client_errors WHERE at < now() - interval '30 days';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.report_client_version(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_client_error(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_client_version(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_client_error(text, text, text, integer) TO authenticated;

COMMENT ON TABLE public.client_versions IS 'Какая сборка фронта открыта у пользователя (телеметрия релизов)';
COMMENT ON TABLE public.client_errors IS 'Коды отказов сервера по разделам, без персональных данных (телеметрия релизов)';
