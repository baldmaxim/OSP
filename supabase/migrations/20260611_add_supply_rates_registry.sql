-- task 412: расценки от снабжения СУ-10 в «Общем реестре расценок».
--
-- Расценки снабжения уже хранятся в tender_vor_supply_rates (tender_id, estimate_name,
-- material_name, unit, supply_price = ЦЕНА ЗА ЕДИНИЦУ, created_at/updated_at,
-- UNIQUE(tender_id, estimate_name, material_name)). Отдельной «передачи» в реестр не
-- нужно — как и для КП (task 411), реестр это ПРЕДСТАВЛЕНИЕ над исходной таблицей:
-- любая загруженная в тендер расценка снабжения автоматически попадает в реестр.
--
-- Зависит от 20260610_optimize_rates_registry.sql (функции kp_norm_name/kp_norm_unit).
--
-- СУ-10 — это ИСТОЧНИК (source_type='supply_su10', source_name='СУ-10'), а не подрядчик:
-- фиктивный контрагент не создаётся, с КП подрядчиков не смешивается.

create extension if not exists pg_trgm;

-- Базовые расценки снабжения: одна базовая позиция (материал) на тендер. Один и тот же
-- материал, встречающийся в нескольких ВОР-документах тендера (estimate_name), схлопывается
-- в одну запись (берём самую свежую по updated_at). В price — единичная цена снабжения
-- (supply_price), НЕ итог объём×цена.
create or replace view supply_rates_registry
  with (security_invoker = true) as
select distinct on (sr.tender_id, kp_norm_name(sr.material_name), kp_norm_unit(sr.unit))
  md5(sr.tender_id::text || '|' || kp_norm_name(sr.material_name) || '|' || kp_norm_unit(sr.unit)) as id,
  'supply_su10'::text as source_type,
  'СУ-10'::text as source_name,
  sr.material_name as item_name,
  sr.unit as unit,
  sr.supply_price as price,
  sr.tender_id,
  t.object_id,
  t.work_description as tender_desc,
  o.name as object_name,
  coalesce(sr.updated_at, sr.created_at) as rate_date
from tender_vor_supply_rates sr
join tenders t on t.id = sr.tender_id
left join objects o on o.id = t.object_id
where kp_norm_name(sr.material_name) <> ''
order by sr.tender_id, kp_norm_name(sr.material_name), kp_norm_unit(sr.unit),
         coalesce(sr.updated_at, sr.created_at) desc nulls last;

grant select on supply_rates_registry to authenticated, anon;

-- Лёгкий справочник единиц измерения для фильтра вкладки СУ-10.
create or replace view supply_rates_registry_units
  with (security_invoker = true) as
  select distinct unit from supply_rates_registry where unit is not null and unit <> '';

grant select on supply_rates_registry_units to authenticated, anon;

-- Индексы под фактические запросы вкладки СУ-10.
create index if not exists idx_tvsr_tender_id on tender_vor_supply_rates (tender_id);
create index if not exists idx_tvsr_unit on tender_vor_supply_rates (unit);
create index if not exists idx_tvsr_updated_at on tender_vor_supply_rates (updated_at desc);
-- Поиск по наименованию материала (ilike '%...%') — триграммный индекс.
create index if not exists idx_tvsr_material_name_trgm
  on tender_vor_supply_rates using gin (material_name gin_trgm_ops);
