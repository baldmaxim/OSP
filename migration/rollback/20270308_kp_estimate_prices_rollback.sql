-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20270308_kp_estimate_prices.sql (Supabase): цены сметы КП / ПЗ снова только из файла —
-- страница без прав на таблицы цен показывает смету как до миграции (кнопки «Цены» нет, подсказка про миграцию — у администратора).
-- Данные НЕ удаляются: изменённые цены, документы цен и их история остаются в таблицах (без прав у вошедших) — повторное
-- применение миграции продолжит с ними. kp_estimate_activate остаётся новой (переносит и цены — без вреда). Одной транзакцией,
-- повтор безопасен. База Яндекса — 20270308_kp_estimate_prices_yandex_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

REVOKE ALL ON TABLE public.kp_estimate_prices, public.kp_estimate_price_docs FROM authenticated;
REVOKE ALL ON FUNCTION public.kp_estimate_price_apply(uuid, jsonb, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.kp_estimate_price_reset(uuid, uuid[]) FROM authenticated;

COMMIT;
