-- АВАРИЙНЫЙ ОТКАТ 20261229_signup_phone_ext (только база Яндекса): телефон заявки снова без добавочного. У незавершённых и прошлых заявок
-- добавочный номер теряется (в контактах и учётках он остаётся). Страница без отката службы не сможет отправить заявку с добавочным:
-- служба ответит ошибкой, без добавочного всё работает. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:auth';

ALTER TABLE osp_auth.registrations DROP CONSTRAINT IF EXISTS registrations_phone_check;
UPDATE osp_auth.registrations SET phone = split_part(phone, ' доб. ', 1) WHERE phone LIKE '% доб. %';
ALTER TABLE osp_auth.registrations ADD CONSTRAINT registrations_phone_check CHECK (phone ~ '^\+[0-9]{8,15}$');

COMMIT;
