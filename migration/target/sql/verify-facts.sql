-- «Факты» о базе для сверки (migration/target/verify.sh): одна строка на факт — вид, ключ, значение
-- через табуляцию. Один и тот же файл выполняется на эталоне (копия, восстановленная со всеми ролями
-- Supabase) и на загруженной базе; строки обязаны совпасть. В значениях — только числа и контрольные
-- суммы, в ключах — имена объектов: данных пользователей в выводе нет.
--
-- Переменные psql:
--   with_rights — 1: политики и выданные права сравниваются; 0: загрузка была без прав, раздел пропущен;
--   acl_role    — чьи права сравниваем: authenticated на эталоне, роль приложения на загруженной базе;
--   drop_roles  — роли, которые не переносятся (через запятую): политики только для них пропускаются.
-- Только чтение: транзакция READ ONLY.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
-- Одинаковый текст значений на обеих сторонах: время в UTC, имена — со схемой.
SET LOCAL TIME ZONE 'UTC';
SET LOCAL datestyle = 'ISO, MDY';
SET LOCAL intervalstyle = 'postgres';
SET LOCAL extra_float_digits = 1;
SET LOCAL bytea_output = 'hex';
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '280s';
-- Сверяет владелец: политики на него не действуют. Если подействуют — пусть будет ошибка, а не неполный счёт.
SET LOCAL row_security = off;

-- 1. Данные: точное число строк и контрольная сумма каждой таблицы и материализованного представления.
--    Сумма не зависит от порядка строк: хэши строк сортируются.
select 'rows' || E'\t' || c.relname || E'\t'
    || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p', 'm') and not c.relispartition
order by c.relname;

--    Материализованное представление с уникальным индексом сверяется по колонкам этого индекса — по составу
--    строк. Его содержимое строится заново из таблиц (они сверены выше) по определению (сверено в разделе 3),
--    а выбор строки среди равных по порядку определение может не задавать: у kp_rates_registry_mv при
--    равной дате КП попадает любое из предложений (supabase/migrations/20261015_rates_registry_deterministic.sql),
--    и эталон с базой выбирают по-разному. Без уникального индекса — целиком, как таблица.
--    В app_settings не сверяется отметка пересчёта реестра (rates_registry_refreshed_at): её пишет
--    refresh_rates_registry(), а не люди, — по расписанию и на эталоне, и в базе.
select 'sum' || E'\t' || c.relname || E'\t'
    || (xpath('/row/h/text()', query_to_xml(format(
         'select md5(coalesce(string_agg(md5(%1$s::text), '''' order by md5(%1$s::text) collate "C"), '''')) as h from public.%2$I t%3$s',
         coalesce(k.expr, 't'), c.relname,
         case when c.relname = 'app_settings' then ' where t.key is distinct from ''rates_registry_refreshed_at''' else '' end),
         false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join lateral (
  select 'row(' || string_agg('t.' || quote_ident(a.attname), ', ' order by u.ord) || ')' as expr
  from (select i.indkey from pg_index i
        where i.indrelid = c.oid and i.indisunique and i.indpred is null and i.indexprs is null
        order by i.indexrelid::regclass::text limit 1) ix
  cross join lateral unnest(ix.indkey::int2[]) with ordinality u(attnum, ord)
  join pg_attribute a on a.attrelid = c.oid and a.attnum = u.attnum
) k on c.relkind = 'm'
where n.nspname = 'public' and c.relkind in ('r', 'p', 'm') and not c.relispartition
order by c.relname;

-- 2. Счётчики номеров: после переноса новые номера продолжают прежние.
select 'seq' || E'\t' || sequencename || E'\t' || coalesce(last_value::text, 'не использован')
    || ':' || start_value || ':' || increment_by
from pg_sequences where schemaname = 'public' order by sequencename;

-- 3. Структура.
select 'col' || E'\t' || c.relname || '.' || a.attname || E'\t'
    || md5(format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || a.attidentity::text || '|' || a.attgenerated::text
           || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''))
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
order by 1;

select 'con' || E'\t' || c.relname || '.' || k.conname || E'\t' || md5(k.contype::text || '|' || pg_get_constraintdef(k.oid, true))
from pg_constraint k
join pg_class c on c.oid = k.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
order by 1;

select 'idx' || E'\t' || i.relname || E'\t' || md5(pg_get_indexdef(x.indexrelid))
from pg_index x
join pg_class i on i.oid = x.indexrelid
join pg_namespace n on n.oid = i.relnamespace
where n.nspname = 'public'
order by 1;

select 'trg' || E'\t' || c.relname || '.' || t.tgname || E'\t' || md5(pg_get_triggerdef(t.oid, true) || '|' || t.tgenabled::text)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
order by 1;

select 'fn' || E'\t' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || E'\t' || md5(pg_get_functiondef(p.oid))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f', 'p')
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
order by 1;

select 'view' || E'\t' || c.relname || E'\t' || md5(c.relkind::text || '|' || pg_get_viewdef(c.oid, true))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v', 'm')
order by 1;

select 'type' || E'\t' || t.typname || E'\t'
    || md5(t.typtype::text || '|' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), ''))
from pg_type t join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' and t.typtype in ('e', 'd', 'r')
  and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
order by 1;

-- 4. Права. Включена ли защита строк — часть структуры, сравнивается всегда.
select 'rls' || E'\t' || c.relname || E'\t' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by 1;

\if :with_rights
-- Политики: команда, роли, условия.
select 'policy' || E'\t' || p.tablename || '.' || p.policyname || E'\t'
    || md5(p.cmd::text || '|' || p.permissive::text || '|'
           || array_to_string(array(
                select case when r::text = :'acl_role' then 'ПРИЛОЖЕНИЕ' else r::text end
                from unnest(p.roles) r
                where r::text <> all (string_to_array(:'drop_roles', ','))
                order by 1), ',')
           || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
from pg_policies p
where p.schemaname = 'public'
  and exists (select 1 from unnest(p.roles) r where r::text <> all (string_to_array(:'drop_roles', ',')))
order by 1;

-- Выданные права роли приложения: таблицы, представления, счётчики, колонки, функции, схема.
select 'grant' || E'\t' || 'rel:' || c.relname || E'\t'
    || string_agg(a.privilege_type || case when a.is_grantable then '*' else '' end, ',' order by a.privilege_type)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) a
join pg_roles g on g.oid = a.grantee
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S') and g.rolname = :'acl_role'
group by c.relname
order by 1;

select 'grant' || E'\t' || 'col:' || c.relname || '.' || t.attname || E'\t'
    || string_agg(a.privilege_type, ',' order by a.privilege_type)
from pg_attribute t
join pg_class c on c.oid = t.attrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(t.attacl) a
join pg_roles g on g.oid = a.grantee
where n.nspname = 'public' and g.rolname = :'acl_role' and not t.attisdropped
group by c.relname, t.attname
order by 1;

select 'grant' || E'\t' || 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || E'\t'
    || 'приложению:' || has_function_privilege(:'acl_role', p.oid, 'EXECUTE')::text
    || ';всем:' || (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f', 'p')
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
order by 1;

select 'grant' || E'\t' || 'schema:public' || E'\t'
    || 'USAGE:' || has_schema_privilege(:'acl_role', 'public', 'USAGE')::text
    || ';CREATE:' || has_schema_privilege(:'acl_role', 'public', 'CREATE')::text;
\endif

ROLLBACK;
