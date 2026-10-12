-- АВАРИЙНЫЙ ОТКАТ Р2d (supabase/migrations/20261013_r2d_rates_registry_employee_only.sql).
-- Возвращает реестр расценок в состояние до миграции: его снова читает любой вошедший. Применять только
-- если после миграции у сотрудников пропал реестр или сломалась выдача расценок смежному отделу — и
-- сообщить об этом: откат снова открывает дыру. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE VIEW public.kp_rates_registry AS
 SELECT id,
    item_type,
    item_name,
    unit,
    price,
    tender_id,
    counterparty_id,
    object_id,
    tender_desc,
    object_name,
    counterparty_name,
    proposal_date
   FROM public.kp_rates_registry_mv;

CREATE OR REPLACE VIEW public.kp_rates_registry_filter_counterparties AS
 SELECT DISTINCT r.counterparty_id,
    c.name AS counterparty_name
   FROM (public.kp_rates_registry_mv r
     JOIN public.counterparties c ON ((c.id = r.counterparty_id)))
  WHERE (r.counterparty_id IS NOT NULL);

CREATE OR REPLACE VIEW public.kp_rates_registry_filter_objects AS
 SELECT DISTINCT r.object_id,
    o.name AS object_name
   FROM (public.kp_rates_registry_mv r
     JOIN public.objects o ON ((o.id = r.object_id)))
  WHERE (r.object_id IS NOT NULL);

CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM public.kp_rates_registry_mv r
  WHERE ((tender_id IS NOT NULL) AND (COALESCE(tender_desc, ''::text) <> ''::text));

CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.kp_rates_registry_mv
  WHERE ((unit IS NOT NULL) AND ((unit)::text <> ''::text));

CREATE OR REPLACE VIEW public.supply_rates_registry AS
 SELECT id,
    source_type,
    source_name,
    item_name,
    unit,
    price,
    tender_id,
    object_id,
    tender_desc,
    object_name,
    rate_date
   FROM public.supply_rates_registry_mv;

CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT object_id,
    object_name
   FROM public.supply_rates_registry_mv r
  WHERE (object_id IS NOT NULL);

CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM public.supply_rates_registry_mv r
  WHERE ((tender_id IS NOT NULL) AND (COALESCE(tender_desc, ''::text) <> ''::text));

CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.supply_rates_registry_mv
  WHERE ((unit IS NOT NULL) AND (unit <> ''::text));

GRANT ALL ON TABLE
  public.kp_rates_registry,
  public.kp_rates_registry_filter_counterparties,
  public.kp_rates_registry_filter_objects,
  public.kp_rates_registry_filter_tenders,
  public.kp_rates_registry_units,
  public.supply_rates_registry,
  public.supply_rates_registry_filter_objects,
  public.supply_rates_registry_filter_tenders,
  public.supply_rates_registry_units
TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry_mv, public.supply_rates_registry_mv TO authenticated;

CREATE OR REPLACE FUNCTION public.refresh_rates_registry() RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  finished_at timestamptz;
begin
  refresh materialized view concurrently kp_rates_registry_mv;
  refresh materialized view concurrently supply_rates_registry_mv;
  finished_at := now();

  -- Отметка времени, чтобы на странице было видно, насколько свежие данные.
  insert into app_settings (key, value, updated_at)
  values ('rates_registry_refreshed_at', finished_at::text, finished_at)
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at;

  return finished_at;
end;
$$;
GRANT ALL ON FUNCTION public.refresh_rates_registry() TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.osp_registry_reader();

COMMIT;
