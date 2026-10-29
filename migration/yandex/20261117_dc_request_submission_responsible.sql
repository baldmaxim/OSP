-- Ответственный за «Статус ОКС» в /dc-requests: сотрудник «Отдела по удорожанию». Тело
-- supabase/migrations/20261117_dc_request_submission_responsible.sql: колонки той же таблицы dc_requests — правила по
-- строкам и список шлюза не меняются, функций нет.
--
--  • submission_resp_user_id — пользователь (без внешнего ключа); выбор только из роли «Отдел по удорожанию» делает
--    страница (справочник employee_directory);
--  • submission_resp_name — его ФИО на момент назначения; без ответственного ФИО не бывает, до 300 символов.
--  • Повтор безопасен.
ALTER TABLE public.dc_requests
  ADD COLUMN IF NOT EXISTS submission_resp_user_id uuid,
  ADD COLUMN IF NOT EXISTS submission_resp_name text;

ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_submission_resp_check;
ALTER TABLE public.dc_requests ADD CONSTRAINT dc_requests_submission_resp_check
  CHECK ((submission_resp_user_id IS NOT NULL OR submission_resp_name IS NULL)
         AND char_length(submission_resp_name) <= 300);

COMMENT ON COLUMN public.dc_requests.submission_resp_user_id IS
  'Ответственный за статус ОКС — сотрудник «Отдела по удорожанию» (user_roles.user_id)';
COMMENT ON COLUMN public.dc_requests.submission_resp_name IS
  'ФИО ответственного за статус ОКС на момент назначения';
