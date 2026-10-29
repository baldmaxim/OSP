-- Разовая правка данных базы tender.su10.ru (Яндекс): только ЯВНЫЕ дубли и опечатки в видах работ контрагентов
-- (решение пользователя 29.10.2026: «объединить только явные дубликаты»; прочие виды не трогаются).
-- Справочник work_types: 104 → 100 видов (замер чтением 29.10).
--
-- Опечатки (переименование записи):
--   Металические конструкции → Металлоконструкции;   Наружние сети → Наружные сети;
--   Полимочевина гидроизоляиция → Гидроизоляция полимочевиной.
-- Дубли (одно и то же другим написанием или сокращением → один вид):
--   Сендвич панели + Поставка и монтаж сэндвич- панелей  → Сэндвич-панели
--   Комплекс строительных работ + Комплекс СМР           → Комплекс строительных работ (СМР)
--   Охрана + ЧОП                                         → Охрана (ЧОП)
--   Альпинисты + Промышленный альпинизм                  → Альпинисты
-- «Электрические работы» и «ЭОМ» — разные виды (решение пользователя 29.10), не объединяются.
-- В скобках — сокращение, чтобы вид находился и по нему; в описании итогового вида — что объединено
-- (поиск вкладки «Виды работ» ищет и по описанию).
--
-- Что меняется:
--   counterparties.work_type  — виды работ через запятую: прежнее название → итоговое, повторы убираются,
--                               порядок остальных сохраняется; удалённые («Удалённые») контрагенты — тоже;
--   work_types                — 6 записей переименовываются, 4 удаляются, у итоговых дублей — описание;
--                               подразделение (колонка division, миграция 20261115) у переименованных остаётся;
--   counterparty_audit_log    — на каждого изменённого контрагента запись «Виды работ: было → стало»
--                               (видна в «Изменениях» карточки; по ней же работает возврат).
-- Ссылок на work_types в базе нет (названия хранятся только текстом в counterparties.work_type).
-- У контрагентов триггер обновит updated_at (время правки станет временем запуска).
--
-- По умолчанию — ПРОБНЫЙ прогон: всё считается, правится и проверяется, затем ROLLBACK.
-- Применить — с -v apply=1. Любое расхождение в проверке — ошибка, транзакция откатывается.
-- Возврат (виды контрагентов — точно из журнала, справочник — прежние имена и описания) — -v undo=1
-- (тоже пробный без -v apply=1). Контрагентов, которых после объединения правили руками, возврат не трогает.
-- Повторный запуск правки безопасен: справочник уже без прежних видов — проверка «до» остановит.
-- В выводе — только числа и названия видов работ.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261029_work_types_merge.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261029_work_types_merge.sql ) # применить
--   … && psql -X -v undo=1 [-v apply=1] -f migration/data/20261029_work_types_merge.sql ) # возврат
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
-- Таблица объединения — в настройках транзакции (временных таблиц не создаём).
SELECT pg_catalog.set_config('application_name', 'osp:internal', true),
-- Источник → итоговые виды ([] — вид снимается).
       pg_catalog.set_config('osp_fix.map', $json${
 "Комплекс СМР": [
  "Комплекс строительных работ (СМР)"
 ],
 "Комплекс строительных работ": [
  "Комплекс строительных работ (СМР)"
 ],
 "Металические конструкции": [
  "Металлоконструкции"
 ],
 "Наружние сети": [
  "Наружные сети"
 ],
 "Охрана": [
  "Охрана (ЧОП)"
 ],
 "Полимочевина гидроизоляиция": [
  "Гидроизоляция полимочевиной"
 ],
 "Поставка и монтаж сэндвич- панелей": [
  "Сэндвич-панели"
 ],
 "Промышленный альпинизм": [
  "Альпинисты"
 ],
 "Сендвич панели": [
  "Сэндвич-панели"
 ],
 "ЧОП": [
  "Охрана (ЧОП)"
 ]
}$json$, true),
-- Записи, которые переименовываются в итоговый вид (остальные источники удаляются).
       pg_catalog.set_config('osp_fix.rename', $json${
 "Комплекс строительных работ": "Комплекс строительных работ (СМР)",
 "Металические конструкции": "Металлоконструкции",
 "Наружние сети": "Наружные сети",
 "Охрана": "Охрана (ЧОП)",
 "Полимочевина гидроизоляиция": "Гидроизоляция полимочевиной",
 "Сендвич панели": "Сэндвич-панели"
}$json$, true),
-- Описания итоговых видов.
       pg_catalog.set_config('osp_fix.desc', $json${
 "Альпинисты": "Промышленный альпинизм. Объединены 29.10.2026: Альпинисты, Промышленный альпинизм",
 "Комплекс строительных работ (СМР)": "Объединены 29.10.2026: Комплекс строительных работ, Комплекс СМР",
 "Охрана (ЧОП)": "Объединены 29.10.2026: Охрана, ЧОП",
 "Сэндвич-панели": "Поставка и монтаж. Объединены 29.10.2026: Сендвич панели, Поставка и монтаж сэндвич-панелей"
}$json$, true),
-- Описания затронутых видов на 29.10 (пустые не перечислены) — для проверки «до» и возврата.
       pg_catalog.set_config('osp_fix.old_desc', $json${}$json$, true),
-- Снимаемый вид → виды, один из которых обязан быть у каждого его держателя.
       pg_catalog.set_config('osp_fix.cover', $json${}$json$, true) \gset ignored_

\if :undo
DO $$
DECLARE
  m   constant jsonb := current_setting('osp_fix.map')::jsonb;
  rn  constant jsonb := current_setting('osp_fix.rename')::jsonb;
  ds  constant jsonb := current_setting('osp_fix.desc')::jsonb;
  od  constant jsonb := current_setting('osp_fix.old_desc')::jsonb;
  marker      constant text := 'Объединение видов работ 29.10.2026 (скрипт)';
  undo_marker constant text := 'Возврат объединения видов работ 29.10.2026 (скрипт)';
  ws  constant text := E' \t\r\n' || chr(160);
  k text; t text; n int; n_skip int; n_unknown int;
BEGIN
  -- Справочник: переименованные — обратно, удалённые — заново, описания — прежние.
  FOR k, t IN SELECT key, value FROM jsonb_each_text(rn) LOOP
    IF EXISTS (SELECT 1 FROM public.work_types WHERE name = t) THEN
      IF EXISTS (SELECT 1 FROM public.work_types WHERE name = k) THEN
        RAISE EXCEPTION 'FAIL: есть и «%», и «%» — вернуть имя нельзя', t, k;
      END IF;
      UPDATE public.work_types SET name = k, description = od->>k, updated_at = now() WHERE name = t;
    END IF;
  END LOOP;
  INSERT INTO public.work_types (name, description)
  SELECT e.key, od->>e.key FROM jsonb_each(m) e
  WHERE NOT rn ? e.key AND NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = e.key);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'справочник: восстановлено записей %', n;
  -- Подразделение (миграция 20261115, если применена): у восстановленного дубля — как у вида, в который он входил
  -- (у дубля и итогового вида оно одно — так распределила миграция). Итоговый вид из переименования к этому
  -- моменту уже снова под прежним именем.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'work_types' AND column_name = 'division') THEN
    EXECUTE $q$
      UPDATE public.work_types s SET division = t.division
      FROM jsonb_each($1) e
      JOIN public.work_types t ON t.name = coalesce(
        (SELECT r.key FROM jsonb_each_text($2) r WHERE r.value = e.value->>0 LIMIT 1), e.value->>0)
      WHERE s.name = e.key AND NOT $2 ? e.key AND s.division IS NULL
    $q$ USING m, rn;
  END IF;
  -- Описания видов, которые были и до объединения, — прежние, если их с тех пор не меняли.
  UPDATE public.work_types w SET description = od->>w.name, updated_at = now()
  WHERE ds ? w.name AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(rn) r WHERE r.value = w.name)
    AND w.description IS NOT DISTINCT FROM ds->>w.name;

  -- Контрагенты: последнее значение из журнала объединения, если с тех пор не меняли.
  SELECT count(*) INTO n_skip FROM (
    SELECT DISTINCT ON (a.counterparty_id) a.counterparty_id AS id, a.new_value #>> '{}' AS new_v
    FROM public.counterparty_audit_log a
    WHERE a.changed_by_name = marker AND a.field_name = 'work_type'
    ORDER BY a.counterparty_id, a.changed_at DESC) e
  JOIN public.counterparties c ON c.id = e.id
  WHERE c.work_type IS DISTINCT FROM e.new_v;
  WITH e AS (
    SELECT DISTINCT ON (a.counterparty_id) a.counterparty_id AS id,
           a.old_value #>> '{}' AS old_v, a.new_value #>> '{}' AS new_v
    FROM public.counterparty_audit_log a
    WHERE a.changed_by_name = marker AND a.field_name = 'work_type'
    ORDER BY a.counterparty_id, a.changed_at DESC
  ), upd AS (
    UPDATE public.counterparties c SET work_type = e.old_v
    FROM e WHERE c.id = e.id AND c.work_type IS NOT DISTINCT FROM e.new_v
    RETURNING c.id, e.old_v, e.new_v
  )
  INSERT INTO public.counterparty_audit_log
    (counterparty_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
  SELECT id, 'field_updated', 'work_type', to_jsonb(new_v), to_jsonb(old_v),
         'Виды работ: ' || new_v || ' → ' || old_v || ' (возврат объединения видов работ)', NULL, undo_marker
  FROM upd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'контрагенты: возвращено %, не тронуто (правили после объединения или уже возвращены) %', n, n_skip;

  -- После: все прежние виды на месте; названия у контрагентов, которых нет в справочнике.
  SELECT count(*) INTO n FROM jsonb_object_keys(m) k2 WHERE NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = k2);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: в справочнике не хватает % прежних видов', n; END IF;
  SELECT count(DISTINCT s) INTO n_unknown FROM (
    SELECT btrim(x, ws) AS s FROM public.counterparties c,
           regexp_split_to_table(coalesce(c.work_type, ''), ',') x) q
  WHERE s <> '' AND NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = q.s);
  RAISE NOTICE 'после: видов в справочнике %, названий у контрагентов вне справочника %',
    (SELECT count(*) FROM public.work_types), n_unknown;
  RAISE NOTICE 'OK: возврат выполнен';
END $$;
\else
DO $$
DECLARE
  m   constant jsonb := current_setting('osp_fix.map')::jsonb;
  rn  constant jsonb := current_setting('osp_fix.rename')::jsonb;
  ds  constant jsonb := current_setting('osp_fix.desc')::jsonb;
  od  constant jsonb := current_setting('osp_fix.old_desc')::jsonb;
  cv  constant jsonb := current_setting('osp_fix.cover')::jsonb;
  marker constant text := 'Объединение видов работ 29.10.2026 (скрипт)';
  ws  constant text := E' \t\r\n' || chr(160);
  targets text[];
  k text; t text; n int; n2 int;
  b_total int; b_hash text; b_wt int; b_unknown int; n_change int; n_del int;
  b_before jsonb;  -- id → прежнее значение (меняемые контрагенты)
  b_expect jsonb;  -- id → ожидаемое новое значение
BEGIN
  SELECT array_agg(DISTINCT v ORDER BY v) INTO targets FROM jsonb_each(m) e, jsonb_array_elements_text(e.value) v;

  -- ── До правки: справочник такой, каким его разбирали 29.10 ──────────────────────────────────────
  SELECT count(*) INTO n FROM jsonb_object_keys(m) k2 WHERE NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = k2);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: в справочнике нет % прежних видов (объединение уже применено или справочник изменился после 29.10): %', n,
      (SELECT string_agg(k2, '; ') FROM jsonb_object_keys(m) k2 WHERE NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = k2));
  END IF;
  FOREACH t IN ARRAY targets LOOP
    IF m ? t THEN RAISE EXCEPTION 'FAIL: итоговый вид «%» сам среди прежних', t; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(rn) r WHERE r.value = t) = EXISTS (SELECT 1 FROM public.work_types WHERE name = t) THEN
      RAISE EXCEPTION 'FAIL: итоговый вид «%»: должен либо уже быть в справочнике, либо получиться переименованием', t;
    END IF;
  END LOOP;
  FOR k, t IN SELECT key, value FROM jsonb_each_text(rn) LOOP
    IF m->k IS DISTINCT FROM jsonb_build_array(t) THEN RAISE EXCEPTION 'FAIL: переименование «%» не совпадает с объединением', k; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM public.work_types w
  WHERE (m ? w.name OR w.name = ANY (targets)) AND coalesce(w.description, '') <> coalesce(od->>w.name, '');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: у % затронутых видов описание изменилось после 29.10 — возврат был бы неточным', n; END IF;
  FOR k IN SELECT jsonb_object_keys(cv) LOOP
    SELECT count(*) INTO n FROM public.counterparties c
    WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(c.work_type, ''), ',') x WHERE btrim(x, ws) = k)
      AND NOT EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(c.work_type, ''), ',') y
                      WHERE btrim(y, ws) IN (SELECT jsonb_array_elements_text(cv->k)));
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL: у % держателей «%» нет вида, который его заменяет', n, k; END IF;
  END LOOP;

  -- Снимки: все колонки контрагентов, кроме вида работ и времени правки; справочник; названия вне справочника.
  SELECT count(*), md5(string_agg((to_jsonb(c) - 'work_type' - 'updated_at')::text, '|' ORDER BY c.id))
    INTO b_total, b_hash FROM public.counterparties c;
  SELECT count(*) INTO b_wt FROM public.work_types;
  SELECT count(DISTINCT s) INTO b_unknown FROM (
    SELECT btrim(x, ws) AS s FROM public.counterparties c, regexp_split_to_table(coalesce(c.work_type, ''), ',') x) q
  WHERE s <> '' AND NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = q.s);

  -- Ожидаемые значения: каждое название → итоговые, первое вхождение сохраняет место, повторы убираются.
  WITH tok AS (
    SELECT c.id, r.o, btrim(r.x, ws) AS s
    FROM public.counterparties c
    CROSS JOIN LATERAL regexp_split_to_table(coalesce(c.work_type, ''), ',') WITH ORDINALITY AS r(x, o)
  ), hit AS (
    SELECT DISTINCT id FROM tok WHERE m ? s
  ), mapped AS (
    SELECT t.id, t.o, x.i, x.name
    FROM tok t JOIN hit USING (id)
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN m ? t.s THEN m->t.s ELSE jsonb_build_array(t.s) END)
      WITH ORDINALITY AS x(name, i)
    WHERE t.s <> ''
  ), firsts AS (
    SELECT DISTINCT ON (id, name) id, name, o, i FROM mapped ORDER BY id, name, o, i
  ), nv AS (
    SELECT id, string_agg(name, ', ' ORDER BY o, i) AS v FROM firsts GROUP BY id
  )
  SELECT coalesce(jsonb_object_agg(h.id::text, c.work_type), '{}'), coalesce(jsonb_object_agg(h.id::text, nv.v), '{}')
    INTO b_before, b_expect
  FROM hit h JOIN public.counterparties c ON c.id = h.id LEFT JOIN nv ON nv.id = h.id;
  SELECT count(*) INTO n_change FROM jsonb_object_keys(b_expect);
  SELECT count(*) INTO n FROM jsonb_each(b_expect) WHERE value = 'null'::jsonb;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: у % контрагентов не осталось бы ни одного вида работ', n; END IF;
  RAISE NOTICE 'до: контрагентов %, меняется %; видов в справочнике %; названий у контрагентов вне справочника %',
    b_total, n_change, b_wt, b_unknown;

  -- ── Правка ───────────────────────────────────────────────────────────────────────────────────────
  UPDATE public.counterparties c SET work_type = b_expect->>c.id::text WHERE b_expect ? c.id::text;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> n_change THEN RAISE EXCEPTION 'FAIL: изменено контрагентов %, ждали %', n, n_change; END IF;

  INSERT INTO public.counterparty_audit_log
    (counterparty_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
  SELECT b.key::uuid, 'field_updated', 'work_type', to_jsonb(b.value), b_expect->b.key,
         'Виды работ: ' || b.value || ' → ' || (b_expect->>b.key) || ' (объединение видов работ)', NULL, marker
  FROM jsonb_each_text(b_before) b;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> n_change THEN RAISE EXCEPTION 'FAIL: записей в журнал %, ждали %', n, n_change; END IF;

  FOR k, t IN SELECT key, value FROM jsonb_each_text(rn) LOOP
    UPDATE public.work_types SET name = t, updated_at = now() WHERE name = k;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'FAIL: переименование «%» → «%»: строк %', k, t, n; END IF;
  END LOOP;
  DELETE FROM public.work_types w WHERE m ? w.name;
  GET DIAGNOSTICS n_del = ROW_COUNT;
  SELECT count(*) INTO n FROM jsonb_object_keys(m);
  IF n_del <> n - (SELECT count(*) FROM jsonb_object_keys(rn)) THEN
    RAISE EXCEPTION 'FAIL: удалено записей справочника %, ждали %', n_del, n - (SELECT count(*) FROM jsonb_object_keys(rn));
  END IF;
  UPDATE public.work_types w SET description = ds->>w.name, updated_at = now() WHERE ds ? w.name;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> (SELECT count(*) FROM jsonb_object_keys(ds)) THEN RAISE EXCEPTION 'FAIL: описаний записано %', n; END IF;

  -- ── После правки ─────────────────────────────────────────────────────────────────────────────────
  -- 1. Справочник: прежних видов нет, итоговые все есть, записей ровно на число удалённых меньше.
  SELECT count(*) INTO n FROM public.work_types w WHERE m ? w.name;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: в справочнике осталось прежних видов: %', n; END IF;
  SELECT count(*) INTO n FROM unnest(targets) t2 WHERE NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = t2);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: нет итоговых видов: %', n; END IF;
  SELECT count(*) INTO n FROM public.work_types;
  IF n <> b_wt - n_del THEN RAISE EXCEPTION 'FAIL: видов в справочнике %, ждали %', n, b_wt - n_del; END IF;
  -- 2. Каждый изменённый контрагент — ровно ожидаемое значение; прежних названий ни у кого не осталось.
  SELECT count(*) INTO n FROM public.counterparties c
  WHERE b_expect ? c.id::text AND c.work_type IS DISTINCT FROM b_expect->>c.id::text;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: у % контрагентов не то значение', n; END IF;
  SELECT count(*) INTO n FROM public.counterparties c, regexp_split_to_table(coalesce(c.work_type, ''), ',') x
  WHERE m ? btrim(x, ws);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: у контрагентов осталось прежних названий: %', n; END IF;
  -- 3. Ничего не потеряно: каждое прежнее название каждого контрагента представлено в новом значении —
  --    им самим, всеми его итоговыми видами, а снимаемое — видом, который его заменяет.
  SELECT count(*) INTO n
  FROM jsonb_each_text(b_before) b
  CROSS JOIN LATERAL (SELECT DISTINCT btrim(x, ws) AS s FROM regexp_split_to_table(b.value, ',') x) o
  WHERE o.s <> '' AND NOT (
    CASE
      WHEN NOT m ? o.s THEN o.s IN (SELECT btrim(y, ws) FROM regexp_split_to_table(b_expect->>b.key, ',') y)
      WHEN jsonb_array_length(m->o.s) > 0 THEN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(m->o.s) tt
        WHERE tt NOT IN (SELECT btrim(y, ws) FROM regexp_split_to_table(b_expect->>b.key, ',') y))
      ELSE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(cv->o.s) cc
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN m ? cc THEN m->cc ELSE jsonb_build_array(cc) END) ct
        WHERE ct IN (SELECT btrim(y, ws) FROM regexp_split_to_table(b_expect->>b.key, ',') y))
    END);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: потеряно видов работ у контрагентов: %', n; END IF;
  -- 4. Новых названий вне справочника не появилось; прочие колонки контрагентов не тронуты; журнал записан.
  SELECT count(DISTINCT s) INTO n FROM (
    SELECT btrim(x, ws) AS s FROM public.counterparties c, regexp_split_to_table(coalesce(c.work_type, ''), ',') x) q
  WHERE s <> '' AND NOT EXISTS (SELECT 1 FROM public.work_types w WHERE w.name = q.s);
  IF n <> b_unknown THEN RAISE EXCEPTION 'FAIL: названий вне справочника %, было %', n, b_unknown; END IF;
  SELECT count(*), md5(string_agg((to_jsonb(c) - 'work_type' - 'updated_at')::text, '|' ORDER BY c.id))
    INTO n, t FROM public.counterparties c;
  IF n <> b_total OR t <> b_hash THEN RAISE EXCEPTION 'FAIL: изменились другие колонки или число контрагентов'; END IF;
  SELECT count(*) INTO n FROM public.counterparty_audit_log WHERE changed_by_name = marker AND changed_at = now();
  IF n <> n_change THEN RAISE EXCEPTION 'FAIL: записей журнала %, ждали %', n, n_change; END IF;

  -- Итог по видам: сколько контрагентов (с удалёнными) у каждого итогового вида.
  FOREACH t IN ARRAY targets LOOP
    SELECT count(*) INTO n FROM public.counterparties c
    WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(c.work_type, ''), ',') x WHERE btrim(x, ws) = t);
    SELECT count(*) INTO n2 FROM public.counterparties c
    WHERE c.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(c.work_type, ''), ',') x WHERE btrim(x, ws) = t);
    RAISE NOTICE '  % — контрагентов % (не удалённых %)', t, n, n2;
  END LOOP;
  RAISE NOTICE 'после: видов в справочнике % (было %), изменено контрагентов %, записей в журнал %',
    b_wt - n_del, b_wt, n_change, n_change;
  RAISE NOTICE 'OK: проверка «после» сошлась';
END $$;
\endif

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
