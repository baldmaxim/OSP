-- Разовая правка данных базы tender.su10.ru (Яндекс): статус «Перезапуск» у тендеров, которые уже перезапущены другим тендером
-- (решение пользователя 06.11.2026: «нужно добавить статус тендера перезапуск и все уже перезапущенные пометить этим статусом —
-- например, в тендере 984 написано „перезапуск тендера №40“, значит у № 40 статус „Перезапуск“»).
-- Статус — текст tenders.status, ограничений в базе на него нет, миграция не нужна (src/utils/tenderStatuses.js, RESTART_STATUS).
--
-- Список посчитан по базе 06.11.2026 (только чтение): описание или примечание другого тендера называет номер перезапущенного.
--   № тендера  ← кто его перезапустил (где написано)
--    31 ← 710 «перезапуск №31» (гарантийный отдел)          259 ← 793 и 795 «ОЗДС (перезапуск тендера №259)»
--    40 ← 984 «перезапуск тендера №40»                      285 ← 562 «Перезапуск тендера 285»
--    59 ← 518 «перезапуск тендера №59»                      422 ← 814 «перезапуск тендера №422»
--    65 ← 502 «перезапуск тендера №65»                      522 ← 721, примечание «Перезапуск №522»
--    73 ← 733 «перезапуск тендера №81, №73»                 630 ← 847, примечание «Перезапуск 630»
--    79 ← 706 «перезапуск тендера №79»                      632 ← 862 «Перезапуск тендера №632»
--    81 ← 733 (и 83 — то же название с «(перезапуск)»)
--    85 ← 855: запись у самого № 85 — «перезапуск: тендер №855», в примечании «тендер перезапустили по обновленной РД: №855»
--          (855 — перезапуск 85; статус меняется у 85, у 855 — нет)
--   231 ← 769 «перезапуск тендера № 231»
-- У пятерых (40, 73, 231, 422, 522) записан победитель: его не трогаем, меняется только статус.
--
-- Только с -v by_name=1 — четыре тендера «Садовнической 69», у перезапуска которых номер не указан, а название то же
-- с «(перезапуск)»: 315 ← 325 (1 корпус), 321 ← 327 (2 корпус), 319 ← 329 (3.1 корпус), 323 ← 333 (4 корпус).
-- НЕ отмечены (номера предшественника нет и по названию он не находится): 8, 15, 107, 251, 289, 331 — решать человеку
-- («Тендеры» → статус «Перезапуск» у прежнего тендера).
--
-- Каждый тендер при запуске проверяется заново, пропуск — с сообщением: нет такого id, другой номер, удалён, это тендер на
-- материалы, уже «Перезапуск», идёт тендерная процедура (живую процедуру скрипт не закрывает). Правится только tenders.status;
-- победители, участники, КП, тендеры на материалы — нет. Журнал «История» тендера — запись у каждого.
-- Проверка «после» (расхождение — ошибка, транзакция откатывается): «Перезапуск» стал ровно у отмеченных, другие тендеры и другие
-- поля отмеченных не изменились.
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1. В выводе только
-- номера и числа. Откат — migration/data/20261106_tenders_restart_status_rollback.sql. Порядок с выкладкой: сначала выложить сайт
-- (frontend), где статус «Перезапуск» есть в списке, потом скрипт — иначе старая страница покажет статус без цвета и вкладки.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261106_tenders_restart_status.sql )                       # пробный
--   … && psql -X -v apply=1 -f migration/data/20261106_tenders_restart_status.sql )             # применить
--   … && psql -X -v apply=1 -v by_name=1 -f migration/data/20261106_tenders_restart_status.sql ) # и четыре по названию
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?by_name}
\else
  \set by_name 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Правила по строкам действуют и на владельца (FORCE RLS): служебная отметка — только на эту транзакцию.
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_
SELECT pg_catalog.set_config('osp.fix_by_name', :'by_name', true) \gset ignored_

DO $$
DECLARE
  c_fix constant text := '20261106_tenders_restart_status';
  c_who constant text := 'Исправление данных 06.11.2026 (скрипт)';
  c_status constant text := 'Перезапуск';
  -- id — из базы (не меняется), n — номер тендера для сверки, by — кто перезапустил, name — только с by_name=1.
  c_list constant jsonb := '[
    {"id": "406316ae-180d-47af-a068-12c5439decce", "n": 31,  "by": "710"},
    {"id": "92bd9d82-69f2-46ae-a10a-05862833cf3d", "n": 40,  "by": "984"},
    {"id": "9896de7c-2392-483b-b480-9173327c12a1", "n": 59,  "by": "518"},
    {"id": "0c56acd3-c587-44fb-bdce-fd795933b8a9", "n": 65,  "by": "502"},
    {"id": "b21c43d3-9458-47a7-8185-523fa7e0c8d3", "n": 73,  "by": "733"},
    {"id": "5268bd72-bba6-4d86-89d4-2b615876fc3d", "n": 79,  "by": "706"},
    {"id": "00829cce-633e-4b02-b27b-6fe0f4d038c9", "n": 81,  "by": "733"},
    {"id": "f10a4d54-3c71-477b-9083-76b93c1dcc0f", "n": 85,  "by": "855"},
    {"id": "d70f243d-5567-4f98-855b-116fcece75cc", "n": 231, "by": "769"},
    {"id": "8ad55b19-c0f8-40b5-af06-5df38c3245bb", "n": 259, "by": "793, 795"},
    {"id": "0cf2b718-88ff-4cbe-beb6-d7c68cdb691b", "n": 285, "by": "562"},
    {"id": "decfa697-5d6e-4abe-a3b3-fc9f2313867d", "n": 422, "by": "814"},
    {"id": "bda1f6f4-479f-498d-954d-24abf5abfebb", "n": 522, "by": "721"},
    {"id": "247e25aa-f338-4ca3-87eb-d5672b91a8a5", "n": 630, "by": "847"},
    {"id": "dae1d993-4c28-4606-8b4d-3ae0b2af2ed0", "n": 632, "by": "862"},
    {"id": "077790ab-0ed2-4869-81ca-7f1591795b9f", "n": 315, "by": "325", "name": true},
    {"id": "f246684a-eaaa-4521-9b13-8b5717b2602c", "n": 321, "by": "327", "name": true},
    {"id": "5546fe80-963b-4881-89a1-8f2cdb463852", "n": 319, "by": "329", "name": true},
    {"id": "a144ac4d-e5f6-441d-ab59-3d43494ee366", "n": 323, "by": "333", "name": true}
  ]';
  v_by_name boolean := coalesce(current_setting('osp.fix_by_name', true), '0') IN ('1', 'on', 'true');
  p record; t public.tenders; v_why text; v_marked uuid[] := '{}';
  b_sig text; a_sig text; b_restart int; a_restart int; n_done int := 0; n_skip int := 0;
BEGIN
  SELECT count(*) INTO b_restart FROM public.tenders WHERE status = c_status;
  -- Что не должно измениться ни у одного тендера: все поля, кроме статуса и отметки времени (её ставит триггер).
  SELECT md5(string_agg(concat_ws('|', x.id, x.public_tender_number, x.tender_type, x.parent_tender_id, x.object_id, x.department,
         x.work_description, x.notes, x.winner_counterparty_id, x.deleted_at, x.tender_start_date, x.tender_end_date,
         x.cost_plan_status, x.vor_status, x.materials_status), ',' ORDER BY x.id))
    INTO b_sig FROM public.tenders x;
  RAISE NOTICE 'до: в статусе «Перезапуск» тендеров %, в списке % (по названию — %)',
    b_restart, jsonb_array_length(c_list), CASE WHEN v_by_name THEN 'да' ELSE 'нет' END;

  FOR p IN SELECT (e ->> 'id')::uuid AS tid, (e ->> 'n')::int AS num, e ->> 'by' AS by_num, coalesce((e ->> 'name')::boolean, false) AS by_name
             FROM jsonb_array_elements(c_list) e ORDER BY 2
  LOOP
    IF p.by_name AND NOT v_by_name THEN CONTINUE; END IF;
    v_why := NULL;
    t := NULL;
    SELECT * INTO t FROM public.tenders x WHERE x.id = p.tid;
    IF t.id IS NULL THEN v_why := 'тендера нет';
    ELSIF t.public_tender_number IS DISTINCT FROM p.num THEN v_why := format('у id другой номер (%s)', t.public_tender_number);
    ELSIF t.deleted_at IS NOT NULL THEN v_why := 'тендер удалён';
    ELSIF t.parent_tender_id IS NOT NULL OR coalesce(t.tender_type, 'main') <> 'main' THEN v_why := 'это тендер на материалы';
    ELSIF t.status = c_status THEN v_why := 'уже «Перезапуск»';
    ELSIF t.status = 'Идет тендерная процедура' THEN v_why := 'идёт тендерная процедура — решать человеку';
    END IF;
    IF v_why IS NOT NULL THEN
      n_skip := n_skip + 1;
      RAISE NOTICE 'пропуск: № %: %', p.num, v_why;
      CONTINUE;
    END IF;

    UPDATE public.tenders SET status = c_status WHERE id = t.id;
    INSERT INTO public.tender_audit_log (tender_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES (t.id, 'status_changed', NULL, to_jsonb(t.status), to_jsonb(c_status),
            format('Статус: %s → %s (перезапущен тендером № %s)', coalesce(t.status, '—'), c_status, p.by_num),
            c_who);
    v_marked := v_marked || t.id;
    n_done := n_done + 1;
    RAISE NOTICE 'отмечен: № % (было «%», перезапуск — № %)', p.num, t.status, p.by_num;
  END LOOP;

  -- ── Проверка «после» ───────────────────────────────────────
  SELECT count(*) INTO a_restart FROM public.tenders WHERE status = c_status;
  IF a_restart <> b_restart + n_done THEN RAISE EXCEPTION 'FAIL: «Перезапуск» у % (было %, правка %)', a_restart, b_restart, n_done; END IF;
  IF EXISTS (SELECT 1 FROM public.tenders x WHERE x.id = ANY (v_marked) AND x.status <> c_status) THEN
    RAISE EXCEPTION 'FAIL: статус отмеченного тендера не «Перезапуск»';
  END IF;
  SELECT md5(string_agg(concat_ws('|', x.id, x.public_tender_number, x.tender_type, x.parent_tender_id, x.object_id, x.department,
         x.work_description, x.notes, x.winner_counterparty_id, x.deleted_at, x.tender_start_date, x.tender_end_date,
         x.cost_plan_status, x.vor_status, x.materials_status), ',' ORDER BY x.id))
    INTO a_sig FROM public.tenders x;
  IF a_sig <> b_sig THEN RAISE EXCEPTION 'FAIL: изменилось что-то кроме статуса'; END IF;
  IF (SELECT count(*) FROM public.tender_audit_log j WHERE j.changed_by_name = c_who AND j.tender_id = ANY (v_marked)) <> n_done THEN
    RAISE EXCEPTION 'FAIL: записей в истории не столько, сколько отмечено';
  END IF;
  RAISE NOTICE 'правка: отмечено %, пропущено %; всего в статусе «Перезапуск» %', n_done, n_skip, a_restart;
  RAISE NOTICE 'OK: проверка «после» сошлась (%)', c_fix;
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
