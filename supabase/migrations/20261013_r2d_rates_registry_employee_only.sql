-- Р2d: реестр расценок — только сотрудникам.
--
-- ПРОБЛЕМА (замер прав после Р2a/b, 2026-10-12). Реестр расценок — цены из КП всех подрядчиков и
-- расценки снабжения — читал любой вошедший: неодобренный, заблокированный, подрядчик, учётка без роли.
-- Девять представлений реестра читают материализованные представления с правами владельца, а у самих
-- материализованных представлений защиты строк нет — только выданное право, и оно было у authenticated.
-- Пересчёт реестра мог запустить кто угодно, в том числе без входа.
--
-- РЕШЕНИЕ.
--  • osp_registry_reader() — кому отдаётся реестр: сотруднику (osp_is_employee, правило из Р2a) и
--    служебному ключу (service_role) — им пользуется выдача расценок смежному отделу (rates-api).
--  • Девять представлений реестра отдают строки только при osp_registry_reader(); функция считается
--    один раз на запрос.
--  • У материализованных представлений право чтения снято у authenticated и anon: напрямую их читает
--    только служебный ключ. Портал читает представления — для сотрудников ничего не меняется.
--  • refresh_rates_registry: без входа и не сотруднику — отказ; не чаще раза в 60 секунд (повторный
--    вызов возвращает время последнего пересчёта). Расписание pg_cron и служебный ключ работают как раньше.
--
-- Сотрудники ничего не теряют. Данные не меняются. Повтор безопасен. Редеплой rates-api не нужен.
-- Аварийный откат — migration/rollback/20261013_r2d_rollback.sql. Всё — одной транзакцией.
BEGIN;
-- Не дали блокировку за 10 с (идёт пересчёт реестра) — миграция отменяется целиком и ничего не меняет:
-- повторить через минуту.
SET LOCAL lock_timeout = '10s';

-- 1. Кому отдаётся реестр. SECURITY DEFINER: служебному ключу osp_is_employee не выдана, а здесь она
--    вызывается от имени владельца. «Кто вошёл» берётся из токена запроса, как во всех политиках.
CREATE OR REPLACE FUNCTION public.osp_registry_reader() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case when auth.role() = 'service_role' then true else public.osp_is_employee() end
$$;
COMMENT ON FUNCTION public.osp_registry_reader() IS 'Реестр расценок отдаётся сотруднику и служебному ключу (Р2d)';
REVOKE ALL ON FUNCTION public.osp_registry_reader() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osp_registry_reader() TO authenticated, service_role;

-- 2. Девять представлений реестра: строки — только читателю реестра.
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
   FROM public.kp_rates_registry_mv
  WHERE (SELECT public.osp_registry_reader());

CREATE OR REPLACE VIEW public.kp_rates_registry_filter_counterparties AS
 SELECT DISTINCT r.counterparty_id,
    c.name AS counterparty_name
   FROM (public.kp_rates_registry_mv r
     JOIN public.counterparties c ON ((c.id = r.counterparty_id)))
  WHERE ((r.counterparty_id IS NOT NULL) AND (SELECT public.osp_registry_reader()));

CREATE OR REPLACE VIEW public.kp_rates_registry_filter_objects AS
 SELECT DISTINCT r.object_id,
    o.name AS object_name
   FROM (public.kp_rates_registry_mv r
     JOIN public.objects o ON ((o.id = r.object_id)))
  WHERE ((r.object_id IS NOT NULL) AND (SELECT public.osp_registry_reader()));

CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM public.kp_rates_registry_mv r
  WHERE (((tender_id IS NOT NULL) AND (COALESCE(tender_desc, ''::text) <> ''::text)) AND (SELECT public.osp_registry_reader()));

CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.kp_rates_registry_mv
  WHERE (((unit IS NOT NULL) AND ((unit)::text <> ''::text)) AND (SELECT public.osp_registry_reader()));

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
   FROM public.supply_rates_registry_mv
  WHERE (SELECT public.osp_registry_reader());

CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT object_id,
    object_name
   FROM public.supply_rates_registry_mv r
  WHERE ((object_id IS NOT NULL) AND (SELECT public.osp_registry_reader()));

CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM public.supply_rates_registry_mv r
  WHERE (((tender_id IS NOT NULL) AND (COALESCE(tender_desc, ''::text) <> ''::text)) AND (SELECT public.osp_registry_reader()));

CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.supply_rates_registry_mv
  WHERE (((unit IS NOT NULL) AND (unit <> ''::text)) AND (SELECT public.osp_registry_reader()));

REVOKE ALL ON TABLE
  public.kp_rates_registry,
  public.kp_rates_registry_filter_counterparties,
  public.kp_rates_registry_filter_objects,
  public.kp_rates_registry_filter_tenders,
  public.kp_rates_registry_units,
  public.supply_rates_registry,
  public.supply_rates_registry_filter_objects,
  public.supply_rates_registry_filter_tenders,
  public.supply_rates_registry_units
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE
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

-- 3. Материализованные представления напрямую — только служебному ключу.
REVOKE ALL ON TABLE public.kp_rates_registry_mv, public.supply_rates_registry_mv FROM PUBLIC, anon, authenticated;

-- 4. Пересчёт реестра: только сотрудник (или вызов без пользователя — расписание, служебный ключ), не
--    чаще раза в минуту.
CREATE OR REPLACE FUNCTION public.refresh_rates_registry() RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  finished_at timestamptz;
  last_at timestamptz;
begin
  if auth.uid() is not null and not public.osp_is_employee() then
    raise exception 'Обновлять реестр расценок может только сотрудник' using errcode = '42501';
  end if;

  -- Пересчёт тяжёлый: повторный вызов в течение минуты отдаёт время последнего пересчёта.
  select updated_at into last_at from app_settings where key = 'rates_registry_refreshed_at';
  if last_at is not null and last_at > now() - interval '60 seconds' then
    return last_at;
  end if;

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
REVOKE ALL ON FUNCTION public.refresh_rates_registry() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_rates_registry() TO authenticated, service_role;

COMMIT;
