-- Разовая правка данных базы tender.su10.ru (Яндекс): полные дубли договоров — в «Удаленные» (как кнопка
-- «Удалить» на сайте, восстанавливаются). Выделено 30.10.2026 из общего скрипта «очевидных исправлений»
-- (решение пользователя: дубли — сразу, сумма ДС 760 — после сверки, отдельно: 20261030_ds_760_amount.sql).
--
-- Что меняется (ID портала):
--   ID 333 — дубль ID 233 (№ 29-04-МОСФ-2024 «СУ-90»: тот же номер, дата, сторона, объект, сумма; у 233 —
--            ПСДЦ и ДС, у 333 — ничего);
--   ID 358 — дубль ID 359 (№ СУ2-СОБ6.2-И-Э014-26 «Асгард»: заведён дважды 19.10; ПСДЦ нет у обоих, 359
--            доведён до «Завершено» и отмечен «наш», у 358 — «Новая заявка», его приложения не заполнялись и
--            совпадают с приложениями 359).
-- В «Удаленные» уходит запись, к которой ничего не привязано (ДС, ПСДЦ, заявки на ДС, задачи, файлы,
-- пункты согласования, график авансов, прикрепление к контрагенту, история кроме «Создан»), иначе — ошибка.
-- Не трогаются (решение пользователя 29.10): ID 88 «Гарант-М» и ID 366 «ТАДЖИНЖСТРОЙ» с одним номером.
-- Записи не пересекаются с 20261029_ds_entered_as_contracts.sql и 20261030_ds_760_amount.sql.
--
-- Проверка «до»: обе пары в том состоянии, что при проверке 29.10 (иначе ошибка — правка уже применена или
-- данные изменились). Проверка «после» (любое расхождение — ошибка, транзакция откатывается): дубли в
-- «Удаленных», оставляемые записи живые, живых договоров −2. В журнал «История» каждого дубля — что было и что
-- стало (по нему работает откат).
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1.
-- В выводе только ID и числа. Откат — migration/data/20261030_contracts_duplicates_333_358_rollback.sql.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261030_contracts_duplicates_333_358.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261030_contracts_duplicates_333_358.sql ) # применить
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Правила по строкам действуют и на владельца (FORCE RLS): служебная отметка — только на эту транзакцию.
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_

DO $$
DECLARE
  c_fix     constant text := '20261030_contracts_duplicates_333_358';
  c_who     constant text := 'Исправление данных 30.10.2026 (скрипт)';
  -- dup — дубль (в «Удаленные»), keep — оставляемая запись.
  c_dups    constant jsonb := '[{"dup": 333, "keep": 233}, {"dup": 358, "keep": 359}]';
  v_dup jsonb; v_keep jsonb;
  p record; n int; m int; b_dp int; a_dp int;
BEGIN
  -- ── Проверка «до» ──────────────────────────────────────────────────────────────────────────────────────────
  FOR p IN SELECT * FROM jsonb_to_recordset(c_dups) AS x(dup bigint, keep bigint) LOOP
    SELECT to_jsonb(c) INTO v_dup FROM public.contracts c WHERE c.display_id = p.dup;
    SELECT to_jsonb(c) INTO v_keep FROM public.contracts c WHERE c.display_id = p.keep;
    -- Правка действует: последняя её запись не откачена и запись в «Удаленных» с тем же временем.
    IF v_dup IS NOT NULL AND v_dup ->> 'deleted_at' IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.contract_audit_log x WHERE x.contract_id = (v_dup ->> 'id')::uuid
                     AND x.new_value ->> 'fix' = c_fix
                     AND (x.new_value ->> 'deleted_at')::timestamptz = (v_dup ->> 'deleted_at')::timestamptz
                     AND NOT EXISTS (SELECT 1 FROM public.contract_audit_log b WHERE b.contract_id = x.contract_id
                                       AND b.new_value ->> 'fix_rollback' = c_fix AND b.changed_at > x.changed_at)) THEN
      RAISE EXCEPTION 'ID %: уже в «Удаленных» этой правкой — правка уже применена?', p.dup;
    END IF;
    IF v_dup IS NULL OR v_keep IS NULL OR v_dup ->> 'deleted_at' IS NOT NULL OR v_keep ->> 'deleted_at' IS NOT NULL
       OR v_dup ->> 'record_type' <> 'dp' OR v_keep ->> 'record_type' <> 'dp' THEN
      RAISE EXCEPTION 'ID % / %: не найдены, удалены или не договоры', p.dup, p.keep;
    END IF;
    IF btrim(v_dup ->> 'contract_number') IS DISTINCT FROM btrim(v_keep ->> 'contract_number')
       OR v_dup ->> 'contract_date' IS DISTINCT FROM v_keep ->> 'contract_date'
       OR v_dup ->> 'counterparty_id' IS DISTINCT FROM v_keep ->> 'counterparty_id'
       OR v_dup ->> 'object_id' IS DISTINCT FROM v_keep ->> 'object_id'
       OR (v_dup ->> 'contract_amount')::numeric IS DISTINCT FROM (v_keep ->> 'contract_amount')::numeric
       OR btrim(v_dup ->> 'work_name') IS DISTINCT FROM btrim(v_keep ->> 'work_name')
       OR (v_dup ->> 'psdc_total') IS NOT NULL THEN
      RAISE EXCEPTION 'ID %: не полный дубль ID % (номер, дата, сторона, объект, сумма, предмет) или с ПСДЦ', p.dup, p.keep;
    END IF;
    IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.contract_attachments x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.contract_advance_schedule x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.contract_clauses x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.contract_clause_disputes x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.contract_audit_log x WHERE x.contract_id = (v_dup ->> 'id')::uuid
                    AND x.event_type <> 'created'
                    AND c_fix IS DISTINCT FROM coalesce(x.new_value ->> 'fix', x.new_value ->> 'fix_rollback'))
       OR EXISTS (SELECT 1 FROM public.psdc x WHERE x.document_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.dc_requests x WHERE (v_dup ->> 'id')::uuid IN (x.contract_id, x.amendment_id))
       OR EXISTS (SELECT 1 FROM public.tasks x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.counterparty_contract_links x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.s3_documents x WHERE x.owner_type = 'contract' AND x.owner_id = (v_dup ->> 'id')::uuid) THEN
      RAISE EXCEPTION 'ID %: к дублю что-то привязано — объединять вручную', p.dup;
    END IF;
    -- Приложения дубля допустимы, только если такие же (по содержанию) есть у оставляемой записи.
    SELECT count(*) INTO n FROM (
      SELECT to_jsonb(x) - 'id' - 'contract_id' - 'created_at' - 'updated_at' - 'parent_id' AS j
        FROM public.contract_appendices x WHERE x.contract_id = (v_dup ->> 'id')::uuid
      EXCEPT
      SELECT to_jsonb(x) - 'id' - 'contract_id' - 'created_at' - 'updated_at' - 'parent_id'
        FROM public.contract_appendices x WHERE x.contract_id = (v_keep ->> 'id')::uuid
    ) t;
    IF n > 0 THEN RAISE EXCEPTION 'ID %: у дубля % приложений, которых нет у ID % — объединять вручную', p.dup, n, p.keep; END IF;
    RAISE NOTICE 'до:    ID % — полный дубль ID %, привязанного нет', p.dup, p.keep;
  END LOOP;

  SELECT count(*) INTO b_dp FROM public.contracts WHERE deleted_at IS NULL AND record_type = 'dp';
  RAISE NOTICE 'до:    живых договоров %', b_dp;

  -- ── Правка: дубли — в «Удаленные» ──────────────────────────────────────────────────────────────────────────
  FOR p IN SELECT * FROM jsonb_to_recordset(c_dups) AS x(dup bigint, keep bigint) LOOP
    SELECT to_jsonb(c) INTO v_dup FROM public.contracts c WHERE c.display_id = p.dup;
    UPDATE public.contracts SET deleted_at = now() WHERE id = (v_dup ->> 'id')::uuid AND deleted_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'ID %: в «Удаленные» не перенесён', p.dup; END IF;
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES ((v_dup ->> 'id')::uuid, 'soft_deleted', 'deleted_at',
            jsonb_build_object('deleted_at', NULL),
            jsonb_build_object('deleted_at', now(), 'keep', p.keep, 'fix', c_fix),
            format('Дубль договора ID %s (тот же номер, дата, сторона, объект и сумма) перенесён в «Удалённые».', p.keep),
            c_who);
    RAISE NOTICE 'правка: ID % — в «Удаленные»', p.dup;
  END LOOP;

  -- ── Проверка «после» ───────────────────────────────────────────────────────────────────────────────────────
  FOR p IN SELECT * FROM jsonb_to_recordset(c_dups) AS x(dup bigint, keep bigint) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE display_id = p.dup AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FAIL ID %: не в «Удаленных»', p.dup;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE display_id = p.keep AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'FAIL ID %: оставляемая запись не живая', p.keep;
    END IF;
  END LOOP;
  SELECT count(*) INTO a_dp FROM public.contracts WHERE deleted_at IS NULL AND record_type = 'dp';
  RAISE NOTICE 'после: живых договоров %', a_dp;
  IF a_dp <> b_dp - 2 THEN RAISE EXCEPTION 'FAIL: живых договоров % (ждали %)', a_dp, b_dp - 2; END IF;
  SELECT count(*) INTO m FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix AND changed_at = now();
  IF m <> 2 THEN RAISE EXCEPTION 'FAIL: записей в журнале % (ждали 2)', m; END IF;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
