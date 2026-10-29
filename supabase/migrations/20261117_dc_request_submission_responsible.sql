-- Ответственный за «Статус ОКС» в /dc-requests: сотрудник «Отдела по удорожанию», выбирается под статусом ОКС;
-- в заголовке столбца — фильтр по ответственному.
--
--  • submission_resp_user_id — пользователь (user_roles.user_id, без внешнего ключа — как у ответственных снабжения
--    и СТО в тендерах); выбор только из роли «Отдел по удорожанию» делает страница (справочник employee_directory);
--  • submission_resp_name — его ФИО на момент назначения: реестр, выгрузка и фильтр показывают его и без справочника,
--    и когда сотрудник ушёл из отдела. Без ответственного ФИО не бывает; длина — до 300 символов.
-- Правила по строкам не меняются — колонки той же таблицы. Повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261117_dc_request_submission_responsible.sql.
-- Проверка: migration/backup/checks/20261117.sql; откат — migration/rollback/20261117_dc_request_submission_responsible_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

COMMIT;
