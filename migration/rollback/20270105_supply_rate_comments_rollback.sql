-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20270105_supply_rate_comments.sql (Supabase): колонки «Комментарий» в расценке
-- снабжения больше нет (страница без прав на таблицу показывает расценку как до миграции).
-- Данные НЕ удаляются: таблица комментариев остаётся (без прав у вошедших) — повторное применение миграции
-- продолжит с ней. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS tender_supply_comments_guard ON public.tender_supply_comments;
DROP TRIGGER IF EXISTS tender_supply_comments_touch ON public.tender_supply_comments;
REVOKE ALL ON TABLE public.tender_supply_comments FROM authenticated;

COMMIT;
