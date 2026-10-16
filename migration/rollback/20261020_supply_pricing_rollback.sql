-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261020_supply_pricing.sql (Supabase): расценки снабжения снова пишет
-- любой сотрудник (прежняя политика Р2a), триггеры расчёта, закрытия и журнала снимаются, функция переноса
-- ВОР и представление прогресса удаляются. Применять, если после миграции импорт расценок в карточке или
-- страница расценки не работают и это нельзя переждать, — и сразу сообщить.
-- Данные НЕ удаляются: новые колонки расценок, списки позиций (tender_supply_sources) и журнал остаются —
-- повторное применение миграции продолжит с ними. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS tender_vor_supply_rates_compute ON public.tender_vor_supply_rates;
DROP TRIGGER IF EXISTS tender_vor_supply_rates_guard ON public.tender_vor_supply_rates;
DROP TRIGGER IF EXISTS tender_vor_supply_rates_log ON public.tender_vor_supply_rates;
DROP TRIGGER IF EXISTS tender_supply_sources_compute ON public.tender_supply_sources;
DROP TRIGGER IF EXISTS tender_supply_sources_guard ON public.tender_supply_sources;

DROP POLICY IF EXISTS supply_rates_read ON public.tender_vor_supply_rates;
DROP POLICY IF EXISTS supply_rates_insert ON public.tender_vor_supply_rates;
DROP POLICY IF EXISTS supply_rates_update ON public.tender_vor_supply_rates;
DROP POLICY IF EXISTS supply_rates_delete ON public.tender_vor_supply_rates;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.tender_vor_supply_rates;
CREATE POLICY "Allow all for authenticated users" ON public.tender_vor_supply_rates
  FOR ALL TO authenticated
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));

DROP VIEW IF EXISTS public.tender_supply_progress;
DROP FUNCTION IF EXISTS public.supply_estimate_rename(uuid, text, text);

COMMIT;
