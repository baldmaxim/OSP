-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261024_supply_import_state.sql (Supabase): таблица состояния разбора удаляется.
-- Данные в ней выводятся заново службой osp-api (supplyImport) — потерь нет: реестр тендеров на материалы снова
-- показывает «открыть» у тендеров, расценку которых не открывали, а страница сама разбирает файлы, как раньше.
-- Списки позиций (tender_supply_sources) и цены не трогаются. Повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS public.tender_supply_import_state;
COMMIT;
