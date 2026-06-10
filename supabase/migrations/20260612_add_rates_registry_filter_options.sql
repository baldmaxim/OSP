-- task 413: справочники для фильтров вкладки «Расценки от подрядчиков (КП)».
-- Фильтры «Объект» и «Подрядчик» должны показывать ТОЛЬКО сущности, реально имеющие
-- КП-расценки в реестре (а не весь справочник объектов/контрагентов). Считаем distinct
-- из представления kp_rates_registry (task 411) на стороне БД — без выгрузки всего реестра.
--
-- Зависит от 20260610_optimize_rates_registry.sql (view kp_rates_registry).

create or replace view kp_rates_registry_filter_objects
  with (security_invoker = true) as
  select distinct r.object_id, o.name as object_name
  from kp_rates_registry r
  join objects o on o.id = r.object_id
  where r.object_id is not null;

grant select on kp_rates_registry_filter_objects to authenticated, anon;

create or replace view kp_rates_registry_filter_counterparties
  with (security_invoker = true) as
  select distinct r.counterparty_id, c.name as counterparty_name
  from kp_rates_registry r
  join counterparties c on c.id = r.counterparty_id
  where r.counterparty_id is not null;

grant select on kp_rates_registry_filter_counterparties to authenticated, anon;
