-- АВАРИЙНЫЙ ОТКАТ migration/yandex/20270308_kp_estimate_prices.sql (база Яндекса): цены сметы КП / ПЗ снова только из файла —
-- чтение таблиц цен закрыто (страница показывает смету как до миграции), функции записи цен убраны (шлюз ответит, что функции нет).
-- Данные НЕ удаляются: изменённые цены, документы цен и их история остаются в таблицах — повторное применение миграции продолжит
-- с ними. kp_estimate_activate остаётся новой (переносит и цены — без вреда). Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS kp_estimate_prices_read ON public.kp_estimate_prices;
DROP POLICY IF EXISTS kp_estimate_price_docs_read ON public.kp_estimate_price_docs;
DELETE FROM osp_meta.policy_roles WHERE schema_name = 'public'
  AND (table_name, policy_name) IN (('kp_estimate_prices', 'kp_estimate_prices_read'), ('kp_estimate_price_docs', 'kp_estimate_price_docs_read'));
DROP FUNCTION IF EXISTS public.kp_estimate_price_apply(uuid, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.kp_estimate_price_reset(uuid, uuid[]);

COMMIT;
