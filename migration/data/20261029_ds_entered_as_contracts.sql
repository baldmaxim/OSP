-- Разовая правка данных базы tender.su10.ru (Яндекс): ДС, заведённые в «Договорах и ДС» договорами.
--
-- До 20.10.2026 на сайте не было ввода ДС, и юристы заводили ДС как договор («ДС № 1 к СУ2-…»). Такая запись
-- стоит в реестре отдельным договором: не раскрывается под своим договором, не участвует в его сумме, а ДС,
-- загруженные импортом 27.10, задвоились. Поиск 29.10 (только чтение): записи-договоры с «ДС» / «доп.
-- соглашение» в номере, предмете или примечании; договор — по номеру из записи, той же стороне и объекту; сверка
-- с Larix.
--
-- Что меняется (ID портала):
--   ID   было: тип «Договор», №                станет                       изменяемый документ
--   20   ДС № 5 к СУ2-ЗИЛ33-СП-Э005-13          ДС на изменение ВОР № 5      ID 752 (ДС № 1 к договору ID 366)
--   345  ДС №6                                  ДС на изменение ВОР № 6      ID 20 (ДС № 5 выше)
--   45   ДС №1 к ДП №80623 от 15.07.2026        ДС на изменение ВОР № 1      договор ID 19 № 80622-МО от 15.07.2026
--                                                                            (в Larix у «Адм-Строй» он один — 80622-МО)
--   96   ДС № 1 к СУ2-ПРИМ14-И-Э012-0726-1      ДС на доп. работы № 1        договор ID 28
--   401  ДС 1 к СУ2-ПРИМ14-И-Э012-050626-2      ДС на доп. работы № 1        договор ID 15
--   94   ДС № 1 к СУ2-ПРИМ14-И-240726-2         ДС на доп. работы № 1        договор ID 65   + условия из ID 821
--   338  2 («ДС к Договору Фасады 14.5»)         ДС на доп. работы № 2        договор ID 317  + условия из ID 833
-- ID 821 и 833 — те же ДС из импорта 27.10 (Larix 1201 и 1235): без приложений, истории, файлов и заявок. Их
-- условия (сумма, НДС, даты, наименование работ, ссылка Larix, список изменяемых полей) переносятся в записи
-- юристов 94 и 338 (там приложения, история, примечания, путь к папке; их адрес открывают), а сами они уходят в
-- «Удаленные» (восстанавливаются).
-- Не трогаются: ID 12 «ДС № 2 к ДП_5_СД_ВС_П» и ID 38 (ДС № 1 «Коммунальных систем», ЗИЛ 33) — их договоров в
-- реестре нет, привязать не к чему (заявки на ДС ссылаются на них как на договор); ID 50 — по решению пользователя.
--
-- Правила — как у сайта (src/utils/contractAmendments.js, импорт applyAmendmentInheritance):
--   * ДС на изменение ВОР: пустые условия берут значения изменяемого документа (так их заполняет форма ДС);
--     список изменяемых полей — пустой: значения в этих записях вносились как условия «договора», а не как
--     изменения, поэтому условия и суммы договоров не меняются. Изменения юрист указывает в форме ДС.
--   * ДС на доп. работы: пустые НДС и валюта — от договора; изменяемые поля — заполненные и отличные от договора.
--   * Номер ДС — только номер («5»), как у остальных ДС; прежний текст номера — в журнале.
--
-- Тип документа триггер trg_contracts_hierarchy_guard менять не даёт («создайте новый документ»), а новый
-- документ потерял бы ID портала, приложения, историю и файлы. Поэтому триггер выключается только на время
-- правки внутри транзакции (ALTER TABLE блокирует запись в contracts до конца транзакции — доли секунды) и сразу
-- включается; затем все исправленные записи проходят через тот же триггер повторно — его правила (тип
-- изменяемого документа, одно изменение на документ, незавершённое — только вершина ветки) проверяет сама база.
--
-- Проверка «после» (любое расхождение — ошибка, транзакция откатывается): тип, изменяемый документ, корень и
-- номер каждой записи; дубли в «Удаленных»; триггер включён; живых договоров −7, ДС на изменение +3, на доп.
-- работы +2; актуальные суммы затронутых договоров (366, 19, 28, 15, 65, 317 — по правилам сайта:
-- contractActualAmount) — до копейки те же. В журнал «История» каждой записи — что было и что стало (по нему
-- работает откат).
--
-- По умолчанию — ПРОБНЫЙ прогон: всё проверяется, правится и сверяется, затем ROLLBACK. Применить — с -v apply=1.
-- В выводе только ID и числа. Откат — migration/data/20261029_ds_entered_as_contracts_rollback.sql.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261029_ds_entered_as_contracts.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261029_ds_entered_as_contracts.sql ) # применить
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
  c_fix   constant text := '20261029_ds_entered_as_contracts';
  c_who   constant text := 'Исправление данных 29.10.2026 (скрипт)';
  -- Условия, которые ДС вправе менять (OVERRIDABLE_FIELDS в src/utils/contractAmendments.js).
  c_terms constant text[] := ARRAY['contract_amount', 'gp_amount', 'currency', 'vat_rate', 'amount_includes_vat',
    'bsm', 'work_name', 'work_start_date', 'work_end_date', 'warranty_retention_percent',
    'warranty_retention_period', 'warranty_period', 'gen_director_name', 'phone', 'email', 'comments'];
  -- Что пишется в журнал «было / стало» и по чему работает откат.
  c_snap  constant text[] := c_terms || ARRAY['record_type', 'parent_contract_id', 'root_contract_id',
    'contract_number', 'changed_fields', 'contract_date', 'signed_date', 'document_link', 'deleted_at'];
  -- ds — запись, was — её номер сейчас, parent / root — изменяемый документ и договор (с номером root_num),
  -- num — номер ДС, dup — та же ДС из импорта 27.10.
  c_plan  constant jsonb := '[
    {"ord": 1, "ds": 20,  "was": "ДС № 5 к СУ2-ЗИЛ33-СП-Э005-13",     "type": "ds_vor",   "parent": 752, "root": 366, "root_num": "СУ2-ЗИЛ33-СП-Э005-13",       "num": "5"},
    {"ord": 2, "ds": 345, "was": "ДС №6",                             "type": "ds_vor",   "parent": 20,  "root": 366, "root_num": "СУ2-ЗИЛ33-СП-Э005-13",       "num": "6"},
    {"ord": 3, "ds": 45,  "was": "ДС №1 к ДП №80623 от 15.07.2026",   "type": "ds_vor",   "parent": 19,  "root": 19,  "root_num": "80622-МО",                   "num": "1"},
    {"ord": 4, "ds": 96,  "was": "ДС № 1 к СУ2-ПРИМ14-И-Э012-0726-1", "type": "ds_extra", "parent": 28,  "root": 28,  "root_num": "СУ2-ПРИМ14-И-Э012-0726-1",   "num": "1"},
    {"ord": 5, "ds": 401, "was": "ДС 1 к СУ2-ПРИМ14-И-Э012-050626-2", "type": "ds_extra", "parent": 15,  "root": 15,  "root_num": "СУ2-ПРИМ14-И-Э012-050626-2", "num": "1"},
    {"ord": 6, "ds": 94,  "was": "ДС № 1 к СУ2-ПРИМ14-И-240726-2",    "type": "ds_extra", "parent": 65,  "root": 65,  "root_num": "СУ2-ПРИМ14-И-240726-2",      "num": "1", "dup": 821},
    {"ord": 7, "ds": 338, "was": "2",                                 "type": "ds_extra", "parent": 317, "root": 317, "root_num": "СУ2-ПРИМ14-И-Э012-0326-1",   "num": "2", "dup": 833}
  ]';
  -- Актуальная сумма договора по правилам сайта (contractActualAmount): ветка договора и каждая завершённая
  -- ветка доп. работ; в ветке — сумма основания (ПСДЦ или ручная), затем завершённые изменения по цепочке
  -- (сумма — если она в списке изменяемых полей, применённая ПСДЦ — всегда). → {"ID договора": сумма}.
  c_amounts constant text := $q$
    WITH RECURSIVE base AS (
      SELECT r.id AS root_id, r.id AS base_id FROM public.contracts r WHERE r.id = ANY($1)
      UNION ALL
      SELECT e.parent_contract_id, e.id FROM public.contracts e
       WHERE e.parent_contract_id = ANY($1) AND e.record_type = 'ds_extra'
         AND e.deleted_at IS NULL AND e.status = 'completed'
    ), walk AS (
      SELECT b.root_id, b.base_id, c.id AS cur_id, coalesce(c.psdc_total, c.contract_amount) AS amt, 0 AS depth
        FROM base b JOIN public.contracts c ON c.id = b.base_id
      UNION ALL
      SELECT w.root_id, w.base_id, n.id,
             CASE WHEN n.psdc_total IS NOT NULL THEN n.psdc_total
                  WHEN 'contract_amount' = ANY (n.changed_fields) THEN n.contract_amount
                  ELSE w.amt END,
             w.depth + 1
        FROM walk w JOIN public.contracts n
          ON n.parent_contract_id = w.cur_id AND n.record_type = 'ds_vor'
         AND n.deleted_at IS NULL AND n.status = 'completed'
    )
    SELECT coalesce(jsonb_object_agg(r.display_id::text, t.total), '{}'::jsonb)
      FROM (SELECT root_id, sum(coalesce(amt, 0)) AS total
              FROM (SELECT DISTINCT ON (base_id) root_id, base_id, amt FROM walk ORDER BY base_id, depth DESC) l
             GROUP BY root_id) t
      JOIN public.contracts r ON r.id = t.root_id
  $q$;
  p record;
  v_ids uuid[]; v_roots uuid[]; v_ds_ids uuid[]; v_dup_ids uuid[];
  v_old jsonb; v_par jsonb; v_dup jsonb; v_root jsonb; v_new jsonb; v_after jsonb;
  v_changed text[]; v_desc text; f text; n int; m int;
  b_types jsonb; a_types jsonb; b_amounts jsonb; a_amounts jsonb;
BEGIN
  -- Все участники правки — под блокировку до конца транзакции (никто не правит их между проверкой и правкой).
  SELECT array_agg(c.id ORDER BY c.id) INTO v_ids
    FROM public.contracts c
   WHERE c.display_id IN (SELECT (x ->> k)::bigint FROM jsonb_array_elements(c_plan) x,
                                 unnest(ARRAY['ds', 'parent', 'root', 'dup']) k WHERE x ? k);
  PERFORM 1 FROM public.contracts WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  SELECT array_agg(DISTINCT c.id) INTO v_roots FROM public.contracts c
   WHERE c.display_id IN (SELECT (x ->> 'root')::bigint FROM jsonb_array_elements(c_plan) x);
  SELECT array_agg(c.id) INTO v_ds_ids FROM public.contracts c
   WHERE c.display_id IN (SELECT (x ->> 'ds')::bigint FROM jsonb_array_elements(c_plan) x);
  SELECT array_agg(c.id) INTO v_dup_ids FROM public.contracts c
   WHERE c.display_id IN (SELECT (x ->> 'dup')::bigint FROM jsonb_array_elements(c_plan) x WHERE x ? 'dup');
  IF cardinality(v_roots) <> 6 OR cardinality(v_ds_ids) <> 7 OR cardinality(v_dup_ids) <> 2 THEN
    RAISE EXCEPTION 'Не найдены записи плана: договоров %, записей %, дублей % (ждали 6, 7, 2)',
      cardinality(v_roots), cardinality(v_ds_ids), cardinality(v_dup_ids);
  END IF;

  -- ── До правки ──────────────────────────────────────────────────────────────────────────────────────────────
  FOR p IN SELECT * FROM jsonb_to_recordset(c_plan) AS x(ord int, ds bigint, was text, type text, parent bigint,
                                                         root bigint, root_num text, num text, dup bigint)
           ORDER BY ord LOOP
    SELECT to_jsonb(c) INTO v_old FROM public.contracts c WHERE c.display_id = p.ds;
    SELECT to_jsonb(c) INTO v_root FROM public.contracts c WHERE c.display_id = p.root;
    SELECT to_jsonb(c) INTO v_par FROM public.contracts c WHERE c.display_id = p.parent;

    IF v_old ->> 'record_type' <> 'dp' THEN
      RAISE EXCEPTION 'ID %: тип уже «%» — правка уже применена?', p.ds, v_old ->> 'record_type';
    END IF;
    IF v_old ->> 'deleted_at' IS NOT NULL OR v_old ->> 'parent_contract_id' IS NOT NULL
       OR btrim(v_old ->> 'contract_number') IS DISTINCT FROM p.was THEN
      RAISE EXCEPTION 'ID %: запись не та, что при поиске 29.10 (удалена, есть изменяемый документ или другой номер)', p.ds;
    END IF;
    IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = (v_old ->> 'id')::uuid AND k.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'ID %: к записи уже прикреплены ДС', p.ds;
    END IF;
    IF EXISTS (SELECT 1 FROM public.dc_requests r WHERE r.contract_id = (v_old ->> 'id')::uuid)
       OR EXISTS (SELECT 1 FROM public.counterparty_contract_links l WHERE l.contract_id = (v_old ->> 'id')::uuid) THEN
      RAISE EXCEPTION 'ID %: на запись ссылаются как на договор (заявки на ДС или прикрепление к контрагенту)', p.ds;
    END IF;

    IF v_root IS NULL OR v_root ->> 'record_type' <> 'dp' OR v_root ->> 'deleted_at' IS NOT NULL
       OR btrim(v_root ->> 'contract_number') IS DISTINCT FROM p.root_num THEN
      RAISE EXCEPTION 'ID %: договор ID % не найден, удалён или с другим номером', p.ds, p.root;
    END IF;
    IF (v_root -> 'counterparty_id') IS DISTINCT FROM (v_old -> 'counterparty_id')
       OR (v_root -> 'object_id') IS DISTINCT FROM (v_old -> 'object_id') THEN
      RAISE EXCEPTION 'ID %: сторона или объект не совпадают с договором ID %', p.ds, p.root;
    END IF;

    IF v_par IS NULL OR v_par ->> 'deleted_at' IS NOT NULL THEN
      RAISE EXCEPTION 'ID %: изменяемый документ ID % не найден или удалён', p.ds, p.parent;
    END IF;
    IF p.parent IN (SELECT (x ->> 'ds')::bigint FROM jsonb_array_elements(c_plan) x WHERE (x ->> 'ord')::int < p.ord) THEN
      NULL;  -- изменяемый документ — запись этого же плана, исправленная раньше; проверит триггер после правки
    ELSIF p.type = 'ds_extra' THEN
      -- ДС на доп. работы — только к договору; у договора нет живых изменений ВОР, поэтому его НДС и валюта —
      -- действующие (как effectiveValues).
      IF p.parent <> p.root OR EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = (v_par ->> 'id')::uuid
                                         AND k.record_type = 'ds_vor' AND k.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'ID %: ДС на доп. работы — к договору без изменений ВОР, а ID % не такой', p.ds, p.parent;
      END IF;
    ELSE
      -- ДС на изменение ВОР — к вершине ветки: договор или завершённое изменение этого договора без изменений ниже.
      IF NOT (p.parent = p.root
              OR (v_par ->> 'record_type' = 'ds_vor' AND v_par ->> 'status' = 'completed'
                  AND v_par ->> 'root_contract_id' = v_root ->> 'id'))
         OR EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = (v_par ->> 'id')::uuid
                      AND k.record_type = 'ds_vor' AND k.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'ID %: ID % — не вершина ветки договора ID %', p.ds, p.parent, p.root;
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.contracts k
                WHERE k.root_contract_id = (v_root ->> 'id')::uuid AND k.record_type <> 'dp' AND k.deleted_at IS NULL
                  AND btrim(k.contract_number) = p.num AND k.display_id IS DISTINCT FROM p.dup) THEN
      RAISE EXCEPTION 'ID %: у договора ID % уже есть ДС № %', p.ds, p.root, p.num;
    END IF;

    IF p.dup IS NOT NULL THEN
      SELECT to_jsonb(c) INTO v_dup FROM public.contracts c WHERE c.display_id = p.dup;
      IF v_dup IS NULL OR v_dup ->> 'deleted_at' IS NOT NULL OR v_dup ->> 'record_type' <> p.type
         OR v_dup ->> 'parent_contract_id' IS DISTINCT FROM v_par ->> 'id' OR btrim(v_dup ->> 'contract_number') <> p.num
         OR v_dup ->> 'status' <> 'completed'
         OR (v_dup -> 'counterparty_id') IS DISTINCT FROM (v_old -> 'counterparty_id') THEN
        RAISE EXCEPTION 'ID %: дубль ID % не тот, что при поиске 29.10', p.ds, p.dup;
      END IF;
      -- В «Удаленные» уходит только пустая запись: всё, что к ней привязано, иначе пропало бы с глаз.
      IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.contract_appendices x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.contract_attachments x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.contract_advance_schedule x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.contract_clauses x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.contract_audit_log x WHERE x.contract_id = (v_dup ->> 'id')::uuid  -- кроме строк этой правки и её отката
                      AND c_fix IS DISTINCT FROM coalesce(x.new_value ->> 'fix', x.new_value ->> 'fix_rollback'))
         OR EXISTS (SELECT 1 FROM public.psdc x WHERE x.document_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.dc_requests x WHERE (v_dup ->> 'id')::uuid IN (x.contract_id, x.amendment_id))
         OR EXISTS (SELECT 1 FROM public.tasks x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.counterparty_contract_links x WHERE x.contract_id = (v_dup ->> 'id')::uuid)
         OR EXISTS (SELECT 1 FROM public.s3_documents x WHERE x.owner_type = 'contract' AND x.owner_id = (v_dup ->> 'id')::uuid) THEN
        RAISE EXCEPTION 'ID %: к дублю ID % уже что-то привязано — объединять вручную', p.ds, p.dup;
      END IF;
    END IF;
    RAISE NOTICE 'до:    ID % — проверки пройдены: % к ID %, № %', p.ds, p.type, p.parent,
      p.num || coalesce(', дубль ID ' || p.dup, '');
  END LOOP;

  SELECT jsonb_object_agg(record_type, cnt) INTO b_types
    FROM (SELECT record_type, count(*) AS cnt FROM public.contracts WHERE deleted_at IS NULL GROUP BY 1) s;
  EXECUTE c_amounts INTO b_amounts USING v_roots;
  RAISE NOTICE 'до:    живых документов по типам %', b_types;
  RAISE NOTICE 'до:    актуальные суммы договоров %', b_amounts;

  -- ── Правка ─────────────────────────────────────────────────────────────────────────────────────────────────
  -- 1) Дубли из импорта — в «Удаленные» (как кнопка «Удалить» на сайте); триггеры включены и проверяют это сами.
  FOR p IN SELECT * FROM jsonb_to_recordset(c_plan) AS x(ord int, ds bigint, dup bigint) WHERE dup IS NOT NULL ORDER BY ord LOOP
    SELECT to_jsonb(c) INTO v_old FROM public.contracts c WHERE c.display_id = p.dup;
    UPDATE public.contracts SET deleted_at = now() WHERE id = (v_old ->> 'id')::uuid AND deleted_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'ID %: в «Удаленные» не перенесён', p.dup; END IF;
    SELECT to_jsonb(c) INTO v_after FROM public.contracts c WHERE c.id = (v_old ->> 'id')::uuid;
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES ((v_old ->> 'id')::uuid, 'soft_deleted', 'deleted_at',
            (SELECT jsonb_object_agg(k, v) FROM jsonb_each(v_old) e(k, v) WHERE k = ANY (c_snap)),
            (SELECT jsonb_object_agg(k, v) FROM jsonb_each(v_after) e(k, v) WHERE k = ANY (c_snap)) || jsonb_build_object('fix', c_fix),
            format('Дубль: эта ДС уже была заведена в реестре записью ID %s (договором, до появления ДС на сайте). '
                   'Её условия перенесены в ID %s, а эта запись перенесена в «Удалённые».', p.ds, p.ds),
            c_who);
    RAISE NOTICE 'правка: ID % — в «Удаленные»', p.dup;
  END LOOP;

  -- 2) Смена типа — при выключенном триггере иерархии (он запрещает менять тип); включается сразу после.
  EXECUTE 'ALTER TABLE public.contracts DISABLE TRIGGER trg_contracts_hierarchy_guard';

  FOR p IN SELECT * FROM jsonb_to_recordset(c_plan) AS x(ord int, ds bigint, was text, type text, parent bigint,
                                                         root bigint, root_num text, num text, dup bigint)
           ORDER BY ord LOOP
    SELECT to_jsonb(c) INTO v_old FROM public.contracts c WHERE c.display_id = p.ds;
    SELECT to_jsonb(c) INTO v_par FROM public.contracts c WHERE c.display_id = p.parent;  -- уже исправленный, если из плана
    SELECT to_jsonb(c) INTO v_root FROM public.contracts c WHERE c.display_id = p.root;
    v_dup := NULL;
    IF p.dup IS NOT NULL THEN SELECT to_jsonb(c) INTO v_dup FROM public.contracts c WHERE c.display_id = p.dup; END IF;

    v_new := v_old;
    v_changed := '{}';
    IF v_dup IS NOT NULL THEN
      -- Условия — из ДС реестра (импорт, совпадает с Larix), работа юриста (статус, приложения, примечания,
      -- путь к папке, дата принятия) — своя.
      FOREACH f IN ARRAY c_terms || ARRAY['contract_date', 'signed_date', 'document_link'] LOOP
        IF coalesce(btrim(v_dup ->> f), '') <> '' THEN v_new := jsonb_set(v_new, ARRAY[f], v_dup -> f); END IF;
      END LOOP;
      v_changed := ARRAY(SELECT jsonb_array_elements_text(v_dup -> 'changed_fields'));
    ELSE
      FOREACH f IN ARRAY c_terms LOOP
        IF coalesce(btrim(v_old ->> f), '') = '' THEN
          IF p.type = 'ds_vor' THEN
            -- Как форма ДС на изменение: пустое — из изменяемого документа (сумма — его ПСДЦ, если применена).
            v_new := jsonb_set(v_new, ARRAY[f],
              CASE WHEN f = 'contract_amount' AND v_par ->> 'psdc_total' IS NOT NULL THEN v_par -> 'psdc_total'
                   ELSE coalesce(v_par -> f, 'null'::jsonb) END);
          ELSIF f IN ('vat_rate', 'currency') THEN
            v_new := jsonb_set(v_new, ARRAY[f], coalesce(v_par -> f, 'null'::jsonb));  -- ставка и валюта — договора
          END IF;
        ELSIF p.type = 'ds_extra' AND (f IN ('contract_amount', 'gp_amount') OR (v_old -> f) IS DISTINCT FROM (v_par -> f)) THEN
          v_changed := v_changed || f;
        END IF;
      END LOOP;
    END IF;
    v_new := v_new || jsonb_build_object('record_type', p.type, 'parent_contract_id', v_par -> 'id',
                                         'root_contract_id', v_root -> 'id', 'contract_number', p.num,
                                         'changed_fields', to_jsonb(v_changed));

    UPDATE public.contracts c SET
      record_type = x.record_type, parent_contract_id = x.parent_contract_id, root_contract_id = x.root_contract_id,
      contract_number = x.contract_number, changed_fields = x.changed_fields,
      contract_date = x.contract_date, signed_date = x.signed_date, document_link = x.document_link,
      contract_amount = x.contract_amount, gp_amount = x.gp_amount, currency = x.currency, vat_rate = x.vat_rate,
      amount_includes_vat = x.amount_includes_vat, bsm = x.bsm, work_name = x.work_name,
      work_start_date = x.work_start_date, work_end_date = x.work_end_date,
      warranty_retention_percent = x.warranty_retention_percent, warranty_retention_period = x.warranty_retention_period,
      warranty_period = x.warranty_period, gen_director_name = x.gen_director_name, phone = x.phone, email = x.email,
      comments = x.comments
    FROM jsonb_populate_record(NULL::public.contracts, v_new) AS x
    WHERE c.id = (v_old ->> 'id')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'ID %: исправлено строк % (ждали 1)', p.ds, n; END IF;

    SELECT to_jsonb(c) INTO v_after FROM public.contracts c WHERE c.id = (v_old ->> 'id')::uuid;
    v_desc := format('Исправление занесения: это ДС, а было заведено договором (до появления ДС на сайте). '
                     'Тип: «Договор» → «%s». Изменяемый документ — ID %s (договор ID %s № %s). Номер: «%s» → «%s».%s',
                     CASE p.type WHEN 'ds_vor' THEN 'ДС на изменение ВОР' ELSE 'ДС на дополнительные работы' END,
                     p.parent, p.root, p.root_num, p.was, p.num,
                     CASE WHEN p.dup IS NOT NULL THEN
                       format(' Условия (сумма, НДС, даты, наименование работ, ссылка Larix) — из ДС ID %s, загруженной '
                              'из реестра ДС 27.10; ID %s перенесена в «Удалённые» как дубль.', p.dup, p.dup)
                     WHEN p.type = 'ds_vor' THEN
                       ' Пустые условия — из изменяемого документа; условия и сумму договора это ДС пока не меняет: '
                       'изменения указываются в форме ДС (сумма ДС на изменение ВОР — новая итоговая, не разница).'
                     ELSE '' END);
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES ((v_old ->> 'id')::uuid, 'field_updated', 'record_type',
            (SELECT jsonb_object_agg(k, v) FROM jsonb_each(v_old) e(k, v) WHERE k = ANY (c_snap)),
            (SELECT jsonb_object_agg(k, v) FROM jsonb_each(v_after) e(k, v) WHERE k = ANY (c_snap)) || jsonb_build_object('fix', c_fix),
            v_desc, c_who);
    RAISE NOTICE 'правка: ID % — % к ID %, № %, изменяемых полей %', p.ds, p.type, p.parent, p.num, cardinality(v_changed);
  END LOOP;

  EXECUTE 'ALTER TABLE public.contracts ENABLE TRIGGER trg_contracts_hierarchy_guard';

  -- 3) Повторный проход через триггер иерархии: он проверяет итог по своим правилам и сам ставит корень дерева.
  UPDATE public.contracts SET parent_contract_id = parent_contract_id WHERE id = ANY (v_ds_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 7 THEN RAISE EXCEPTION 'Проверка триггером: строк % (ждали 7)', n; END IF;

  -- ── После правки ───────────────────────────────────────────────────────────────────────────────────────────
  FOR p IN SELECT * FROM jsonb_to_recordset(c_plan) AS x(ord int, ds bigint, type text, parent bigint,
                                                         root bigint, num text, dup bigint)
           ORDER BY ord LOOP
    SELECT count(*) INTO n
      FROM public.contracts c
      JOIN public.contracts pa ON pa.id = c.parent_contract_id
      JOIN public.contracts ro ON ro.id = c.root_contract_id
     WHERE c.display_id = p.ds AND c.deleted_at IS NULL AND c.record_type = p.type AND btrim(c.contract_number) = p.num
       AND pa.display_id = p.parent AND ro.display_id = p.root
       AND (p.type <> 'ds_vor' OR c.changed_fields = '{}');
    IF n <> 1 THEN RAISE EXCEPTION 'FAIL ID %: тип, изменяемый документ, договор или номер не те', p.ds; END IF;
    IF p.dup IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE display_id = p.dup AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FAIL ID %: дубль не в «Удаленных»', p.dup;
    END IF;
  END LOOP;

  IF (SELECT tgenabled FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.contracts'::regclass AND tgname = 'trg_contracts_hierarchy_guard') <> 'O' THEN
    RAISE EXCEPTION 'FAIL: триггер иерархии не включён';
  END IF;

  SELECT jsonb_object_agg(record_type, cnt) INTO a_types
    FROM (SELECT record_type, count(*) AS cnt FROM public.contracts WHERE deleted_at IS NULL GROUP BY 1) s;
  RAISE NOTICE 'после: живых документов по типам %', a_types;
  IF (a_types ->> 'dp')::int <> (b_types ->> 'dp')::int - 7
     OR coalesce((a_types ->> 'ds_vor')::int, 0) <> coalesce((b_types ->> 'ds_vor')::int, 0) + 3
     OR coalesce((a_types ->> 'ds_extra')::int, 0) <> coalesce((b_types ->> 'ds_extra')::int, 0) + 2 THEN
    RAISE EXCEPTION 'FAIL: число документов по типам — ждали договоров −7, ДС на изменение +3, на доп. работы +2';
  END IF;

  EXECUTE c_amounts INTO a_amounts USING v_roots;
  RAISE NOTICE 'после: актуальные суммы договоров %', a_amounts;
  IF a_amounts IS DISTINCT FROM b_amounts THEN
    RAISE EXCEPTION 'FAIL: актуальные суммы договоров изменились';
  END IF;

  SELECT count(*) INTO m FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix AND changed_at = now();
  IF m <> 9 THEN RAISE EXCEPTION 'FAIL: записей в журнале % (ждали 9)', m; END IF;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
