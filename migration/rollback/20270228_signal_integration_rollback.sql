-- АВАРИЙНЫЙ ОТКАТ 20270228_signal_integration (только база Яндекса): сверка договоров с SIGNAL исчезает целиком — триггеры очереди
-- на contracts / contract_counterparties / objects, функции osp_private.signal_*, десять таблиц и последовательность ревизий.
-- Портал работает как до миграции: правка договоров, ДС, сторон и объектов никак не зависит от сверки (триггеры и так не
-- отказывают, а после отката их просто нет); сервер osp-api без схемы (signal_meta) отвечает «сверка не включена» (status —
-- {enabled:false}, остальные маршруты 503) и таймеры не запускает — перезапускать его для этого не нужно, проверка схемы идёт
-- раз в 5 минут. Выкладку osp-api с SIGNAL_SYNC=1 после отката лучше выключить (SIGNAL_SYNC=0).
-- НЕ ТРОГАЕТСЯ: contracts.signal_link (ссылки остаются как были, в том числе подтверждённые человеком через окно сверки), «История»
-- договоров (события contract_audit_log «Signal: …» остаются — историю не исправляют) и журнал базы osp_private.data_audit_log.
-- ТЕРЯЕТСЯ: корни обхода и их объекты, привязки поддеревьев (разметка границ любой глубины), синонимы объектов, снимок папок и
-- файлов SIGNAL (с путями от границы и пометками проблемных папок), состояния сверки, отклонённые и снятые пары (с прежними решениями),
-- очередь и журнал прогонов. Все функции osp_private.signal_* (включая добавленные правками после ревью: signal_tree,
-- signal_bindings_list, signal_binding_preview, signal_enqueue_missed, signal_norm_link, signal_name_key, …) уходят по каталогу. Перед откатом снимите настройки выгрузкой (имена — только
-- для того, кто откатывает; в чат и репозиторий не класть):
--   select id, project_name, root_path, enabled from osp_private.signal_sources;
--   select s.id as source_id, o.name from osp_private.signal_bindings b join osp_private.signal_sources s on s.id = b.source_id
--     join public.objects o on o.id = b.object_id where b.node_id is null;
--   select a.alias_text, o.name from osp_private.signal_aliases a join public.objects o on o.id = a.object_id;
-- Для повторной выкладки через migrate.sh удалите запись миграции (иначе она будет считаться применённой; как у других откатов
-- строка в osp_meta.schema_migrations остаётся):
--   delete from osp_meta.schema_migrations where name = '20270228_signal_integration';
-- Сам файл миграции при повторном применении безопасен и после отката (всё создаётся заново, signal_meta получит поколение 0).
-- psql под учёткой-владельцем с отметкой служебной операции (иначе правила по строкам скроют строки таблиц при проверке):
--   select pg_catalog.set_config('application_name', 'osp:internal', false);  -- до BEGIN
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- 1. Триггеры очереди и журнала (журнальные уходят и вместе с таблицами — снимаем явно, чтобы порядок не имел значения).
DROP TRIGGER IF EXISTS osp_signal_enqueue_ins ON public.contracts;
DROP TRIGGER IF EXISTS osp_signal_enqueue_upd ON public.contracts;
DROP TRIGGER IF EXISTS osp_signal_enqueue_del ON public.contracts;
DROP TRIGGER IF EXISTS osp_signal_enqueue_ins ON public.contract_counterparties;
DROP TRIGGER IF EXISTS osp_signal_enqueue_upd ON public.contract_counterparties;
DROP TRIGGER IF EXISTS osp_signal_enqueue_del ON public.contract_counterparties;
DROP TRIGGER IF EXISTS osp_signal_enqueue_upd ON public.objects;

DO $rollback$
DECLARE
  t text;
  f regprocedure;
BEGIN
  FOREACH t IN ARRAY ARRAY['signal_sources', 'signal_bindings', 'signal_aliases'] LOOP
    IF to_regclass('osp_private.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS osp_data_audit ON osp_private.%I', t);
    END IF;
  END LOOP;
  -- 2. Все функции signal_* закрытой схемы (по каталогу: список не отстанет от миграции). Сначала функции — signal_run_json
  -- зависит от типа таблицы signal_runs.
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'osp_private' AND p.proname LIKE 'signal\_%' LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', f);
  END LOOP;
END
$rollback$;

-- 3. Таблицы: сначала зависимые.
DROP TABLE IF EXISTS osp_private.signal_stage_nodes;
DROP TABLE IF EXISTS osp_private.signal_candidates;
DROP TABLE IF EXISTS osp_private.signal_contracts;
DROP TABLE IF EXISTS osp_private.signal_queue;
DROP TABLE IF EXISTS osp_private.signal_bindings;
DROP TABLE IF EXISTS osp_private.signal_nodes;
DROP TABLE IF EXISTS osp_private.signal_aliases;
DROP TABLE IF EXISTS osp_private.signal_runs;
DROP TABLE IF EXISTS osp_private.signal_sources;
DROP TABLE IF EXISTS osp_private.signal_meta;
DROP SEQUENCE IF EXISTS osp_private.signal_revision_seq;

COMMIT;
