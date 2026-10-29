-- Разовая правка данных базы tender.su10.ru (Яндекс): очевидные ошибки «Договоров и ДС» по проверке 29.10.2026.
--
-- Что меняется (ID портала):
--   1. ДС 760 «1.1» на доп. работы к договору ID 133: сумма 12 200 000 000,00 ₽ из импорта 27.10 —
--      ошибка (актуальная сумма договора на сайте — 12 220 604 000,00 ₽ при договоре 19 164 000,00 ₽).
--      Верная — по ПСДЦ этой ДС «id_133 b.xlsx» (загружена 27.10 на договор 133, проверена, не применена):
--      3 544 727 147,17 ₽. Вторая такая ПСДЦ «id_133 a.xlsx» = 1 440 000,00 ₽ — ровно ДС 749 «1», сумма
--      которой верная. ПСДЦ не трогаются: правится только сумма ДС. Актуальная сумма договора 133 станет
--      19 164 000,00 + 1 440 000,00 + 3 544 727 147,17 = 3 565 331 147,17 ₽.
--      Завершённый документ база править не даёт (триггер иерархии) — как на сайте: «вернуть на доработку»,
--      поправить сумму, снова «Завершено»; всё внутри одной транзакции, триггеры не выключаются.
--   2. Полные дубли договоров — в «Удаленные» (как кнопка «Удалить» на сайте, восстанавливаются):
--      ID 333 — дубль ID 233 (№ 29-04-МОСФ-2024 «СУ-90»: тот же номер, дата, сторона, объект, сумма; у 233 —
--               ПСДЦ и ДС, у 333 — ничего);
--      ID 358 — дубль ID 359 (№ СУ2-СОБ6.2-И-Э014-26 «Асгард»: заведён дважды 19.10; ПСДЦ нет у обоих, 359
--               доведён до «Завершено» и отмечен «наш», у 358 — «Новая заявка», его приложения не заполнялись и
--               совпадают с приложениями 359).
--      В «Удаленные» уходит запись, к которой ничего не привязано (ДС, ПСДЦ, заявки на ДС, задачи, файлы,
--      пункты согласования, график авансов, прикрепление к контрагенту, история кроме «Создан»), иначе — ошибка.
-- Не трогаются (решение пользователя 29.10): ID 88 «Гарант-М» и ID 366 «ТАДЖИНЖСТРОЙ» с одним номером.
-- ДС, заведённые договорами (94, 96, 401, 338, 20, 345, 45), — отдельный скрипт
-- migration/data/20261029_ds_entered_as_contracts.sql; с этим не пересекается.
--
-- Проверка «до»: каждая запись в том состоянии, что при проверке 29.10 (иначе ошибка — правка уже применена или
-- данные изменились). Проверка «после» (любое расхождение — ошибка, транзакция откатывается): сумма и статус ДС 760,
-- актуальная сумма договора 133, дубли в «Удаленных», оставленные записи живые, живых договоров −2.
-- В журнал «История» каждой записи — что было и что стало (по нему работает откат).
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1.
-- В выводе только ID и числа. Откат — migration/data/20261029_contracts_obvious_fixes_rollback.sql.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261029_contracts_obvious_fixes.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261029_contracts_obvious_fixes.sql ) # применить
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
  c_fix     constant text := '20261029_contracts_obvious_fixes';
  c_who     constant text := 'Исправление данных 29.10.2026 (скрипт)';
  c_bad     constant numeric := 12200000000.00;
  c_good    constant numeric := 3544727147.17;
  c_psdc    constant uuid := '7fbd7208-746e-42c1-b5a1-d8caf28bf1e5';   -- ПСДЦ «id_133 b.xlsx»
  c_actual  constant numeric := 3565331147.17;                          -- договор 133 после правки
  -- dup — дубль (в «Удаленные»), keep — оставляемая запись.
  c_dups    constant jsonb := '[{"dup": 333, "keep": 233}, {"dup": 358, "keep": 359}]';
  v_ds jsonb; v_root jsonb; v_after jsonb; v_dup jsonb; v_keep jsonb;
  p record; n int; m int; b_dp int; a_dp int; v_actual numeric;
BEGIN
  -- ── Проверка «до» ──────────────────────────────────────────────────────────────────────────────────────────
  SELECT to_jsonb(c) INTO v_ds FROM public.contracts c WHERE c.display_id = 760;
  SELECT to_jsonb(c) INTO v_root FROM public.contracts c WHERE c.display_id = 133;
  IF v_ds IS NULL OR v_root IS NULL THEN RAISE EXCEPTION 'Не найдены ID 760 или 133'; END IF;
  IF v_ds ->> 'record_type' <> 'ds_extra' OR v_ds ->> 'deleted_at' IS NOT NULL OR v_ds ->> 'status' <> 'completed'
     OR v_ds ->> 'parent_contract_id' IS DISTINCT FROM v_root ->> 'id' OR (v_ds ->> 'psdc_total') IS NOT NULL THEN
    RAISE EXCEPTION 'ID 760: запись не та, что при проверке 29.10 (тип, статус, договор или ПСДЦ)';
  END IF;
  IF (v_ds ->> 'contract_amount')::numeric = c_good THEN
    RAISE EXCEPTION 'ID 760: сумма уже %, правка уже применена?', c_good;
  END IF;
  IF (v_ds ->> 'contract_amount')::numeric IS DISTINCT FROM c_bad THEN
    RAISE EXCEPTION 'ID 760: сумма % — не та, что при проверке 29.10 (%), кто-то уже поправил', v_ds ->> 'contract_amount', c_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psdc WHERE id = c_psdc AND total = c_good AND document_id = (v_root ->> 'id')::uuid
                   AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ПСДЦ «id_133 b.xlsx» с итогом % у договора 133 не найдена', c_good;
  END IF;
  -- Актуальная сумма договора 133 считается ниже просто (договор + завершённые ДС на доп. работы), поэтому в его
  -- дереве не должно быть ДС на изменение ВОР и ДС второго уровня.
  IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.root_contract_id = (v_root ->> 'id')::uuid AND k.deleted_at IS NULL
               AND k.id <> (v_root ->> 'id')::uuid
               AND (k.record_type <> 'ds_extra' OR k.parent_contract_id <> (v_root ->> 'id')::uuid)) THEN
    RAISE EXCEPTION 'У договора 133 есть ДС на изменение ВОР или ДС к ДС — дерево не то, что при проверке 29.10';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = (v_ds ->> 'id')::uuid AND k.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ID 760: к ней прикреплены ДС';
  END IF;

  FOR p IN SELECT * FROM jsonb_to_recordset(c_dups) AS x(dup bigint, keep bigint) LOOP
    SELECT to_jsonb(c) INTO v_dup FROM public.contracts c WHERE c.display_id = p.dup;
    SELECT to_jsonb(c) INTO v_keep FROM public.contracts c WHERE c.display_id = p.keep;
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
  RAISE NOTICE 'до:    ДС 760 — %, живых договоров %', v_ds ->> 'contract_amount', b_dp;

  -- ── Правка ─────────────────────────────────────────────────────────────────────────────────────────────────
  -- 1) ДС 760: на доработку → сумма → снова «Завершено» (триггер иерархии проверяет каждый шаг).
  UPDATE public.contracts SET status = 'in_work' WHERE id = (v_ds ->> 'id')::uuid AND status = 'completed';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ID 760: не вернулась на доработку'; END IF;
  UPDATE public.contracts SET contract_amount = c_good WHERE id = (v_ds ->> 'id')::uuid;
  UPDATE public.contracts SET status = 'completed' WHERE id = (v_ds ->> 'id')::uuid;
  SELECT to_jsonb(c) INTO v_after FROM public.contracts c WHERE c.id = (v_ds ->> 'id')::uuid;
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
  VALUES ((v_ds ->> 'id')::uuid, 'field_updated', 'contract_amount',
          jsonb_build_object('contract_amount', (v_ds ->> 'contract_amount')::numeric, 'status', v_ds ->> 'status',
                             'updated_at', v_ds ->> 'updated_at'),
          jsonb_build_object('contract_amount', (v_after ->> 'contract_amount')::numeric, 'status', v_after ->> 'status',
                             'fix', c_fix),
          'Сумма ДС исправлена: 12 200 000 000,00 → 3 544 727 147,17 ₽ — по ПСДЦ этой ДС «id_133 b.xlsx» '
            || '(в импорте 27.10 сумма была с ошибкой).',
          c_who);
  RAISE NOTICE 'правка: ДС 760 — сумма %', v_after ->> 'contract_amount';

  -- 2) Дубли — в «Удаленные».
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
  IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE display_id = 760 AND contract_amount = c_good AND status = 'completed'
                   AND deleted_at IS NULL AND record_type = 'ds_extra' AND parent_contract_id = (v_root ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'FAIL ID 760: сумма, статус или договор не те';
  END IF;
  SELECT coalesce(r.psdc_total, r.contract_amount, 0)
         + coalesce((SELECT sum(coalesce(k.psdc_total, k.contract_amount, 0)) FROM public.contracts k
                      WHERE k.parent_contract_id = r.id AND k.record_type = 'ds_extra' AND k.status = 'completed'
                        AND k.deleted_at IS NULL), 0)
    INTO v_actual FROM public.contracts r WHERE r.display_id = 133;
  RAISE NOTICE 'после: актуальная сумма договора 133 — %', v_actual;
  IF v_actual IS DISTINCT FROM c_actual THEN
    RAISE EXCEPTION 'FAIL: актуальная сумма договора 133 % (ждали %)', v_actual, c_actual;
  END IF;
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
  IF m <> 3 THEN RAISE EXCEPTION 'FAIL: записей в журнале % (ждали 3)', m; END IF;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
