-- Разовая правка данных базы tender.su10.ru (Яндекс), «Заявки на проверку ДП/ДС». Решения пользователя 05.11.2026:
-- метку YouGile удалить со всех карточек; исполнители — только действующие юристы ОСП.
--
-- 1. Метка YouGile (без учёта регистра) убирается из doc_check_requests.labels у всех заявок, и удалённых, и в архиве. Другие
--    метки остаются. Замер чтением 05.11: метка у 847 заявок из 849.
-- 2. Вписанные текстом исполнители (manual_assignees, с прежней доски), которые оказались действующими юристами ОСП,
--    переносятся в настоящие исполнители (assignee_ids). Страница показывает только assignee_ids: без этого шага юристы
--    пропали бы со своих карточек. Совпадение: почта, ФИО целиком или ФИО учётки — начало вписанного имени (учётка «Фамилия
--    Имя», в карточке «Фамилия Имя Отчество»). Подошли двое — имя не трогаем. Замер чтением 05.11: 449 вхождений, двое юристов.
--
-- Не меняется: остальные имена в manual_assignees и другие сотрудники в assignee_ids: страница их не показывает, но они
-- остаются в базе. Журнал заявок (история), created_by_name, примечания. Триггер обновит updated_at изменённых заявок: на
-- экране этой отметки нет. ФИО в файле нет: репозиторий открытый.
--
-- Обратно: метка не возвращается (это и есть решение), перенос обратно не нужен: на экране человек остаётся тем же.
-- Запись в журнал заявок не идёт: иначе в истории каждой карточки появилось бы слово «YouGile».
--
-- По умолчанию — ПРОБНЫЙ прогон: всё считается, правится и проверяется, затем ROLLBACK. Применить — с -v apply=1.
-- Любое расхождение в проверке «после» — ошибка, транзакция откатывается. В выводе только числа. Повтор безопасен.
--
-- Запуск из корня репозитория, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -f migration/data/20261228_doc_check_labels_assignees.sql )            # пробный
--   … && psql -X -v apply=1 -f migration/data/20261228_doc_check_labels_assignees.sql ) # применить
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

-- Вписанное имя → учётка действующего юриста ОСП: только если подошла ровно одна.
CREATE TEMP TABLE dc_lawyer_names ON COMMIT DROP AS
WITH norm_lawyers AS (
  SELECT ur.user_id,
         lower(btrim(ur.email)) AS email,
         replace(lower(regexp_replace(btrim(ur.full_name), '\s+', ' ', 'g')), 'ё', 'е') AS fio
  FROM public.user_roles ur
  WHERE ur.role = 'lawyer' AND ur.is_approved AND NOT ur.is_blocked AND ur.counterparty_id IS NULL
),
names AS (
  SELECT DISTINCT n.name,
         replace(lower(regexp_replace(btrim(n.name), '\s+', ' ', 'g')), 'ё', 'е') AS norm
  FROM public.doc_check_requests r, unnest(r.manual_assignees) AS n(name)
)
SELECT n.name, min(l.user_id::text)::uuid AS user_id
FROM names n
JOIN norm_lawyers l
  ON n.norm = l.email
  OR n.norm = l.fio
  -- ФИО учётки из одного слова (только фамилия) — не основание: однофамильцы.
  OR (l.fio LIKE '% %' AND starts_with(n.norm, l.fio || ' '))
GROUP BY n.name
HAVING count(DISTINCT l.user_id) = 1;

DO $$
DECLARE
  b_rows int; b_label int; b_labels int; b_manual int; b_moved int; b_ids int; b_others int; b_has_lawyer int;
  n_rows int; n_label int; n_labels int; n_manual int; n_moved int; n_ids int; n_others int; n_has_lawyer int;
  v_fixed int;
  v_people int;
BEGIN
  -- До правки.
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(labels) l WHERE lower(btrim(l)) = 'yougile')),
         coalesce(sum((SELECT count(*) FROM unnest(labels) l WHERE lower(btrim(l)) <> 'yougile')), 0),
         coalesce(sum(cardinality(manual_assignees)), 0),
         coalesce(sum((SELECT count(*) FROM unnest(manual_assignees) m WHERE m IN (SELECT name FROM dc_lawyer_names))), 0),
         coalesce(sum(cardinality(assignee_ids)), 0),
         count(*) FILTER (WHERE assignee_ids && ARRAY(SELECT user_id FROM dc_lawyer_names)
                             OR manual_assignees && ARRAY(SELECT name FROM dc_lawyer_names))
    INTO b_rows, b_label, b_labels, b_manual, b_moved, b_ids, b_has_lawyer
    FROM public.doc_check_requests;
  -- Исполнители-учётки, которых перенос не касается: их число не должно измениться.
  SELECT coalesce(sum((SELECT count(*) FROM unnest(assignee_ids) a WHERE a NOT IN (SELECT user_id FROM dc_lawyer_names))), 0)
    INTO b_others FROM public.doc_check_requests;
  SELECT count(DISTINCT user_id) INTO v_people FROM dc_lawyer_names;
  RAISE NOTICE 'до: заявок %, с меткой YouGile %, других меток %', b_rows, b_label, b_labels;
  RAISE NOTICE 'до: вписанных имён %, из них действующие юристы % (юристов: %), исполнителей-учёток %', b_manual, b_moved, v_people, b_ids;

  -- Метка.
  UPDATE public.doc_check_requests r
     SET labels = ARRAY(SELECT u.l FROM unnest(r.labels) WITH ORDINALITY AS u(l, ord)
                        WHERE lower(btrim(u.l)) <> 'yougile' ORDER BY u.ord)
   WHERE EXISTS (SELECT 1 FROM unnest(r.labels) l WHERE lower(btrim(l)) = 'yougile');
  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RAISE NOTICE 'правка: метка снята у % заявок', v_fixed;
  IF v_fixed <> b_label THEN
    RAISE EXCEPTION 'метка снята у %, а была у %', v_fixed, b_label;
  END IF;

  -- Вписанные юристы — в настоящие исполнители: новые — за прежними, в порядке вписанных, без повторов.
  UPDATE public.doc_check_requests r
     SET assignee_ids = r.assignee_ids || ARRAY(
           SELECT m.user_id FROM (
             SELECT DISTINCT ON (d.user_id) d.user_id, u.ord
             FROM unnest(r.manual_assignees) WITH ORDINALITY AS u(name, ord)
             JOIN dc_lawyer_names d ON d.name = u.name
             WHERE NOT d.user_id = ANY (r.assignee_ids)
             ORDER BY d.user_id, u.ord
           ) m ORDER BY m.ord),
         manual_assignees = ARRAY(
           SELECT u.name FROM unnest(r.manual_assignees) WITH ORDINALITY AS u(name, ord)
           WHERE u.name NOT IN (SELECT name FROM dc_lawyer_names) ORDER BY u.ord)
   WHERE r.manual_assignees && ARRAY(SELECT name FROM dc_lawyer_names);
  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RAISE NOTICE 'правка: исполнители перенесены у % заявок', v_fixed;

  -- После правки.
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(labels) l WHERE lower(btrim(l)) = 'yougile')),
         coalesce(sum(cardinality(labels)), 0),
         coalesce(sum(cardinality(manual_assignees)), 0),
         coalesce(sum((SELECT count(*) FROM unnest(manual_assignees) m WHERE m IN (SELECT name FROM dc_lawyer_names))), 0),
         coalesce(sum(cardinality(assignee_ids)), 0),
         count(*) FILTER (WHERE assignee_ids && ARRAY(SELECT user_id FROM dc_lawyer_names))
    INTO n_rows, n_label, n_labels, n_manual, n_moved, n_ids, n_has_lawyer
    FROM public.doc_check_requests;
  SELECT coalesce(sum((SELECT count(*) FROM unnest(assignee_ids) a WHERE a NOT IN (SELECT user_id FROM dc_lawyer_names))), 0)
    INTO n_others FROM public.doc_check_requests;
  RAISE NOTICE 'после: заявок %, с меткой YouGile %, других меток %', n_rows, n_label, n_labels;
  RAISE NOTICE 'после: вписанных имён %, из них действующие юристы %, исполнителей-учёток %', n_manual, n_moved, n_ids;

  IF n_rows <> b_rows THEN RAISE EXCEPTION 'FAIL заявок стало %, было %', n_rows, b_rows; END IF;
  IF n_label <> 0 THEN RAISE EXCEPTION 'FAIL метка YouGile осталась у % заявок', n_label; END IF;
  IF n_labels <> b_labels THEN RAISE EXCEPTION 'FAIL других меток стало %, было %', n_labels, b_labels; END IF;
  IF n_moved <> 0 THEN RAISE EXCEPTION 'FAIL вписанных юристов осталось %', n_moved; END IF;
  IF n_manual <> b_manual - b_moved THEN RAISE EXCEPTION 'FAIL вписанных имён %, ждали %', n_manual, b_manual - b_moved; END IF;
  -- Заявка могла быть и с учёткой, и с именем того же юриста: исполнителей прибавилось не больше, чем перенесено.
  IF n_ids < b_ids OR n_ids > b_ids + b_moved THEN
    RAISE EXCEPTION 'FAIL исполнителей-учёток %, ждали от % до %', n_ids, b_ids, b_ids + b_moved;
  END IF;
  IF n_others <> b_others THEN RAISE EXCEPTION 'FAIL других сотрудников в исполнителях стало %, было %', n_others, b_others; END IF;
  -- Ни одна заявка не потеряла юриста: где он был учёткой или именем, теперь он учётка.
  IF n_has_lawyer <> b_has_lawyer THEN
    RAISE EXCEPTION 'FAIL заявок с этими юристами стало %, было %', n_has_lawyer, b_has_lawyer;
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
