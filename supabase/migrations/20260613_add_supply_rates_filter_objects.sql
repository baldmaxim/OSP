-- task 414: справочник объектов для фильтра вкладки «Расценки от снабжения СУ-10».
-- Фильтр «Объект» должен показывать ТОЛЬКО объекты, по которым есть расценки снабжения
-- (а не весь справочник). Считаем distinct из supply_rates_registry (task 412) на стороне БД.
--
-- Зависит от 20260611_add_supply_rates_registry.sql (view supply_rates_registry).

create or replace view supply_rates_registry_filter_objects
  with (security_invoker = true) as
  select distinct r.object_id, r.object_name
  from supply_rates_registry r
  where r.object_id is not null;

grant select on supply_rates_registry_filter_objects to authenticated, anon;
