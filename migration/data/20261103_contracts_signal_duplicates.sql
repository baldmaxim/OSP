-- Разовая правка данных базы tender.su10.ru (Яндекс): договоры, заведённые дважды загрузкой 30.10.2026 (решение пользователя
-- 03.11.2026). У старой записи — ПСДЦ, подписание, Larix, сторона, журнал, заявки; у записи от 30.10 — только ссылка Signal и
-- основные поля, ни одной связи, кроме своих пустых ДС. Остаётся старая запись.
--
-- Что делает по каждой паре (ID портала, keep — остаётся, dup — дубль):
--   • ссылка Signal — на старую запись; пустые почта, телефон, директор, комментарий, сумма, НДС, БСМ, сроки работ — из записи от
--     30.10. Заполненное не заменяется: суммы, которые расходятся, остаются как есть;
--   • ДС записи от 30.10: номер уже есть у старого договора — ссылка Signal на этот ДС, пустая запись — в «Удаленные»;
--     номера нет — ДС переходит под старый договор;
--   • запись от 30.10 — в «Удаленные» с пометкой (как кнопка «Удалить» на сайте, восстанавливается).
-- ID 333 (заведён повторно 24.09, не загрузкой) — тоже в «Удаленные», если полностью совпадает с ID 233: прежний скрипт
-- migration/data/20261030_contracts_duplicates_333_358.sql больше не запускается, ID 358 уже удалён на сайте.
-- Не входят: ID 39 и 880 (№ 21/07/26: разные предмет и сумма, похоже, разные договоры). Подстановка суммы поднимает итог договора:
-- он считается как сумма документа плюс завершённые ДС на доп. работы.
--
-- ПОРЯДОК: сначала migration/data/20261103_counterparties_merge.sql — скрипт сверяет, что контрагент в паре один, и иначе
-- останавливается. Исключение — ID 298 и 963: запись от 30.10 висит на другом ООО "Мастер" (другой ИНН).
--
-- Останавливается с ошибкой, ничего не меняя: пара не совпадает (номер, объект, дата, контрагент), на записи от 30.10 появились
-- файлы, ПСДЦ, заявки, стороны или другие ссылки, её ДС не пуст, у старой записи другая ссылка Signal.
-- Проверка «после» (расхождение — ошибка, транзакция откатывается): записи от 30.10 в «Удаленных», ссылок на них нет, ПСДЦ не
-- изменён, число живых документов уменьшилось ровно на убранные. Журнал «История» — у всех затронутых, в записи дубля — всё для отката.
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1. В выводе только ID
-- и числа. Откат — migration/data/20261103_contracts_signal_duplicates_rollback.sql.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261103_contracts_signal_duplicates.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261103_contracts_signal_duplicates.sql ) # применить
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- Правила по строкам действуют и на владельца (FORCE RLS): служебная отметка — только на эту транзакцию.
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_

DO $$
DECLARE
  c_fix constant text := '20261103_contracts_signal_duplicates';
  c_who constant text := 'Исправление данных 03.11.2026 (скрипт)';
  c_pairs constant jsonb := '[
    {"seq":  1, "keep":  226, "dup": 1044},
    {"seq":  2, "keep":  152, "dup":  997},
    {"seq":  3, "keep":  287, "dup": 1007},
    {"seq":  4, "keep":  278, "dup":  962},
    {"seq":  5, "keep":  267, "dup":  994},
    {"seq":  6, "keep":  285, "dup": 1006},
    {"seq":  7, "keep":  227, "dup": 1050},
    {"seq":  8, "keep":   65, "dup":  890},
    {"seq":  9, "keep":  230, "dup":  967},
    {"seq": 10, "keep":  230, "dup": 1059},
    {"seq": 11, "keep":  221, "dup": 1029},
    {"seq": 12, "keep":  236, "dup":  929},
    {"seq": 13, "keep":  261, "dup":  987},
    {"seq": 14, "keep":  168, "dup": 1003},
    {"seq": 15, "keep":  245, "dup":  938},
    {"seq": 16, "keep":  125, "dup":  951},
    {"seq": 17, "keep":  257, "dup":  904},
    {"seq": 18, "keep":  159, "dup": 1001},
    {"seq": 19, "keep":  172, "dup":  871},
    {"seq": 20, "keep":  253, "dup":  960},
    {"seq": 21, "keep":  248, "dup":  946},
    {"seq": 22, "keep":  233, "dup": 1062},
    {"seq": 23, "keep":  228, "dup": 1052},
    {"seq": 24, "keep":  231, "dup": 1060},
    {"seq": 25, "keep":  137, "dup":  923},
    {"seq": 26, "keep":  135, "dup":  893},
    {"seq": 27, "keep":  135, "dup":  959},
    {"seq": 28, "keep":  316, "dup": 1051},
    {"seq": 29, "keep":   55, "dup":  910},
    {"seq": 30, "keep":  143, "dup":  985},
    {"seq": 31, "keep": 1346, "dup": 1344, "number_differs": true},
    {"seq": 32, "keep":  298, "dup":  963, "other_cp": true},
    {"seq": 33, "keep":  233, "dup":  333, "not_import": true}
  ]';
  p record; k public.contracts; d public.contracts; s public.contracts; kk public.contracts; r record;
  v_ids uuid[]; v_kids uuid[]; v_refs text; v_before jsonb; v_after jsonb; v_moved jsonb; v_deleted jsonb;
  v_protected boolean; v_was_completed boolean; v_desc text; n int; v_psdc_b numeric; v_psdc_a numeric;
  b_live int; a_live int; n_shells int := 0; n_moved int := 0; n_filled int := 0;
BEGIN
  SELECT array_agg(c.id) INTO v_ids FROM public.contracts c WHERE c.display_id IN (SELECT (e ->> 'dup')::bigint FROM jsonb_array_elements(c_pairs) e);

  -- ── Проверка «до» ──────────────────────────────────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.contract_audit_log x WHERE x.contract_id = ANY (v_ids) AND x.new_value ->> 'fix' = c_fix
               AND NOT EXISTS (SELECT 1 FROM public.contract_audit_log z WHERE z.contract_id = x.contract_id
                                 AND z.new_value ->> 'fix_rollback' = c_fix AND z.changed_at > x.changed_at)) THEN
    RAISE EXCEPTION 'Правка уже применена: в журнале записей от 30.10 есть её отметки';
  END IF;

  FOR p IN SELECT * FROM jsonb_to_recordset(c_pairs) AS x(seq int, keep bigint, dup bigint, number_differs boolean, other_cp boolean, not_import boolean) ORDER BY seq LOOP
    SELECT * INTO k FROM public.contracts WHERE display_id = p.keep;
    SELECT * INTO d FROM public.contracts WHERE display_id = p.dup;
    IF k.id IS NULL OR d.id IS NULL THEN RAISE EXCEPTION 'ID % / %: не найдены', p.keep, p.dup; END IF;
    IF k.deleted_at IS NOT NULL OR d.deleted_at IS NOT NULL OR k.record_type <> 'dp' OR d.record_type <> 'dp' THEN
      RAISE EXCEPTION 'ID % / %: удалены или не договоры', p.keep, p.dup;
    END IF;
    IF NOT coalesce(p.not_import, false) AND (d.created_at AT TIME ZONE 'UTC')::date <> date '2026-10-30' THEN RAISE EXCEPTION 'ID %: не запись загрузки 30.10', p.dup; END IF;
    -- Дубль не из загрузки: только полное совпадение (сумма, предмет, контрагент, номер, дата, объект).
    IF coalesce(p.not_import, false) AND (k.contract_amount IS DISTINCT FROM d.contract_amount OR btrim(k.work_name) IS DISTINCT FROM btrim(d.work_name)) THEN
      RAISE EXCEPTION 'ID % / %: не полный дубль (сумма или предмет)', p.keep, p.dup;
    END IF;
    IF k.object_id IS DISTINCT FROM d.object_id THEN RAISE EXCEPTION 'ID % / %: разные объекты', p.keep, p.dup; END IF;
    IF btrim(k.contract_number) IS DISTINCT FROM btrim(d.contract_number) AND NOT coalesce(p.number_differs, false) THEN
      RAISE EXCEPTION 'ID % / %: разные номера', p.keep, p.dup;
    END IF;
    IF k.contract_date IS DISTINCT FROM d.contract_date AND k.contract_date IS NOT NULL AND d.contract_date IS NOT NULL THEN
      RAISE EXCEPTION 'ID % / %: разные даты', p.keep, p.dup;
    END IF;
    IF k.counterparty_id IS DISTINCT FROM d.counterparty_id AND NOT coalesce(p.other_cp, false) THEN
      RAISE EXCEPTION 'ID % / %: разные контрагенты — сначала migration/data/20261103_counterparties_merge.sql', p.keep, p.dup;
    END IF;
    IF (d.signal_link IS NULL AND NOT coalesce(p.not_import, false)) OR (k.signal_link IS NOT NULL AND d.signal_link IS NOT NULL AND k.signal_link <> d.signal_link) THEN
      RAISE EXCEPTION 'ID % / %: нет ссылки Signal у записи от 30.10 или у старой другая', p.keep, p.dup;
    END IF;
    IF (d.document_link IS NOT NULL AND NOT (coalesce(p.not_import, false) AND d.document_link = k.document_link)) OR d.psdc_total IS NOT NULL OR d.psdc_applied_id IS NOT NULL THEN
      RAISE EXCEPTION 'ID %: у записи от 30.10 появились Larix или ПСДЦ — объединять вручную', p.dup;
    END IF;
    -- ДС записи от 30.10: только пустые записи на доп. работы, без своих ДС.
    FOR s IN SELECT * FROM public.contracts c WHERE c.parent_contract_id = d.id AND c.deleted_at IS NULL LOOP
      IF s.record_type <> 'ds_extra' OR s.contract_amount IS NOT NULL OR s.contract_date IS NOT NULL OR s.psdc_total IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.contracts c2 WHERE c2.parent_contract_id = s.id AND c2.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'ID %: ДС % не пустое — объединять вручную', p.dup, s.display_id;
      END IF;
      SELECT count(*) INTO n FROM public.contracts c WHERE c.parent_contract_id = k.id AND c.deleted_at IS NULL AND btrim(c.contract_number) = btrim(s.contract_number);
      IF n > 1 THEN RAISE EXCEPTION 'ID %: у договора несколько ДС № %', p.keep, s.contract_number; END IF;
    END LOOP;
    -- Ссылки на запись от 30.10 и её ДС: только дерево договора и журнал.
    SELECT array_agg(c.id) INTO v_kids FROM public.contracts c WHERE c.id = d.id OR (c.parent_contract_id = d.id AND c.deleted_at IS NULL);
    FOR r IN
      SELECT format('%I.%I', ns.nspname, cl.relname) AS tbl, cl.relname AS rel, a.attname AS col
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'public.contracts'::regclass
    LOOP
      CONTINUE WHEN (r.rel = 'contracts' AND r.col IN ('parent_contract_id', 'root_contract_id')) OR r.rel = 'contract_audit_log'
                OR (coalesce(p.not_import, false) AND r.rel = 'contract_counterparties');
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = ANY ($1)', r.tbl, r.col) INTO n USING v_kids;
      IF n > 0 THEN RAISE EXCEPTION 'ID %: на запись от 30.10 ссылается %.% (%) — объединять вручную', p.dup, r.tbl, r.col, n; END IF;
    END LOOP;
    SELECT count(*) INTO n FROM public.s3_documents x WHERE x.owner_type = 'contract' AND x.owner_id = ANY (v_kids);
    IF n > 0 THEN RAISE EXCEPTION 'ID %: к записи от 30.10 прикреплены файлы (%) — объединять вручную', p.dup, n; END IF;
    RAISE NOTICE 'до:    ID % ← ID %: пара совпадает', p.keep, p.dup;
  END LOOP;
  SELECT count(*) INTO b_live FROM public.contracts WHERE deleted_at IS NULL;
  SELECT coalesce(sum(psdc_total), 0) INTO v_psdc_b FROM public.contracts WHERE deleted_at IS NULL;
  RAISE NOTICE 'до:    живых документов %', b_live;

  -- ── Правка ─────────────────────────────────────────────────────────────────────────────────────────────────
  FOR p IN SELECT * FROM jsonb_to_recordset(c_pairs) AS x(seq int, keep bigint, dup bigint, number_differs boolean, other_cp boolean, not_import boolean) ORDER BY seq LOOP
    SELECT * INTO k FROM public.contracts WHERE display_id = p.keep;
    SELECT * INTO d FROM public.contracts WHERE display_id = p.dup;
    v_moved := '[]'; v_deleted := '[]';
    v_before := jsonb_build_object('signal_link', k.signal_link, 'email', k.email, 'phone', k.phone, 'gen_director_name', k.gen_director_name, 'comments', k.comments,
      'contract_amount', k.contract_amount, 'vat_rate', k.vat_rate, 'bsm', k.bsm, 'work_start_date', k.work_start_date, 'work_end_date', k.work_end_date);

    -- Поля, которые завершённому документу можно менять: только пустые.
    UPDATE public.contracts SET
      signal_link = coalesce(signal_link, d.signal_link),
      email = coalesce(nullif(btrim(email), ''), nullif(btrim(d.email), '')),
      phone = coalesce(nullif(btrim(phone), ''), nullif(btrim(d.phone), '')),
      gen_director_name = coalesce(nullif(btrim(gen_director_name), ''), nullif(btrim(d.gen_director_name), '')),
      comments = coalesce(nullif(btrim(comments), ''), nullif(btrim(d.comments), ''))
    WHERE id = k.id;

    -- Сумма, НДС, БСМ, сроки завершённого документа триггер не даёт менять: документ на время транзакции выводится из «Завершено»,
    -- а его живые ДС (мешают этому) на это время скрываются. Снаружи транзакции этого не видно.
    v_protected := (k.contract_amount IS NULL AND d.contract_amount IS NOT NULL) OR (k.vat_rate IS NULL AND d.vat_rate IS NOT NULL)
      OR (nullif(btrim(k.bsm), '') IS NULL AND nullif(btrim(d.bsm), '') IS NOT NULL)
      OR (k.work_start_date IS NULL AND d.work_start_date IS NOT NULL) OR (k.work_end_date IS NULL AND d.work_end_date IS NOT NULL);
    IF v_protected THEN
      v_was_completed := k.status = 'completed';
      IF v_was_completed THEN
        SELECT array_agg(c.id) INTO v_kids FROM public.contracts c WHERE c.parent_contract_id = k.id AND c.deleted_at IS NULL;
        UPDATE public.contracts SET deleted_at = now() WHERE id = ANY (v_kids);
        UPDATE public.contracts SET status = 'in_work' WHERE id = k.id;
      END IF;
      UPDATE public.contracts SET
        contract_amount = coalesce(contract_amount, d.contract_amount),
        vat_rate = coalesce(vat_rate, d.vat_rate),
        bsm = coalesce(nullif(btrim(bsm), ''), nullif(btrim(d.bsm), '')),
        work_start_date = coalesce(work_start_date, d.work_start_date),
        work_end_date = coalesce(work_end_date, d.work_end_date)
      WHERE id = k.id;
      IF v_was_completed THEN
        UPDATE public.contracts SET status = 'completed' WHERE id = k.id;
        UPDATE public.contracts SET deleted_at = NULL WHERE id = ANY (v_kids);
      END IF;
      n_filled := n_filled + 1;
    END IF;

    -- ДС записи от 30.10.
    FOR s IN SELECT * FROM public.contracts c WHERE c.parent_contract_id = d.id AND c.deleted_at IS NULL ORDER BY c.display_id LOOP
      kk := NULL;
      SELECT * INTO kk FROM public.contracts c WHERE c.parent_contract_id = k.id AND c.deleted_at IS NULL AND btrim(c.contract_number) = btrim(s.contract_number);
      IF kk.id IS NOT NULL THEN
        UPDATE public.contracts SET signal_link = coalesce(signal_link, s.signal_link) WHERE id = kk.id;
        UPDATE public.contracts SET deleted_at = now() WHERE id = s.id;
        v_deleted := v_deleted || jsonb_build_object('id', s.id, 'into', kk.id, 'into_signal_before', kk.signal_link, 'into_signal_after', coalesce(kk.signal_link, s.signal_link));
        INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
        VALUES (s.id, 'soft_deleted', 'deleted_at', jsonb_build_object('deleted_at', NULL),
                jsonb_build_object('deleted_at', now(), 'keep', kk.display_id, 'fix', c_fix),
                format('Пустая запись ДС из загрузки 30.10: такое ДС есть у договора ID %s (ID ДС %s), ссылка Signal перенесена на него.', p.keep, kk.display_id), c_who);
        n_shells := n_shells + 1;
      ELSE
        UPDATE public.contracts SET status = 'in_work' WHERE id = s.id;
        UPDATE public.contracts SET parent_contract_id = k.id, status = 'completed' WHERE id = s.id;
        v_moved := v_moved || jsonb_build_object('id', s.id);
        INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
        VALUES (s.id, 'field_updated', 'parent_contract_id', jsonb_build_object('parent_contract_id', d.id),
                jsonb_build_object('parent_contract_id', k.id, 'fix', c_fix),
                format('ДС перенесено к договору ID %s: прежний договор ID %s — дубль из загрузки 30.10.', p.keep, p.dup), c_who);
        n_moved := n_moved + 1;
      END IF;
    END LOOP;

    -- Запись от 30.10 — в «Удаленные».
    UPDATE public.contracts SET deleted_at = now(),
           notes = (CASE WHEN p.not_import THEN format('Дубль договора ID %s: заведён повторно, всё совпадает.', p.keep)
                         ELSE format('Дубль договора ID %s из загрузки 30.10: ссылка Signal и пустые поля перенесены туда.', p.keep) END) || coalesce(E'\n' || nullif(d.notes, ''), '')
     WHERE id = d.id;

    SELECT * INTO kk FROM public.contracts WHERE id = k.id;
    v_after := jsonb_build_object('signal_link', kk.signal_link, 'email', kk.email, 'phone', kk.phone, 'gen_director_name', kk.gen_director_name, 'comments', kk.comments,
      'contract_amount', kk.contract_amount, 'vat_rate', kk.vat_rate, 'bsm', kk.bsm, 'work_start_date', kk.work_start_date, 'work_end_date', kk.work_end_date);
    IF kk.contract_amount IS DISTINCT FROM coalesce(k.contract_amount, d.contract_amount) OR kk.psdc_total IS DISTINCT FROM k.psdc_total THEN
      RAISE EXCEPTION 'FAIL ID %: сумма или ПСДЦ изменились не так', p.keep;
    END IF;
    SELECT string_agg(e.key, ', ' ORDER BY e.key) INTO v_desc FROM jsonb_each(v_after) e WHERE e.value IS DISTINCT FROM v_before -> e.key;

    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES (d.id, 'soft_deleted', 'deleted_at', jsonb_build_object('deleted_at', NULL, 'notes', d.notes),
            jsonb_build_object('deleted_at', now(), 'keep', p.keep, 'seq', p.seq, 'fix', c_fix, 'keep_id', k.id, 'k_before', v_before, 'k_after', v_after, 'kids_moved', v_moved, 'kids_deleted', v_deleted),
            format('Дубль договора ID %s%s перенесён в «Удалённые».', p.keep, CASE WHEN p.not_import THEN '' ELSE ' из загрузки 30.10' END), c_who);
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES (k.id, 'field_updated', NULL, v_before, jsonb_build_object('fix', c_fix, 'seq', p.seq, 'dup', p.dup),
            format('Объединён с дублем ID %s%s. Заполнено: %s. ДС перенесено: %s, пустых записей ДС убрано: %s.', p.dup, CASE WHEN p.not_import THEN '' ELSE ' из загрузки 30.10' END, coalesce(v_desc, 'ничего'), jsonb_array_length(v_moved), jsonb_array_length(v_deleted)), c_who);
    RAISE NOTICE 'правка: ID % ← ID %: заполнено [%], ДС перенесено %, убрано %', p.keep, p.dup, coalesce(v_desc, '—'), jsonb_array_length(v_moved), jsonb_array_length(v_deleted);
  END LOOP;

  -- ── Проверка «после» ───────────────────────────────────────────────────────────────────────────────────────
  SELECT count(*) INTO a_live FROM public.contracts WHERE deleted_at IS NULL;
  IF a_live <> b_live - jsonb_array_length(c_pairs) - n_shells THEN
    RAISE EXCEPTION 'FAIL: живых документов % (было %, записей %, пустых ДС %)', a_live, b_live, jsonb_array_length(c_pairs), n_shells;
  END IF;
  SELECT coalesce(sum(psdc_total), 0) INTO v_psdc_a FROM public.contracts WHERE deleted_at IS NULL;
  IF v_psdc_a <> v_psdc_b THEN RAISE EXCEPTION 'FAIL: сумма ПСДЦ живых документов изменилась (% и %)', v_psdc_b, v_psdc_a; END IF;
  SELECT count(*) INTO n FROM public.contracts c WHERE c.id = ANY (v_ids) AND c.deleted_at IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'FAIL: записей от 30.10 не в «Удаленных»: %', n; END IF;
  SELECT count(*) INTO n FROM public.contracts c WHERE c.parent_contract_id = ANY (v_ids) AND c.deleted_at IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'FAIL: у удалённых записей остались живые ДС: %', n; END IF;
  SELECT count(*) INTO n FROM public.contracts c JOIN public.contracts q ON q.id = c.parent_contract_id
   WHERE c.deleted_at IS NULL AND c.root_contract_id IS DISTINCT FROM coalesce(q.root_contract_id, q.id) AND q.display_id IN (SELECT (e ->> 'keep')::bigint FROM jsonb_array_elements(c_pairs) e);
  IF n > 0 THEN RAISE EXCEPTION 'FAIL: у ДС неверный договор-основа: %', n; END IF;
  RAISE NOTICE 'после: живых документов %; договоров с заполненными суммой, НДС, БСМ или сроками %; ДС перенесено %, пустых записей ДС убрано %', a_live, n_filled, n_moved, n_shells;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
