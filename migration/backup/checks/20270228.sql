-- Проверка после 20270228_signal_integration.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение и только каталог (таблиц сверки не читает — правила по строкам закрывают их для всех, кроме служебных функций):
-- до миграции отвечает FAIL, а не падает. Выполняется на копии (rehearse.sh) и на боевой базе Яндекса под учёткой-владельцем
-- (psql) после миграции. Поведение функций, права и границы — tests/db/signal-migration.test.mjs.
with
tbl(t) as (values ('signal_meta'), ('signal_sources'), ('signal_bindings'), ('signal_nodes'), ('signal_stage_nodes'), ('signal_runs'),
                  ('signal_contracts'), ('signal_candidates'), ('signal_aliases'), ('signal_queue')),
rel as (
  select t.t, c.oid, c.relrowsecurity, c.relforcerowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
         (select count(*) from pg_policy p where p.polrelid = c.oid and p.polname = 'osp_internal'
            and pg_get_expr(p.polqual, p.polrelid) like '%osp_private.bypass()%'
            and pg_get_expr(p.polwithcheck, p.polrelid) like '%osp_private.bypass()%') as internal_policies
  from tbl t
  left join pg_class c on c.oid = to_regclass('osp_private.' || t.t) and c.relkind = 'r'
),
fn as (
  select p.oid, p.proname, p.prosecdef, coalesce(p.proconfig, '{}') as cfg, p.prosrc, p.provolatile, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'osp_private' and p.proname like 'signal\_%'
),
service(f) as (values ('signal_sync_due'), ('signal_sync_begin'), ('signal_sync_heartbeat'), ('signal_stage_put'), ('signal_sync_fail'),
                      ('signal_sync_finish'), ('signal_accept_held'), ('signal_sources_for_sync'), ('signal_enqueue_all'), ('signal_enqueue_missed'),
                      ('signal_queue_claim'), ('signal_queue_release'), ('signal_match_load'), ('signal_match_nodes'), ('signal_state_write')),
usr(f) as (values ('signal_user_flags'), ('signal_marks'), ('signal_contract_view'), ('signal_folders_search'), ('signal_confirm'),
                  ('signal_reject'), ('signal_unlink'), ('signal_alias_create'), ('signal_alias_delete'), ('signal_alias_list'),
                  ('signal_admin_state'), ('signal_runs'), ('signal_source_add'), ('signal_source_update'), ('signal_binding_set'),
                  ('signal_unassigned'), ('signal_tree'), ('signal_bindings_list'), ('signal_binding_preview')),
internal(f) as (values ('signal_require'), ('signal_contract_ok'), ('signal_node_visible'), ('signal_actor'), ('signal_node_json'),
                       ('signal_enqueue_impl'), ('signal_publish'), ('signal_mark_root_errors'), ('signal_recompute_objects'),
                       ('signal_contract_input'), ('signal_run_json'), ('signal_jsonb_texts'), ('signal_jsonb_uuids'), ('signal_like_escape'),
                       ('signal_norm_link'), ('signal_name_key'), ('signal_alias_clash'), ('signal_tree_item'), ('signal_audit_row'),
                       ('signal_enqueue_trg')),
trg as (
  select t.tgname, (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = t.tgrelid) as rel,
         t.tgenabled, pg_get_triggerdef(t.oid) as def
  from pg_trigger t
  where not t.tgisinternal and t.tgfoid = coalesce(to_regproc('osp_private.signal_enqueue_trg'), 0::regproc)
),
audit as (
  select (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = t.tgrelid) as rel
  from pg_trigger t
  where not t.tgisinternal and t.tgname = 'osp_data_audit' and t.tgfoid = coalesce(to_regproc('osp_private.signal_audit_row'), 0::regproc)
),
checks(n, ok, what) as (
  select 1, (select count(*) from rel where oid is not null) = 10,
         'десять таблиц в закрытой схеме osp_private: signal_meta, sources, bindings, nodes, stage_nodes, runs, contracts, candidates, aliases, queue'
  union all
  select 2, (select count(*) from rel where relrowsecurity and relforcerowsecurity) = 10,
         'правила по строкам включены и действуют на владельца у всех десяти таблиц'
  union all
  select 3, (select count(*) from rel where policies = 1 and internal_policies = 1) = 10,
         'у каждой таблицы единственная политика — пропуск служебных функций (osp_internal), для пользователей и шлюза правил нет'
  union all
  select 4, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'osp_private' and c.relname like 'signal\_%' and c.relkind in ('v', 'm')) = 0
            and coalesce((select has_schema_privilege('public', n.nspname, 'USAGE') from pg_namespace n where n.nspname = 'osp_private'), true) is false,
         'закрытая схема «всем» недоступна, представлений нет — таблицы и функции в шлюз не публикуются'
  union all
  select 5, exists (select 1 from information_schema.columns where table_schema = 'osp_private' and table_name = 'signal_meta'
                      and column_name = 'schema_version' and column_default = '1')
            and exists (select 1 from pg_constraint where conrelid = to_regclass('osp_private.signal_meta') and contype = 'c' and pg_get_constraintdef(oid) like '%id = 1%'),
         'signal_meta: одна строка (id = 1), версия схемы 1 по умолчанию'
  union all
  select 6, to_regclass('osp_private.signal_revision_seq') is not null
            and (select count(*) from rel where t = 'signal_queue' and oid is not null) = 1
            and exists (select 1 from information_schema.columns where table_schema = 'osp_private' and table_name = 'signal_queue'
                          and column_name = 'recheck_only' and data_type = 'boolean' and is_nullable = 'NO'),
         'последовательность ревизий очереди signal_revision_seq и сама очередь (с признаком плановой пересверки recheck_only)'
  union all
  select 7, (select count(*) from usr u join fn on fn.proname = u.f) = 19 and (select count(*) from service s join fn on fn.proname = s.f) = 15
            and (select count(*) from internal i join fn on fn.proname = i.f) = 20 and (select count(*) from fn) = 54,
         'функции: 15 служебных, 19 пользовательских и 20 внутренних на месте, лишних signal_* нет'
  union all
  select 8, (select count(*) from fn where prosecdef) = (select count(*) from fn where 'application_name=osp:internal' = any (cfg))
            and (select count(*) from fn where prosecdef and not ('application_name=osp:internal' = any (cfg))) = 0
            and (select count(*) from fn where not prosecdef and 'application_name=osp:internal' = any (cfg)) = 0
            and (select count(*) from fn where prosecdef) >= 40,
         'отметка пропуска — у всех служебных (SECURITY DEFINER) функций signal_* и только у них'
  union all
  select 9, (select count(*) from fn where prosecdef and not exists (select 1 from unnest(cfg) c where c like 'search_path=osp_private, public, pg_temp%')) = 0,
         'у каждой служебной функции фиксированный search_path = osp_private, public, pg_temp'
  union all
  select 10, (select count(*) from service s join fn on fn.proname = s.f
              where fn.prosecdef and fn.prosrc ~ 'BEGIN\s+IF auth\.uid\(\) IS NOT NULL THEN\s+RAISE EXCEPTION USING ERRCODE = ''SG403''') = 15,
         'служебные функции первой проверкой отказывают при непустом auth.uid() (SG403)'
  union all
  select 11, (select count(*) from usr u join fn on fn.proname = u.f
              where fn.prosrc like '%signal_require(%' or fn.prosrc like '%auth.uid()%') = 19,
         'пользовательские функции проверяют вошедшего и право раздела (signal_require / auth.uid)'
  union all
  select 12, (select count(*) from trg where rel in ('public.contracts', 'public.contract_counterparties', 'public.objects') and tgenabled <> 'D') = 7
            and exists (select 1 from trg where rel = 'public.contracts' and tgname = 'osp_signal_enqueue_ins' and def like '%AFTER INSERT%')
            and exists (select 1 from trg where rel = 'public.contracts' and tgname = 'osp_signal_enqueue_upd' and def like '%AFTER UPDATE OF%' and def like '%WHEN%')
            and exists (select 1 from trg where rel = 'public.contracts' and tgname = 'osp_signal_enqueue_del' and def like '%AFTER DELETE%')
            and exists (select 1 from trg where rel = 'public.contract_counterparties' and tgname = 'osp_signal_enqueue_ins')
            and exists (select 1 from trg where rel = 'public.contract_counterparties' and tgname = 'osp_signal_enqueue_upd')
            and exists (select 1 from trg where rel = 'public.contract_counterparties' and tgname = 'osp_signal_enqueue_del')
            and exists (select 1 from trg where rel = 'public.objects' and tgname = 'osp_signal_enqueue_upd' and def like '%name%' and def like '%contract_code%'),
         'триггеры очереди: договоры (вставка, правка значимых колонок, удаление), стороны (вставка, правка, удаление), объекты (имя, код)'
  union all
  select 13, exists (select 1 from fn where proname = 'signal_enqueue_trg' and prosecdef and 'lock_timeout=250ms' = any (cfg)),
         'триггер очереди: lock_timeout 250 мс, не ждёт заблокированную очередь'
  union all
  select 14, (select count(*) from fn where proname = 'signal_enqueue_trg' and prosrc like '%EXCEPTION WHEN OTHERS%' and prosrc like '%signal_enqueue_skipped%' and prosrc like '%RETURN NULL%') = 1,
         'триггер очереди никогда не отказывает: любая ошибка — предупреждение signal_enqueue_skipped'
  union all
  select 15, (select count(*) from audit where rel in ('osp_private.signal_sources', 'osp_private.signal_bindings', 'osp_private.signal_aliases')) = 3
            and exists (select 1 from fn where proname = 'signal_audit_row' and not prosecdef),
         'журнал базы подключён к корням, привязкам и синонимам (узлы, очередь, состояния — не аудируются)'
  union all
  select 16, exists (select 1 from pg_indexes where schemaname = 'osp_private' and tablename = 'signal_runs' and indexname = 'signal_runs_one_running'
                       and indexdef like '%(true)%' and indexdef like '%running%')
            and exists (select 1 from pg_indexes where schemaname = 'osp_private' and tablename = 'signal_bindings' and indexname = 'signal_bindings_subtree_uniq' and indexdef like '%node_id IS NOT NULL%')
            and exists (select 1 from pg_constraint where conrelid = to_regclass('osp_private.signal_bindings') and conname = 'signal_bindings_uniq' and pg_get_constraintdef(oid) like '%NULLS NOT DISTINCT%')
            and exists (select 1 from pg_constraint where conrelid = to_regclass('osp_private.signal_aliases') and contype = 'u' and pg_get_constraintdef(oid) like '%alias_key%'),
         'один идущий прогон; одна привязка на поддерево; корневые привязки не повторяются; ключ синонима уникален'
  union all
  select 17, (select count(*) from pg_constraint c
              where c.contype = 'f' and c.confdeltype = 'c' and c.confrelid = 'public.contracts'::regclass
                and c.conrelid in (to_regclass('osp_private.signal_contracts'), to_regclass('osp_private.signal_candidates'), to_regclass('osp_private.signal_queue'))) = 3
            and (select count(*) from pg_constraint c
                 where c.contype = 'f' and c.confdeltype = 'c' and c.confrelid = 'public.objects'::regclass
                   and c.conrelid in (to_regclass('osp_private.signal_bindings'), to_regclass('osp_private.signal_aliases'))) = 2,
         'состояния, кандидаты и очередь уходят вместе с договором, привязки и синонимы — вместе с объектом'
  union all
  select 18, exists (select 1 from pg_constraint where conrelid = to_regclass('osp_private.signal_contracts') and contype = 'c'
                       and pg_get_constraintdef(oid) like '%none%' and pg_get_constraintdef(oid) like '%suggested%' and pg_get_constraintdef(oid) like '%verified%'
                       and pg_get_constraintdef(oid) like '%unverified%' and pg_get_constraintdef(oid) like '%attention%'
                       and pg_get_constraintdef(oid) like '%missing%' and pg_get_constraintdef(oid) like '%conflict%'
                       and pg_get_constraintdef(oid) like '%accepted%'),
         'состояние сверки — одно из восьми: none, suggested, verified, accepted, unverified, attention, missing, conflict'
  union all
  select 19, not exists (select 1 from information_schema.role_table_grants g
                         where g.table_schema = 'osp_private' and g.table_name like 'signal\_%' and g.grantee = 'PUBLIC'),
         'таблицы signal_* не выданы «всем»'
  union all
  select 20, not exists (select 1 from fn where has_function_privilege('public', fn.oid, 'EXECUTE')),
         'ни одна функция signal_* не выдана «всем» (REVOKE ALL FROM PUBLIC): исполняет только учётка подключения osp-api'
  union all
  select 21, (select count(*) from fn where proname in ('signal_node_json', 'signal_contract_input', 'signal_publish', 'signal_mark_root_errors')
                and prosrc ~ 'BEGIN\s+IF auth\.uid\(\) IS NOT NULL THEN\s+RAISE EXCEPTION USING ERRCODE = ''SG403''') = 4
            and (select count(*) from fn where proname in ('signal_recompute_objects', 'signal_enqueue_impl', 'signal_alias_clash')
                   and prosrc ~ 'BEGIN\s+IF auth\.uid\(\) IS NOT NULL AND NOT') = 3
            and exists (select 1 from fn where proname = 'signal_contract_ok' and prosrc like '%auth.uid() IS NULL%' and prosrc like '%osp_can%')
            and exists (select 1 from fn where proname = 'signal_node_visible' and prosrc like '%signal_contract_ok(%'),
         'внутренние помощники не отдают чужого при прямом вызове: службе — SG403, правке и админу — проверка права, охват — через договор'
  union all
  select 22, (select count(*) from information_schema.columns
              where table_schema = 'osp_private'
                and ((table_name = 'signal_nodes' and column_name in ('object_path', 'problem'))
                  or (table_name = 'signal_stage_nodes' and column_name = 'problem')
                  or (table_name = 'signal_sources' and column_name = 'failed_since')
                  or (table_name = 'signal_candidates' and column_name in ('node_key', 'prev_status', 'prev_decided_by', 'prev_decided_at', 'prev_note')))) = 9,
         'колонки границы и сбоев: signal_nodes.object_path / problem, signal_stage_nodes.problem, signal_sources.failed_since, signal_candidates.node_key и prev_*'
  union all
  select 23, exists (select 1 from pg_constraint where conrelid = to_regclass('osp_private.signal_runs') and contype = 'c'
                       and pg_get_constraintdef(oid) like '%partial%' and pg_get_constraintdef(oid) like '%running%'),
         'статус прогона: running, ok, partial (часть корней), held, failed, cancelled'
  union all
  select 24, (select count(*) from fn where (proname = 'signal_confirm' and args like '%p_expected_revision bigint')
                                           or (proname = 'signal_unlink' and args like '%p_expected_revision bigint, p_node_key text')
                                           or (proname = 'signal_reject' and args like '%p_node_key text')
                                           or (proname = 'signal_publish' and args = 'p_run bigint, p_roots bigint[]')) = 4
            and (select count(*) from fn where proname in ('signal_confirm', 'signal_unlink', 'signal_reject', 'signal_publish')) = 4,
         'новые параметры confirm / unlink / reject в конце списка, прежних перегрузок нет (повтор миграции не плодит функции)'
  union all
  select 25, (select count(*) from pg_indexes where schemaname = 'osp_private' and tablename = 'signal_stage_nodes' and indexname = 'signal_stage_nodes_source_idx') = 1,
         'индекс staging по корню (для состояния корня «отложен»)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
