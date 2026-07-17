-- Справочники тендеров для фильтра «Тендер» в реестре расценок.
-- По образцу *_filter_objects / *_filter_counterparties (миграции 20260612/20260613):
-- отдаём только те тендеры, по которым в реестре реально есть расценки, — чтобы в
-- выпадающем списке не было пустых вариантов.
-- object_id оставлен на будущее (возможная привязка списка тендеров к объекту).

create or replace view kp_rates_registry_filter_tenders
  with (security_invoker = true) as
  select distinct r.tender_id, r.tender_desc, r.object_id
  from kp_rates_registry r
  where r.tender_id is not null
    and coalesce(r.tender_desc, '') <> '';

grant select on kp_rates_registry_filter_tenders to authenticated;

create or replace view supply_rates_registry_filter_tenders
  with (security_invoker = true) as
  select distinct r.tender_id, r.tender_desc, r.object_id
  from supply_rates_registry r
  where r.tender_id is not null
    and coalesce(r.tender_desc, '') <> '';

grant select on supply_rates_registry_filter_tenders to authenticated;
