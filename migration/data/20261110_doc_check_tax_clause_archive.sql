-- Разовая правка данных базы tender.su10.ru (Яндекс), «Заявки на проверку ДП/ДС». Решение пользователя 10.11.2026: колонки
-- «Сводка по ДП» и «Проверка документов (исключение налоговой оговорки)» удалить с доски вообще.
--
-- «Сводка» — выборка на странице, в базе её нет. «Проверка документов» — статус tax_clause: страница его больше не предлагает,
-- но заявки, что в нём стоят, показывает отдельной колонкой (без «+», бросить туда нельзя), пока они там есть. Этот скрипт
-- отправляет их в архив — колонка пропадает. Замер чтением 10.11: 106 заявок (32 ДП, 74 ДС), все не в архиве и не удалены.
--
-- Что меняется: только archived_at этих заявок (= время запуска) и запись в историю каждой («Заявка отправлена в архив»,
-- автор — «Исправление данных 10.11.2026 (скрипт)»). Статус tax_clause остаётся: в архиве у заявки видна прежняя колонка, а
-- «Вернуть» на странице ставит её обратно на доску в ту же отдельную колонку — откуда её можно перенести в любую другую.
-- Удалённые и уже архивные заявки не трогаются. Ограничение статусов базы (20261113) не меняется. Триггер обновит updated_at.
--
-- Обратно: -v undo=1 — вернуть из архива заявки, которые отправил этот скрипт (по записи в истории) и которые с тех пор
-- никто не трогал (всё ещё в архиве, статус прежний); в историю — запись о возврате.
--
-- По умолчанию — ПРОБНЫЙ прогон: всё считается, правится и проверяется, затем ROLLBACK. Применить — с -v apply=1.
-- Любое расхождение в проверке «после» — ошибка, транзакция откатывается. В выводе только числа. Повтор безопасен.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261110_doc_check_tax_clause_archive.sql )                    # пробный
--   … && psql -X -v apply=1 -f migration/data/20261110_doc_check_tax_clause_archive.sql )          # применить
--   … && psql -X -v apply=1 -v undo=1 -f migration/data/20261110_doc_check_tax_clause_archive.sql ) # вернуть
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?undo}
\else
  \set undo 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Правила по строкам действуют и на владельца (FORCE RLS): служебная отметка — только на эту транзакцию.
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_
SELECT pg_catalog.set_config('osp.undo', :'undo', true) \gset ignored_

DO $$
DECLARE
  c_who constant text := 'Исправление данных 10.11.2026 (скрипт)';
  c_undo_who constant text := 'Откат исправления данных 10.11.2026 (скрипт)';
  c_status constant text := 'tax_clause';
  v_undo boolean := current_setting('osp.undo') = '1';
  v_at timestamptz := now();
  b_total int; b_target int; b_archived int; b_active_other int;
  n_total int; n_target int; n_archived int; n_active_other int;
  v_fixed int; v_logged int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE status = c_status AND deleted_at IS NULL AND archived_at IS NULL),
         count(*) FILTER (WHERE archived_at IS NOT NULL),
         count(*) FILTER (WHERE status <> c_status AND deleted_at IS NULL AND archived_at IS NULL)
    INTO b_total, b_target, b_archived, b_active_other
    FROM public.doc_check_requests;
  RAISE NOTICE 'до: заявок %, на доске в «Проверке документов» %, в архиве %, на доске в других колонках %',
    b_total, b_target, b_archived, b_active_other;

  IF NOT v_undo THEN
    CREATE TEMP TABLE dc_tax_targets ON COMMIT DROP AS
      SELECT id FROM public.doc_check_requests
       WHERE status = c_status AND deleted_at IS NULL AND archived_at IS NULL;

    UPDATE public.doc_check_requests r SET archived_at = v_at
      FROM dc_tax_targets t WHERE r.id = t.id;
    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    INSERT INTO public.doc_check_request_audit_log (request_id, event_type, description, changed_by_name)
      SELECT id, 'archived', 'Заявка отправлена в архив: колонка «Проверка документов (исключение налоговой оговорки)» убрана с доски', c_who
      FROM dc_tax_targets;
    GET DIAGNOSTICS v_logged = ROW_COUNT;
    RAISE NOTICE 'правка: в архив — % заявок, записей в историю — %', v_fixed, v_logged;

    SELECT count(*),
           count(*) FILTER (WHERE status = c_status AND deleted_at IS NULL AND archived_at IS NULL),
           count(*) FILTER (WHERE archived_at IS NOT NULL),
           count(*) FILTER (WHERE status <> c_status AND deleted_at IS NULL AND archived_at IS NULL)
      INTO n_total, n_target, n_archived, n_active_other
      FROM public.doc_check_requests;
    RAISE NOTICE 'после: заявок %, на доске в «Проверке документов» %, в архиве %, на доске в других колонках %',
      n_total, n_target, n_archived, n_active_other;

    IF v_fixed <> b_target OR v_logged <> b_target THEN
      RAISE EXCEPTION 'FAIL в архив % и записей %, а заявок было %', v_fixed, v_logged, b_target;
    END IF;
    IF n_total <> b_total THEN RAISE EXCEPTION 'FAIL заявок стало %, было %', n_total, b_total; END IF;
    IF n_target <> 0 THEN RAISE EXCEPTION 'FAIL в «Проверке документов» на доске осталось %', n_target; END IF;
    IF n_archived <> b_archived + b_target THEN RAISE EXCEPTION 'FAIL в архиве %, ждали %', n_archived, b_archived + b_target; END IF;
    IF n_active_other <> b_active_other THEN
      RAISE EXCEPTION 'FAIL в других колонках стало %, было %: их трогать нельзя', n_active_other, b_active_other;
    END IF;
  ELSE
    -- Только то, что отправил этот скрипт, и только если с тех пор заявку не трогали.
    CREATE TEMP TABLE dc_tax_back ON COMMIT DROP AS
      SELECT DISTINCT r.id
        FROM public.doc_check_request_audit_log l
        JOIN public.doc_check_requests r ON r.id = l.request_id
       WHERE l.changed_by_name = c_who AND l.event_type = 'archived'
         AND r.archived_at IS NOT NULL AND r.status = c_status AND r.deleted_at IS NULL;

    UPDATE public.doc_check_requests r SET archived_at = NULL
      FROM dc_tax_back t WHERE r.id = t.id;
    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    INSERT INTO public.doc_check_request_audit_log (request_id, event_type, description, changed_by_name)
      SELECT id, 'unarchived', 'Заявка возвращена из архива (откат разовой правки 10.11.2026)', c_undo_who
      FROM dc_tax_back;
    GET DIAGNOSTICS v_logged = ROW_COUNT;
    RAISE NOTICE 'откат: из архива — % заявок, записей в историю — %', v_fixed, v_logged;

    SELECT count(*), count(*) FILTER (WHERE status = c_status AND deleted_at IS NULL AND archived_at IS NULL),
           count(*) FILTER (WHERE archived_at IS NOT NULL)
      INTO n_total, n_target, n_archived
      FROM public.doc_check_requests;
    RAISE NOTICE 'после: заявок %, на доске в «Проверке документов» %, в архиве %', n_total, n_target, n_archived;
    IF v_logged <> v_fixed THEN RAISE EXCEPTION 'FAIL возвращено %, записей %', v_fixed, v_logged; END IF;
    IF n_total <> b_total THEN RAISE EXCEPTION 'FAIL заявок стало %, было %', n_total, b_total; END IF;
    IF n_target <> b_target + v_fixed THEN RAISE EXCEPTION 'FAIL на доске %, ждали %', n_target, b_target + v_fixed; END IF;
    IF n_archived <> b_archived - v_fixed THEN RAISE EXCEPTION 'FAIL в архиве %, ждали %', n_archived, b_archived - v_fixed; END IF;
  END IF;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
