-- Разовая правка данных базы tender.su10.ru (Яндекс): сумма ДС 760 «1.1» на доп. работы к договору ID 133.
-- Выделено 30.10.2026 из общего скрипта «очевидных исправлений» (решение пользователя: дубли — сразу,
-- 20261030_contracts_duplicates_333_358.sql; эта сумма — только после сверки).
--
-- Сейчас у ДС 760 сумма 12 200 000 000,00 ₽ из импорта 27.10 — ошибка (договор 133 — 19 164 000,00 ₽, ДС 749
-- «1» — 1 440 000,00 ₽). Верная сумма в этот файл НЕ зашита: её передают при запуске (-v amount=…) — та, что
-- в подписанной ДС № 1.1 (или в Larix). Для справки скрипт выводит итог ПСДЦ «id_133 b.xlsx» (загружена 27.10 на
-- договор 133, проверена, не применена: 3 544 727 147,17 ₽) и совпадает ли с ним переданная сумма; ПСДЦ не
-- трогаются. Завершённый документ база править не даёт (триггер иерархии) — как на сайте: «вернуть на
-- доработку», поправить сумму, снова «Завершено»; всё внутри одной транзакции, триггеры не выключаются.
--
-- Проверка «до»: ДС 760 в том состоянии, что при проверке 29–30.10 (иначе ошибка — правка уже применена или
-- данные изменились); переданная сумма — число рублей с точкой и не более чем двумя знаками после неё, больше
-- нуля и не 12 200 000 000. Проверка «после» (любое расхождение — ошибка, транзакция откатывается): сумма и
-- статус ДС 760; актуальная сумма договора 133 = прежняя − 12 200 000 000,00 + переданная. В журнал «История» ДС —
-- что было и что стало (по нему работает откат).
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1.
-- В выводе только ID и числа. Откат — migration/data/20261030_ds_760_amount_rollback.sql.
--
-- Запуск из корня репозитория, в нерабочее время (сумма — пример, подставить из подписанной ДС):
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -v amount=3544727147.17 -f migration/data/20261030_ds_760_amount.sql )            # пробный
--   … && psql -X -v amount=3544727147.17 -v apply=1 -f migration/data/20261030_ds_760_amount.sql ) # применить
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?amount}
\else
  \set amount ''
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Правила по строкам действуют и на владельца (FORCE RLS): служебная отметка — только на эту транзакцию.
SELECT pg_catalog.set_config('application_name', 'osp:internal', true),
       pg_catalog.set_config('osp_fix.amount', :'amount', true) \gset ignored_

DO $$
DECLARE
  c_fix     constant text := '20261030_ds_760_amount';
  c_who     constant text := 'Исправление данных 30.10.2026 (скрипт)';
  c_bad     constant numeric := 12200000000.00;
  c_psdc    constant text := 'id_133 b.xlsx';
  v_input   text := btrim(current_setting('osp_fix.amount'));
  v_good    numeric;
  v_ds jsonb; v_root jsonb; v_after jsonb;
  n int; m int; v_psdc numeric; v_before numeric; v_actual numeric; v_applied numeric;
BEGIN
  -- ── Сумма из сверки ────────────────────────────────────────────────────────────────────────────────────────
  IF v_input !~ '^[0-9]{1,13}([.][0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'Укажите сумму ДС 760 из подписанной ДС № 1.1: -v amount=1234567.89 (рубли, без пробелов, копейки через точку)';
  END IF;
  v_good := v_input::numeric;
  IF v_good <= 0 OR v_good = c_bad THEN
    RAISE EXCEPTION 'Сумма % — не исправление (ноль или прежние 12 200 000 000)', v_good;
  END IF;

  -- ── Проверка «до» ──────────────────────────────────────────────────────────────────────────────────────────
  SELECT to_jsonb(c) INTO v_ds FROM public.contracts c WHERE c.display_id = 760;
  SELECT to_jsonb(c) INTO v_root FROM public.contracts c WHERE c.display_id = 133;
  IF v_ds IS NULL OR v_root IS NULL THEN RAISE EXCEPTION 'Не найдены ID 760 или 133'; END IF;
  IF v_ds ->> 'record_type' <> 'ds_extra' OR v_ds ->> 'deleted_at' IS NOT NULL OR v_ds ->> 'status' <> 'completed'
     OR v_ds ->> 'parent_contract_id' IS DISTINCT FROM v_root ->> 'id' OR (v_ds ->> 'psdc_total') IS NOT NULL THEN
    RAISE EXCEPTION 'ID 760: запись не та, что при проверке 29.10 (тип, статус, договор или ПСДЦ)';
  END IF;
  -- Правка действует: последняя её запись в журнале не откачена и сумма та, что она поставила.
  SELECT (l.new_value ->> 'contract_amount')::numeric INTO v_applied FROM public.contract_audit_log l
   WHERE l.contract_id = (v_ds ->> 'id')::uuid AND l.new_value ->> 'fix' = c_fix
     AND NOT EXISTS (SELECT 1 FROM public.contract_audit_log b WHERE b.contract_id = l.contract_id
                       AND b.new_value ->> 'fix_rollback' = c_fix AND b.changed_at > l.changed_at)
   ORDER BY l.changed_at DESC LIMIT 1;
  IF v_applied IS NOT NULL AND (v_ds ->> 'contract_amount')::numeric = v_applied THEN
    RAISE EXCEPTION 'ID 760: сумма уже исправлена этой правкой (%), правка уже применена?', v_applied;
  END IF;
  IF (v_ds ->> 'contract_amount')::numeric IS DISTINCT FROM c_bad THEN
    RAISE EXCEPTION 'ID 760: сумма % — не та, что при проверке 29.10 (%), кто-то уже поправил', v_ds ->> 'contract_amount', c_bad;
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

  SELECT coalesce(r.psdc_total, r.contract_amount, 0)
         + coalesce((SELECT sum(coalesce(k.psdc_total, k.contract_amount, 0)) FROM public.contracts k
                      WHERE k.parent_contract_id = r.id AND k.record_type = 'ds_extra' AND k.status = 'completed'
                        AND k.deleted_at IS NULL), 0)
    INTO v_before FROM public.contracts r WHERE r.display_id = 133;
  SELECT p.total INTO v_psdc FROM public.psdc p
   WHERE p.document_id = (v_root ->> 'id')::uuid AND p.source_filename = c_psdc AND p.deleted_at IS NULL
   ORDER BY p.uploaded_at DESC LIMIT 1;
  RAISE NOTICE 'до:    ДС 760 — сумма %, актуальная сумма договора 133 — %', v_ds ->> 'contract_amount', v_before;
  RAISE NOTICE 'справка: переданная сумма %, итог ПСДЦ «%» — % (%)', v_good, c_psdc, coalesce(v_psdc::text, 'не найдена'),
    CASE WHEN v_psdc = v_good THEN 'совпадает' ELSE 'НЕ совпадает' END;

  -- ── Правка: на доработку → сумма → снова «Завершено» (триггер иерархии проверяет каждый шаг) ──────────────
  UPDATE public.contracts SET status = 'in_work' WHERE id = (v_ds ->> 'id')::uuid AND status = 'completed';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ID 760: не вернулась на доработку'; END IF;
  UPDATE public.contracts SET contract_amount = v_good WHERE id = (v_ds ->> 'id')::uuid;
  UPDATE public.contracts SET status = 'completed' WHERE id = (v_ds ->> 'id')::uuid;
  SELECT to_jsonb(c) INTO v_after FROM public.contracts c WHERE c.id = (v_ds ->> 'id')::uuid;
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
  VALUES ((v_ds ->> 'id')::uuid, 'field_updated', 'contract_amount',
          jsonb_build_object('contract_amount', (v_ds ->> 'contract_amount')::numeric, 'status', v_ds ->> 'status',
                             'updated_at', v_ds ->> 'updated_at'),
          jsonb_build_object('contract_amount', (v_after ->> 'contract_amount')::numeric, 'status', v_after ->> 'status',
                             'fix', c_fix),
          format('Сумма ДС исправлена: 12 200 000 000,00 → %s ₽ — по сверке с подписанной ДС '
                 '(в импорте 27.10 сумма была с ошибкой).',
                 translate(to_char(v_good, 'FM9,999,999,999,990.00'), ',.', ' ,')),
          c_who);
  RAISE NOTICE 'правка: ДС 760 — сумма %', v_after ->> 'contract_amount';

  -- ── Проверка «после» ───────────────────────────────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.contracts WHERE display_id = 760 AND contract_amount = v_good AND status = 'completed'
                   AND deleted_at IS NULL AND record_type = 'ds_extra' AND parent_contract_id = (v_root ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'FAIL ID 760: сумма, статус или договор не те';
  END IF;
  SELECT coalesce(r.psdc_total, r.contract_amount, 0)
         + coalesce((SELECT sum(coalesce(k.psdc_total, k.contract_amount, 0)) FROM public.contracts k
                      WHERE k.parent_contract_id = r.id AND k.record_type = 'ds_extra' AND k.status = 'completed'
                        AND k.deleted_at IS NULL), 0)
    INTO v_actual FROM public.contracts r WHERE r.display_id = 133;
  RAISE NOTICE 'после: актуальная сумма договора 133 — %', v_actual;
  IF v_actual IS DISTINCT FROM v_before - c_bad + v_good THEN
    RAISE EXCEPTION 'FAIL: актуальная сумма договора 133 % (ждали %)', v_actual, v_before - c_bad + v_good;
  END IF;
  SELECT count(*) INTO m FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix AND changed_at = now();
  IF m <> 1 THEN RAISE EXCEPTION 'FAIL: записей в журнале % (ждали 1)', m; END IF;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
