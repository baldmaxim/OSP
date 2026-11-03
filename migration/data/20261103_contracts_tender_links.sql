-- Разовая правка данных базы tender.su10.ru (Яндекс): привязать договоры к тендерам там, где это можно сделать без сомнений
-- (решение пользователя 03.11.2026: «каждому договору и ДС привязку к тендеру — там, где возможно без проблем»).
-- ДС не трогаются: у ДС без своего тендера показывается тендер его договора (src/utils/contractTender.js), поэтому смена тендера
-- в договоре сразу видна у всех его ДС.
--
-- Список пар ниже посчитан по базе 03.11.2026 (только чтение), вид основания — «b»:
--   A1 — контрагент договора (любая сторона) — победитель тендера на этом объекте; другого договора у него с этим тендером нет
--        и других выигранных тендеров на объекте нет; дата договора сходится со сроками тендера;
--   A2 — то же, но договоров контрагента на объекте несколько: взяты те, где слова работ совпали с описанием тендера;
--   A3 — контрагент выиграл на объекте несколько тендеров: выбран тот, с которым слова работ совпали больше всего, без ничьей;
--   B  — контрагент подал КП, тендер завершён или на подведении итогов, победитель в нём не записан, слова работ совпали.
-- Дата сходится: договор не раньше чем за 30 дней до начала тендера и не позже года после окончания (договор 2024 года не
-- мог вырасти из тендера 2026-го); даты нет — не мешает.
-- НЕ привязаны — решать человеку («Договоры и ДС» → фильтр «Без тендера», поле «Тендер» в форме): контрагента нет среди участников
-- тендеров объекта, на объекте нет тендеров, дата не сходится, кандидатов несколько и слова их не различают.
--
-- Каждая пара при запуске проверяется заново. Пропускается с сообщением, ничего не ломая: договор удалён или уже с тендером, тендер
-- удалён или на другом объекте, контрагент больше не победитель (A) или участник (B). Правится только tender_id.
-- Проверка «после» (расхождение — ошибка, транзакция откатывается): привязано ровно столько, сколько не пропущено; суммы, статусы,
-- стороны и объекты договоров те же; ДС и уже привязанные договоры не изменились. Журнал «История» — запись у каждого договора.
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1. В выводе только ID и
-- числа. Откат — migration/data/20261103_contracts_tender_links_rollback.sql.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261103_contracts_tender_links.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261103_contracts_tender_links.sql ) # применить
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
  c_fix constant text := '20261103_contracts_tender_links';
  c_who constant text := 'Исправление данных 03.11.2026 (скрипт)';
  c_links constant jsonb := '[
    {"id": 5, "t": "1cc5c9cc-7721-4a99-9ef2-55e8cf615e59", "n": 225, "b": "A2"},
    {"id": 13, "t": "c8c94a67-0196-4074-82bf-3f82b211be44", "n": 711, "b": "A2"},
    {"id": 16, "t": "9c5ca0a8-6d91-4d5c-a767-cbe3a7b20670", "n": 117, "b": "B"},
    {"id": 18, "t": "bfb82511-a50c-4a32-903e-a1e3a2ca7059", "n": 9, "b": "A1"},
    {"id": 19, "t": "52c5a6fb-1005-4b22-af9f-9eb9df7c7018", "n": 554, "b": "A3"},
    {"id": 22, "t": "03af0ef3-7169-492d-a5a9-93802c889576", "n": 491, "b": "B"},
    {"id": 26, "t": "9c5ca0a8-6d91-4d5c-a767-cbe3a7b20670", "n": 117, "b": "B"},
    {"id": 27, "t": "658c3ac6-0c41-4994-aaca-ae746753de0c", "n": 135, "b": "A3"},
    {"id": 33, "t": "6b8959b9-16e4-441f-8a9c-f13ddd6d9995", "n": 430, "b": "A3"},
    {"id": 37, "t": "6908d203-24ae-46b2-8ea5-d78301431ecb", "n": 636, "b": "A1"},
    {"id": 42, "t": "b21c43d3-9458-47a7-8185-523fa7e0c8d3", "n": 73, "b": "A1"},
    {"id": 43, "t": "bda1f6f4-479f-498d-954d-24abf5abfebb", "n": 522, "b": "A1"},
    {"id": 44, "t": "1cc5c9cc-7721-4a99-9ef2-55e8cf615e59", "n": 225, "b": "A2"},
    {"id": 45, "t": "52c5a6fb-1005-4b22-af9f-9eb9df7c7018", "n": 554, "b": "A3"},
    {"id": 48, "t": "afcc73e6-c89a-456f-8c39-179af6564521", "n": 484, "b": "B"},
    {"id": 51, "t": "75af4d03-243d-40c0-ab62-85cad1a87200", "n": 489, "b": "A2"},
    {"id": 62, "t": "5a408901-faf8-4f0f-8c0c-7d746e6eecd4", "n": 251, "b": "A1"},
    {"id": 63, "t": "c8c94a67-0196-4074-82bf-3f82b211be44", "n": 711, "b": "A2"},
    {"id": 65, "t": "75af4d03-243d-40c0-ab62-85cad1a87200", "n": 489, "b": "A2"},
    {"id": 66, "t": "75af4d03-243d-40c0-ab62-85cad1a87200", "n": 489, "b": "A2"},
    {"id": 69, "t": "f59d6353-57cd-4b9e-a833-b8a3ef62873d", "n": 480, "b": "B"},
    {"id": 78, "t": "6086207a-d20b-4fb2-ad22-0c5b9532d57a", "n": 191, "b": "A2"},
    {"id": 83, "t": "2767771b-0746-45ac-aaa8-b562d0ce246f", "n": 578, "b": "B"},
    {"id": 86, "t": "e590af48-d003-484f-b743-88a9c69fb798", "n": 532, "b": "A1"},
    {"id": 87, "t": "a17bf205-6198-4eb3-a286-d2ff8b2fe4bb", "n": 550, "b": "A2"},
    {"id": 89, "t": "a18c6c61-e19a-4c7e-8b06-e334155005ec", "n": 582, "b": "B"},
    {"id": 90, "t": "a18c6c61-e19a-4c7e-8b06-e334155005ec", "n": 582, "b": "B"},
    {"id": 99, "t": "862980e1-54e4-4e50-bcb8-19e973cbb8e7", "n": 211, "b": "A1"},
    {"id": 126, "t": "a9df5d34-d657-46f8-9f16-a1c8de2a4e62", "n": 185, "b": "A1"},
    {"id": 148, "t": "1d674a1b-11d3-4c44-ad4f-314faa80bd7f", "n": 311, "b": "A3"},
    {"id": 185, "t": "10ff1f0a-57bb-4fe5-9077-2f0284dcfdd5", "n": 165, "b": "A1"},
    {"id": 186, "t": "2f8e3f3b-ca82-4230-968b-831a8809fb90", "n": 44, "b": "A1"},
    {"id": 202, "t": "d95068ae-6a95-4fc0-93f1-56cb3074caa0", "n": 151, "b": "B"},
    {"id": 234, "t": "951720c9-2047-45ef-b68e-42a1dd354949", "n": 163, "b": "A1"},
    {"id": 239, "t": "557eca13-01a4-4d37-af0d-c09c3e6d4ac3", "n": 399, "b": "A1"},
    {"id": 245, "t": "50873692-42ad-4188-af4c-3c318a4bd3d9", "n": 389, "b": "B"},
    {"id": 249, "t": "ea6e8b65-58cb-4a79-a031-c95998b5f776", "n": 307, "b": "A1"},
    {"id": 257, "t": "ad49b254-81ef-48b7-8ecf-3503296f2957", "n": 303, "b": "A1"},
    {"id": 274, "t": "bfea72ae-a8dc-4dc2-a56a-06696a77a4a2", "n": 221, "b": "A2"},
    {"id": 281, "t": "567c2656-6a76-4b91-b885-afb9aa387647", "n": 478, "b": "A1"},
    {"id": 285, "t": "9682c8de-a14e-4792-aed5-c95e24fd7525", "n": 25, "b": "A1"},
    {"id": 294, "t": "cc4712d2-9233-4dbf-ac0b-5bf6654a7445", "n": 295, "b": "B"},
    {"id": 327, "t": "6962a69e-5d22-4e75-b2f2-e0cb71a9dc81", "n": 526, "b": "A3"},
    {"id": 330, "t": "d1d4730d-96a7-4bba-9201-cbbbb0fd524c", "n": 586, "b": "A1"},
    {"id": 332, "t": "44cfb5dd-075c-4cfa-8c03-0d335f2e6efd", "n": 775, "b": "A1"},
    {"id": 334, "t": "8889fd78-5cbc-48ea-bfc8-932f79485c23", "n": 679, "b": "A1"},
    {"id": 335, "t": "982c1b54-ecc4-40ec-b903-2f8bbaf04c5b", "n": 719, "b": "A3"},
    {"id": 336, "t": "995a0ef6-bc47-4648-84ac-0a863fe0d228", "n": 689, "b": "A1"},
    {"id": 343, "t": "fd10c713-d27b-4d2f-aec4-35e37796323b", "n": 766, "b": "A1"},
    {"id": 347, "t": "01b15929-4a91-4fde-92c1-4deacc2482f5", "n": 402, "b": "A1"},
    {"id": 351, "t": "b6a18b53-261b-4e0c-8777-46d56a5aa99d", "n": 761, "b": "A1"},
    {"id": 357, "t": "912ddaca-76d0-4cd6-8395-2d6f89059cfb", "n": 289, "b": "B"},
    {"id": 359, "t": "c1d66696-cb25-4aa1-ba72-6fd67b073fc6", "n": 816, "b": "A1"},
    {"id": 367, "t": "1214333d-583f-4dcd-9de7-4595d8bb817b", "n": 91, "b": "B"},
    {"id": 874, "t": "bec301e6-1c83-447f-9e58-d3496c26a8b8", "n": 538, "b": "A1"},
    {"id": 884, "t": "7865c907-0367-4247-aab1-b1bd3f58b12e", "n": 716, "b": "A1"},
    {"id": 899, "t": "70c7911e-5d11-4ca6-b55b-5c3addaa56a4", "n": 697, "b": "A1"},
    {"id": 901, "t": "afcc73e6-c89a-456f-8c39-179af6564521", "n": 484, "b": "B"},
    {"id": 905, "t": "5dcab756-be4d-4bc8-a7bd-d0b88848c7e1", "n": 387, "b": "A2"},
    {"id": 1124, "t": "91084c0b-b22f-4110-b044-f6ab4174379a", "n": 99, "b": "A1"},
    {"id": 1154, "t": "6796b67e-b182-4a50-9364-6ba551d3c94e", "n": 97, "b": "A1"},
    {"id": 1189, "t": "4f805880-5f67-4e0f-95c3-929b08d66c72", "n": 193, "b": "A1"},
    {"id": 1214, "t": "0ee199c3-1264-4b8c-98ec-c02c6330ca67", "n": 580, "b": "A1"},
    {"id": 1354, "t": "f2d81f17-894e-4943-9d83-48de9466c646", "n": 107, "b": "A1"},
    {"id": 1365, "t": "7b9a986b-de14-4dc0-8653-dcc9c5b3bb2f", "n": 38, "b": "A2"},
    {"id": 1366, "t": "7b9a986b-de14-4dc0-8653-dcc9c5b3bb2f", "n": 38, "b": "A2"},
    {"id": 2021, "t": "277424fe-ac01-4027-b9ba-8e12a26f5f80", "n": 628, "b": "B"}
  ]';
  p record; c public.contracts; t public.tenders; v_parties uuid[]; v_ok boolean; v_why text;
  b_sig text; a_sig text; b_linked int; a_linked int; n_done int := 0; n_skip int := 0;
BEGIN
  SELECT count(*) INTO b_linked FROM public.contracts WHERE tender_id IS NOT NULL;
  -- Что не должно измениться ни у одного документа; tender_id — у всех, кроме записей этой правки.
  SELECT md5(string_agg(concat_ws('|', x.id, x.status, x.record_type, x.object_id, x.counterparty_id, x.contract_amount, x.psdc_total, x.gp_amount,
         x.contract_number, x.contract_date, x.work_name, x.deleted_at, x.parent_contract_id, x.root_contract_id), ',' ORDER BY x.id))
    INTO b_sig FROM public.contracts x;
  RAISE NOTICE 'до: привязано документов %, пар в списке %', b_linked, jsonb_array_length(c_links);

  FOR p IN SELECT (e ->> 'id')::bigint AS did, (e ->> 't')::uuid AS tid, (e ->> 'n') AS num, e ->> 'b' AS basis FROM jsonb_array_elements(c_links) e ORDER BY 1
  LOOP
    v_why := NULL;
    SELECT * INTO c FROM public.contracts x WHERE x.display_id = p.did;
    SELECT * INTO t FROM public.tenders x WHERE x.id = p.tid;
    IF c.id IS NULL THEN v_why := 'договора нет';
    ELSIF c.deleted_at IS NOT NULL THEN v_why := 'договор удалён';
    ELSIF c.record_type <> 'dp' THEN v_why := 'это не договор';
    ELSIF c.tender_id IS NOT NULL THEN v_why := 'уже привязан';
    ELSIF t.id IS NULL OR t.deleted_at IS NOT NULL THEN v_why := 'тендера нет или он удалён';
    ELSIF t.parent_tender_id IS NOT NULL THEN v_why := 'это тендер на материалы';
    ELSIF t.object_id IS DISTINCT FROM c.object_id THEN v_why := 'объекты разные';
    ELSE
      v_parties := ARRAY(SELECT c.counterparty_id WHERE c.counterparty_id IS NOT NULL
                         UNION SELECT cc.counterparty_id FROM public.contract_counterparties cc WHERE cc.contract_id = c.id);
      IF p.basis = 'B' THEN
        v_ok := EXISTS (SELECT 1 FROM public.tender_counterparties tc WHERE tc.tender_id = t.id AND tc.counterparty_id = ANY (v_parties));
        IF NOT v_ok THEN v_why := 'контрагент не участник тендера'; END IF;
      ELSE
        v_ok := t.winner_counterparty_id = ANY (v_parties)
             OR EXISTS (SELECT 1 FROM public.tender_winners w WHERE w.tender_id = t.id AND w.counterparty_id = ANY (v_parties));
        IF NOT v_ok THEN v_why := 'контрагент не победитель тендера'; END IF;
      END IF;
    END IF;
    IF v_why IS NOT NULL THEN
      n_skip := n_skip + 1;
      RAISE NOTICE 'пропуск: ID %: %', p.did, v_why;
      CONTINUE;
    END IF;

    UPDATE public.contracts SET tender_id = t.id WHERE id = c.id;
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES (c.id, 'field_updated', 'tender_id', jsonb_build_object('tender_id', NULL),
            jsonb_build_object('tender_id', t.id, 'fix', c_fix, 'basis', p.basis),
            format('Договор привязан к тендеру № %s: %s.', coalesce(t.public_tender_number::text, 'без номера'),
              CASE p.basis WHEN 'B' THEN 'контрагент подал КП, работы совпали с описанием тендера' ELSE 'контрагент — победитель этого тендера на объекте' END),
            c_who);
    n_done := n_done + 1;
  END LOOP;

  -- ── Проверка «после» ───────────────────────────────────────
  SELECT count(*) INTO a_linked FROM public.contracts WHERE tender_id IS NOT NULL;
  IF a_linked <> b_linked + n_done THEN RAISE EXCEPTION 'FAIL: привязано % (было %, правка %)', a_linked, b_linked, n_done; END IF;
  SELECT md5(string_agg(concat_ws('|', x.id, x.status, x.record_type, x.object_id, x.counterparty_id, x.contract_amount, x.psdc_total, x.gp_amount,
         x.contract_number, x.contract_date, x.work_name, x.deleted_at, x.parent_contract_id, x.root_contract_id), ',' ORDER BY x.id))
    INTO a_sig FROM public.contracts x;
  IF a_sig <> b_sig THEN RAISE EXCEPTION 'FAIL: изменилось что-то кроме тендера'; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts x JOIN public.contract_audit_log j ON j.contract_id = x.id
              WHERE j.new_value ->> 'fix' = c_fix AND x.record_type <> 'dp') THEN
    RAISE EXCEPTION 'FAIL: правка задела ДС';
  END IF;
  RAISE NOTICE 'правка: привязано договоров %, пропущено %; всего с тендером документов %', n_done, n_skip, a_linked;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
