-- Разовая правка данных базы tender.su10.ru (Яндекс): общая папка \\192.168.2.55\SharA_Tender переехала
-- на \\192.168.5.55\SharA_Tender (29.10.2026). Меняется только адрес сервера перед «\SharA_Tender»
-- (и «/SharA_Tender»), остальная часть пути и текст вокруг не трогаются.
--
-- Где меняется (замер чтением 29.10, строк со старым адресом):
--   tenders.folder_path                       — 12   путь к папке тендера
--   contracts.folder_path / document_link / notes — 21 / 3 / 23 (всего 35 договоров, все ДП)
--   tender_counterparties.notes               — 1    примечание участника
--   app_settings.value                        — 3    общие папки разделов: *_root_folder_path
--                                                    (тендеры, договоры, планы затрат)
-- Не меняется: журналы изменений (*_audit_log) — это история, в ней остаётся, что было тогда;
-- dc_requests.folder_path — там другой сервер (10.20.7.35).
-- У договоров и тендеров триггер обновит updated_at (время правки станет временем запуска).
--
-- По умолчанию — ПРОБНЫЙ прогон: всё считается, правится и проверяется, затем ROLLBACK.
-- Применить — с -v apply=1. Любое расхождение в проверке «после» — ошибка, транзакция откатывается.
-- В выводе только числа. Обратная замена — тот же файл с -v from=192.168.5.55 -v to=192.168.2.55
-- (она вернёт и пути, которые уже были на 192.168.5.55 до запуска).
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261029_share_192_168_5_55.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261029_share_192_168_5_55.sql ) # применить
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?from}
\else
  \set from 192.168.2.55
\endif
\if :{?to}
\else
  \set to 192.168.5.55
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Правила по строкам действуют и на владельца (FORCE RLS): служебная отметка — только на эту транзакцию.
SELECT pg_catalog.set_config('application_name', 'osp:internal', true),
       pg_catalog.set_config('osp_fix.from', :'from', true),
       pg_catalog.set_config('osp_fix.to', :'to', true) \gset ignored_

DO $$
DECLARE
  v_from text := current_setting('osp_fix.from');
  v_to   text := current_setting('osp_fix.to');
  v_old  text;
  v_new  text;
  v_cols constant text[][] := ARRAY[
    ['tenders', 'folder_path'],
    ['contracts', 'folder_path'], ['contracts', 'document_link'], ['contracts', 'notes'],
    ['tender_counterparties', 'notes'],
    ['app_settings', 'value']];
  v_tables constant text[] := ARRAY['tenders', 'contracts', 'tender_counterparties', 'app_settings'];
  b_old  int[] := '{}';  -- вхождений старого адреса до правки, по колонкам
  b_new  int[] := '{}';  -- вхождений нового адреса до правки
  b_rows int[] := '{}';  -- строк со старым адресом, по таблицам
  n_old int; n_new int; n_rows int; v_where text; v_set text; t text; i int;
BEGIN
  IF v_from !~ '^\d{1,3}(\.\d{1,3}){3}$' OR v_to !~ '^\d{1,3}(\.\d{1,3}){3}$' OR v_from = v_to THEN
    RAISE EXCEPTION 'from / to — два разных IP-адреса';
  END IF;
  v_old := replace(v_from, '.', '\.') || '(?=[\\/]+SharA_Tender)';
  v_new := replace(v_to, '.', '\.') || '(?=[\\/]+SharA_Tender)';

  -- До правки.
  FOR i IN 1 .. array_length(v_cols, 1) LOOP
    EXECUTE format('SELECT coalesce(sum((SELECT count(*) FROM regexp_matches(%1$I, %2$L, %4$L))), 0),
                           coalesce(sum((SELECT count(*) FROM regexp_matches(%1$I, %3$L, %4$L))), 0)
                    FROM public.%5$I WHERE %1$I IS NOT NULL', v_cols[i][2], v_old, v_new, 'gi', v_cols[i][1])
      INTO n_old, n_new;
    b_old := b_old || n_old; b_new := b_new || n_new;
    RAISE NOTICE 'до:    %.% — старый адрес %, новый %', v_cols[i][1], v_cols[i][2], n_old, n_new;
  END LOOP;

  -- Правка: одно UPDATE на таблицу, только строки со старым адресом.
  FOREACH t IN ARRAY v_tables LOOP
    SELECT string_agg(format('%I ~* %L', c[2], v_old), ' OR '),
           string_agg(format('%1$I = regexp_replace(%1$I, %2$L, %3$L, %4$L)', c[2], v_old, v_to, 'gi'), ', ')
      INTO v_where, v_set
      FROM (SELECT v_cols[k][1] AS tbl, ARRAY[v_cols[k][1], v_cols[k][2]] AS c
            FROM generate_subscripts(v_cols, 1) k) s
     WHERE s.tbl = t;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', t, v_where) INTO n_rows;
    b_rows := b_rows || n_rows;
    EXECUTE format('UPDATE public.%I SET %s WHERE %s', t, v_set, v_where);
    GET DIAGNOSTICS i = ROW_COUNT;
    IF i <> n_rows THEN
      RAISE EXCEPTION '%: исправлено строк %, а со старым адресом было %', t, i, n_rows;
    END IF;
    RAISE NOTICE 'правка: % — строк %', t, i;
  END LOOP;

  -- После правки: старого адреса не осталось, новых вхождений ровно столько, сколько было старых + новых.
  FOR i IN 1 .. array_length(v_cols, 1) LOOP
    EXECUTE format('SELECT coalesce(sum((SELECT count(*) FROM regexp_matches(%1$I, %2$L, %4$L))), 0),
                           coalesce(sum((SELECT count(*) FROM regexp_matches(%1$I, %3$L, %4$L))), 0)
                    FROM public.%5$I WHERE %1$I IS NOT NULL', v_cols[i][2], v_old, v_new, 'gi', v_cols[i][1])
      INTO n_old, n_new;
    RAISE NOTICE 'после: %.% — старый адрес %, новый %', v_cols[i][1], v_cols[i][2], n_old, n_new;
    IF n_old <> 0 OR n_new <> b_old[i] + b_new[i] THEN
      RAISE EXCEPTION 'FAIL %.%: старый % (ждали 0), новый % (ждали %)',
        v_cols[i][1], v_cols[i][2], n_old, n_new, b_old[i] + b_new[i];
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
