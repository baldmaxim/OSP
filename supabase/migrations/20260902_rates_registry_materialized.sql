-- Реестр расценок: материализация вместо пересчёта на каждый запрос.
--
-- ПРОБЛЕМА. kp_rates_registry (миграция 20260610) — обычное представление:
-- CTE с UNION ALL из двух веток, в каждой join пяти таблиц, поверх — DISTINCT ON
-- по пяти выражениям, два из которых вызовы kp_norm_name()/kp_norm_unit().
-- Индекса по этим выражениям нет и при таком построении быть не может, поэтому
-- КАЖДЫЙ запрос сортирует весь набор целиком.
--
-- Одно открытие страницы давало ШЕСТЬ таких прогонов: страница данных, два
-- count-а подвкладок и три справочника фильтров (они читают из этого же вью и
-- делают поверх ещё DISTINCT). Отсюда и миграция 20260805, поднявшая
-- statement_timeout до 30 c, — она лечила симптом.
--
-- РЕШЕНИЕ. Считаем реестр заранее и храним готовым:
--   kp_rates_registry_mv / supply_rates_registry_mv — материализованные копии;
--   kp_rates_registry / supply_rates_registry — тонкие вью поверх них, поэтому
--   весь остальной код (страница, экспорт, edge-функция rates-api) продолжает
--   обращаться к прежним именам без единой правки.
--
-- ЗАПРОС SELECT В MV — ДОСЛОВНАЯ КОПИЯ существующих вью (20260610 и 20260611).
-- Менять его здесь нельзя: результат обязан совпасть со старым до строки.
--
-- ДОСТУП. У материализованных представлений нет RLS и не работает
-- security_invoker: они читаются напрямую. Старым вью грант выдавался и роли
-- anon, но миграция 20260614 анонимный доступ к данным закрыла — просто
-- перенести грант «как было» значило бы тихо вернуть анонимам цены подрядчиков.
-- Поэтому здесь только authenticated, а anon явно отзывается.
--
-- ОБНОВЛЕНИЕ. refresh_rates_registry() + расписание pg_cron каждые 10 минут и
-- кнопка «Обновить» на странице. Первый REFRESH на большой базе идёт долго — это
-- тот же полный прогон, но один раз, а не на каждое открытие.
--
-- Миграция идемпотентна.

-- Явный search_path на всю миграцию. Без него в SQL-редакторе Supabase
-- неквалифицированные имена могут не найтись — именно на этом падала первая
-- версия («function kp_norm_name(text) does not exist»). extensions нужна
-- отдельно: там у Supabase живёт gin_trgm_ops для триграммных индексов.
set search_path = public, extensions;

create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Функции нормализации
-- ─────────────────────────────────────────────────────────────────────────────
-- Пересоздаём их здесь по двум причинам.
--
-- 1) Миграция становится самодостаточной: если 20260610 в этой базе не
--    применялась, функций попросту нет.
-- 2) Внутри kp_norm_unit вызов был НЕквалифицированным (`kp_norm_name(u)`), и
--    при инлайнинге тела Postgres искал функцию по текущему search_path. В
--    SQL-редакторе Supabase он другой, чем при применении 20260610, — отсюда
--    «function kp_norm_name(text) does not exist ... during inlining».
--    Теперь имя указано со схемой, и резолвинг не зависит от search_path.
--
-- SET search_path на самих функциях НЕ ставим намеренно: это запретило бы
-- инлайнинг SQL-функций, а они вызываются на каждой строке при построении MV.
--
-- Тела совпадают с 20260610 дословно, кроме квалификации имени.
create or replace function public.kp_norm_name(s text) returns text
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

create or replace function public.kp_norm_unit(u text) returns text
language sql immutable as $$
  select case public.kp_norm_name(u)
    when 'штук' then 'шт' when 'штука' then 'шт' when 'штуки' then 'шт'
    when 'комплект' then 'компл' when 'комплекта' then 'компл' when 'комплектов' then 'компл'
    when 'к-т' then 'компл' when 'к т' then 'компл'
    when 'кв м' then 'м2' when 'квм' then 'м2' when 'м кв' then 'м2'
    when 'куб м' then 'м3' when 'кубм' then 'м3' when 'м куб' then 'м3'
    when 'м п' then 'мп' when 'пог м' then 'мп' when 'погм' then 'мп'
    when 'п м' then 'мп' when 'пм' then 'мп' when 'м пог' then 'мп'
    else public.kp_norm_name(u)
  end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Расценки из КП подрядчиков
-- ─────────────────────────────────────────────────────────────────────────────

-- Вью придётся снести: заменить его на «select * from mv» через CREATE OR REPLACE
-- нельзя — у нового запроса другой источник, Postgres на это ругается.
-- Зависимые вью (units/filter_*) пересоздаются ниже, поэтому CASCADE безопасен.
drop view if exists kp_rates_registry_units cascade;
drop view if exists kp_rates_registry_filter_objects cascade;
drop view if exists kp_rates_registry_filter_counterparties cascade;
drop view if exists kp_rates_registry_filter_tenders cascade;
drop view if exists kp_rates_registry cascade;

drop materialized view if exists kp_rates_registry_mv cascade;
create materialized view kp_rates_registry_mv as
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
    and public.kp_norm_name(ei.cost_name) <> ''
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
    and public.kp_norm_name(ei.cost_name) <> ''
)
select distinct on (tender_id, counterparty_id, item_type, public.kp_norm_name(item_name), public.kp_norm_unit(unit))
  md5(tender_id::text || '|' || counterparty_id::text || '|' || item_type || '|'
      || public.kp_norm_name(item_name) || '|' || public.kp_norm_unit(unit)) as id,
  item_type, item_name, unit, price,
  tender_id, counterparty_id, object_id, tender_desc, object_name, counterparty_name, proposal_date
from entries
order by tender_id, counterparty_id, item_type,
         public.kp_norm_name(item_name), public.kp_norm_unit(unit),
         proposal_date desc nulls last;

-- UNIQUE обязателен для REFRESH ... CONCURRENTLY: без него обновление берёт
-- блокировку и страница на это время встаёт. id — md5 от ключа дедупликации,
-- то есть уже уникален по построению.
create unique index if not exists idx_kp_rates_mv_id on kp_rates_registry_mv (id);
-- Сортировка по умолчанию на странице.
create index if not exists idx_kp_rates_mv_type_name on kp_rates_registry_mv (item_type, item_name, id);
create index if not exists idx_kp_rates_mv_object on kp_rates_registry_mv (object_id);
create index if not exists idx_kp_rates_mv_counterparty on kp_rates_registry_mv (counterparty_id);
create index if not exists idx_kp_rates_mv_tender on kp_rates_registry_mv (tender_id);
create index if not exists idx_kp_rates_mv_price on kp_rates_registry_mv (price);
create index if not exists idx_kp_rates_mv_date on kp_rates_registry_mv (proposal_date desc nulls last);
-- Поиск ilike '%…%' по готовому наименованию. Триграммные индексы на базовых
-- таблицах планировщик через DISTINCT ON + UNION ALL не использовал.
create index if not exists idx_kp_rates_mv_name_trgm
  on kp_rates_registry_mv using gin (item_name gin_trgm_ops);

-- Тонкая обёртка под прежним именем — ради совместимости со всем кодом.
create view kp_rates_registry as select * from kp_rates_registry_mv;

create view kp_rates_registry_units as
  select distinct unit from kp_rates_registry_mv where unit is not null and unit <> '';

create view kp_rates_registry_filter_objects as
  select distinct r.object_id, o.name as object_name
  from kp_rates_registry_mv r
  join objects o on o.id = r.object_id
  where r.object_id is not null;

create view kp_rates_registry_filter_counterparties as
  select distinct r.counterparty_id, c.name as counterparty_name
  from kp_rates_registry_mv r
  join counterparties c on c.id = r.counterparty_id
  where r.counterparty_id is not null;

create view kp_rates_registry_filter_tenders as
  select distinct r.tender_id, r.tender_desc, r.object_id
  from kp_rates_registry_mv r
  where r.tender_id is not null
    and coalesce(r.tender_desc, '') <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Расценки снабжения СУ-10
-- ─────────────────────────────────────────────────────────────────────────────

drop view if exists supply_rates_registry_units cascade;
drop view if exists supply_rates_registry_filter_objects cascade;
drop view if exists supply_rates_registry_filter_tenders cascade;
drop view if exists supply_rates_registry cascade;

drop materialized view if exists supply_rates_registry_mv cascade;
create materialized view supply_rates_registry_mv as
select distinct on (sr.tender_id, public.kp_norm_name(sr.material_name), public.kp_norm_unit(sr.unit))
  md5(sr.tender_id::text || '|' || public.kp_norm_name(sr.material_name) || '|' || public.kp_norm_unit(sr.unit)) as id,
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
where public.kp_norm_name(sr.material_name) <> ''
order by sr.tender_id, public.kp_norm_name(sr.material_name), public.kp_norm_unit(sr.unit),
         coalesce(sr.updated_at, sr.created_at) desc nulls last;

create unique index if not exists idx_supply_rates_mv_id on supply_rates_registry_mv (id);
create index if not exists idx_supply_rates_mv_name on supply_rates_registry_mv (item_name, id);
create index if not exists idx_supply_rates_mv_object on supply_rates_registry_mv (object_id);
create index if not exists idx_supply_rates_mv_tender on supply_rates_registry_mv (tender_id);
create index if not exists idx_supply_rates_mv_price on supply_rates_registry_mv (price);
create index if not exists idx_supply_rates_mv_date on supply_rates_registry_mv (rate_date desc nulls last);
create index if not exists idx_supply_rates_mv_name_trgm
  on supply_rates_registry_mv using gin (item_name gin_trgm_ops);

create view supply_rates_registry as select * from supply_rates_registry_mv;

create view supply_rates_registry_units as
  select distinct unit from supply_rates_registry_mv where unit is not null and unit <> '';

create view supply_rates_registry_filter_objects as
  select distinct r.object_id, r.object_name
  from supply_rates_registry_mv r
  where r.object_id is not null;

create view supply_rates_registry_filter_tenders as
  select distinct r.tender_id, r.tender_desc, r.object_id
  from supply_rates_registry_mv r
  where r.tender_id is not null
    and coalesce(r.tender_desc, '') <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Права: только вошедшие пользователи
-- ─────────────────────────────────────────────────────────────────────────────

grant select on
  kp_rates_registry_mv, kp_rates_registry, kp_rates_registry_units,
  kp_rates_registry_filter_objects, kp_rates_registry_filter_counterparties,
  kp_rates_registry_filter_tenders,
  supply_rates_registry_mv, supply_rates_registry, supply_rates_registry_units,
  supply_rates_registry_filter_objects, supply_rates_registry_filter_tenders
  to authenticated;

revoke all on
  kp_rates_registry_mv, kp_rates_registry, kp_rates_registry_units,
  kp_rates_registry_filter_objects, kp_rates_registry_filter_counterparties,
  kp_rates_registry_filter_tenders,
  supply_rates_registry_mv, supply_rates_registry, supply_rates_registry_units,
  supply_rates_registry_filter_objects, supply_rates_registry_filter_tenders
  from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Обновление реестра
-- ─────────────────────────────────────────────────────────────────────────────

-- security definer: REFRESH требует прав владельца материализованного
-- представления, а вызывают функцию обычные сотрудники.
-- search_path прибит явно — обязательная мера для security definer, иначе вызов
-- можно увести на подставные объекты из чужой схемы.
create or replace function public.refresh_rates_registry()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
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

grant execute on function public.refresh_rates_registry() to authenticated;

comment on function public.refresh_rates_registry() is
  'Пересчитывает материализованные представления реестра расценок и пишет отметку времени в app_settings';

-- Расписание. pg_cron включается в панели Supabase (Database → Extensions);
-- если расширения нет, миграция не падает — остаётся кнопка «Обновить».
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Пересоздаём задание, чтобы миграция была идемпотентной.
    perform cron.unschedule('refresh-rates-registry')
    where exists (select 1 from cron.job where jobname = 'refresh-rates-registry');

    perform cron.schedule(
      'refresh-rates-registry',
      '*/10 * * * *',
      -- Имя со схемой: search_path у планировщика cron свой.
      $cron$select public.refresh_rates_registry();$cron$
    );
  else
    raise notice 'pg_cron недоступен: реестр будет обновляться только кнопкой «Обновить» на странице';
  end if;
exception when others then
  -- Расписание — не обязательная часть: без него реестр обновляется кнопкой.
  -- Ловим любую ошибку, чтобы вся миграция из-за pg_cron не откатилась (на части
  -- планов Supabase расширение включается только из панели).
  raise notice 'Не удалось настроить расписание pg_cron (%). Включите расширение в Database → Extensions и выполните блок ещё раз.', sqlerrm;
end;
$$;

-- Первое наполнение. Без CONCURRENTLY: сразу после создания представление ещё
-- не заполнено, и параллельный вариант на пустом MV работать не может.
refresh materialized view kp_rates_registry_mv;
refresh materialized view supply_rates_registry_mv;

insert into app_settings (key, value, updated_at)
values ('rates_registry_refreshed_at', now()::text, now())
on conflict (key) do update
  set value = excluded.value, updated_at = excluded.updated_at;

comment on materialized view kp_rates_registry_mv is
  'Реестр расценок из КП подрядчиков (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
comment on materialized view supply_rates_registry_mv is
  'Реестр расценок снабжения СУ-10. Обновляется refresh_rates_registry()';
