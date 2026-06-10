-- task 411: серверная пагинация/фильтрация/поиск для «Общего реестра расценок».
--
-- Реестр — это деривация из tender_counterparty_proposals (отдельной таблицы нет):
-- каждая запись КП может дать расценку-материал и/или расценку-работу; одинаковые
-- базовые позиции (одно наименование+ед.изм в рамках тендера и контрагента),
-- встречающиеся в нескольких строках ВОР, схлопываются в одну (как делал фронт).
--
-- Чтобы пагинация/фильтры/сортировка/поиск считались в PostgreSQL (а не грузили весь
-- реестр в браузер), оформляем это представлением kp_rates_registry с дедупом через
-- DISTINCT ON. Фронт запрашивает только текущую страницу + count.

create extension if not exists pg_trgm;

-- Нормализация наименования — приближённо как normalizeKey() на фронте:
-- lower, ё→е, ²³→2/3, латинские двойники→кириллица, удаление кавычек/скобок,
-- схлопывание пробелов и точек. Используется только для группировки (дедупа).
create or replace function kp_norm_name(s text) returns text
language sql immutable as $$
  select trim(regexp_replace(
    regexp_replace(
      translate(
        replace(replace(replace(lower(coalesce(s, '')), 'ё', 'е'), '²', '2'), '³', '3'),
        'acepxyo', 'асерхуо'
      ),
      '[«»"''`()]', '', 'g'),
    '[\s.]+', ' ', 'g'))
$$;

-- Нормализация единицы измерения — приближённо как normalizeUnit() (синонимы).
create or replace function kp_norm_unit(u text) returns text
language sql immutable as $$
  select case kp_norm_name(u)
    when 'штук' then 'шт' when 'штука' then 'шт' when 'штуки' then 'шт'
    when 'комплект' then 'компл' when 'комплекта' then 'компл' when 'комплектов' then 'компл'
    when 'к-т' then 'компл' when 'к т' then 'компл'
    when 'кв м' then 'м2' when 'квм' then 'м2' when 'м кв' then 'м2'
    when 'куб м' then 'м3' when 'кубм' then 'м3' when 'м куб' then 'м3'
    when 'м п' then 'мп' when 'пог м' then 'мп' when 'погм' then 'мп'
    when 'п м' then 'мп' when 'пм' then 'мп' when 'м пог' then 'мп'
    else kp_norm_name(u)
  end
$$;

-- Базовые расценки реестра: материалы и работы как отдельные строки, с дедупом.
-- security_invoker=true → представление уважает RLS-политики нижележащих таблиц.
create or replace view kp_rates_registry
  with (security_invoker = true) as
with entries as (
  select
    p.id as proposal_id, 'material'::text as item_type,
    ei.cost_name as item_name, ei.unit as unit, p.unit_price_materials as price,
    p.tender_id, p.counterparty_id, p.proposal_date,
    t.object_id, t.work_description as tender_desc,
    o.name as object_name, c.name as counterparty_name
  from tender_counterparty_proposals p
  join tender_estimate_items ei on ei.id = p.estimate_item_id
  join tenders t on t.id = p.tender_id
  left join objects o on o.id = t.object_id
  left join counterparties c on c.id = p.counterparty_id
  where coalesce(ei.material_consumption, 0) > 0
    and coalesce(p.unit_price_materials, 0) > 0
    and kp_norm_name(ei.cost_name) <> ''
  union all
  select
    p.id, 'work', ei.cost_name, ei.unit, p.unit_price_works,
    p.tender_id, p.counterparty_id, p.proposal_date,
    t.object_id, t.work_description, o.name, c.name
  from tender_counterparty_proposals p
  join tender_estimate_items ei on ei.id = p.estimate_item_id
  join tenders t on t.id = p.tender_id
  left join objects o on o.id = t.object_id
  left join counterparties c on c.id = p.counterparty_id
  where coalesce(ei.work_volume, 0) > 0
    and coalesce(p.unit_price_works, 0) > 0
    and kp_norm_name(ei.cost_name) <> ''
)
select distinct on (tender_id, counterparty_id, item_type, kp_norm_name(item_name), kp_norm_unit(unit))
  md5(tender_id::text || '|' || counterparty_id::text || '|' || item_type || '|'
      || kp_norm_name(item_name) || '|' || kp_norm_unit(unit)) as id,
  item_type, item_name, unit, price,
  tender_id, counterparty_id, object_id, tender_desc, object_name, counterparty_name, proposal_date
from entries
order by tender_id, counterparty_id, item_type,
         kp_norm_name(item_name), kp_norm_unit(unit),
         proposal_date desc nulls last;

grant select on kp_rates_registry to authenticated, anon;

-- Лёгкий справочник единиц измерения для фильтра (загружается один раз).
create or replace view kp_rates_registry_units
  with (security_invoker = true) as
  select distinct unit from kp_rates_registry where unit is not null and unit <> '';

grant select on kp_rates_registry_units to authenticated, anon;

-- Индексы под фактические запросы страницы (ускоряют сканы/джойны вью).
create index if not exists idx_tcp_tender_id on tender_counterparty_proposals (tender_id);
create index if not exists idx_tcp_counterparty_id on tender_counterparty_proposals (counterparty_id);
create index if not exists idx_tcp_estimate_item_id on tender_counterparty_proposals (estimate_item_id);
create index if not exists idx_tcp_proposal_date on tender_counterparty_proposals (proposal_date desc);
create index if not exists idx_tcp_unit_price_materials on tender_counterparty_proposals (unit_price_materials);
create index if not exists idx_tcp_unit_price_works on tender_counterparty_proposals (unit_price_works);
-- Поиск по наименованию (ilike '%...%') — триграммный индекс на исходное cost_name.
create index if not exists idx_tei_cost_name_trgm on tender_estimate_items using gin (cost_name gin_trgm_ops);
create index if not exists idx_tei_unit on tender_estimate_items (unit);
create index if not exists idx_tenders_object_id on tenders (object_id);
