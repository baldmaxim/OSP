-- Схлопывание дублей сотрудников (contacts).
--
-- ПРИЧИНА. TendersPage.fetchResponsibleContacts при каждом открытии страницы
-- дописывала в contacts всех подтверждённых пользователей из user_roles, которых
-- «не нашла» по ФИО. Сверка шла по сырой строке, поэтому лишний/неразрывный
-- пробел или иной регистр давали новую запись — так и копились дубли, а в поле
-- «Должность» попадал служебный слаг роли ('otiz', 'udorojanie').
-- Код авто-вставки удалён; эта миграция чистит уже накопившееся.
--
-- БЕЗОПАСНОСТЬ. Строки НЕ удаляются вслепую. Сотрудник может быть назначен
-- ответственным (тендеры, договоры, заявки на ДС и пр.), поэтому сначала все
-- внешние ссылки переводятся на «выжившую» запись, и только потом дубль
-- удаляется. Ни одно назначение не теряется и не обнуляется.
--
-- ЧТО СЧИТАЕМ ДУБЛЕМ: совпадение нормализованного ФИО И объекта. Один и тот же
-- человек на двух разных объектах (частый случай: руководитель строительства)
-- дублем НЕ считается — такие строки остаются как есть.

-- Нормализованный ключ ФИО: неразрывные пробелы и табы → обычный пробел,
-- повторы схлопываем, края обрезаем, регистр приводим к нижнему.
CREATE OR REPLACE FUNCTION contacts_name_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(btrim(regexp_replace(
    translate(coalesce(p_name, ''), chr(160) || chr(9) || chr(10) || chr(13), '    '),
    '\s+', ' ', 'g')))
$fn$;

DO $$
DECLARE
  r record;
  v_dups integer;
BEGIN
  -- 1. Определяем, кто «выживает»: самая ранняя запись в группе (ФИО + объект).
  --    Ранняя — потому что на неё вероятнее всего уже ссылаются назначения.
  CREATE TEMP TABLE contacts_dedup_map AS
  WITH ranked AS (
    SELECT
      id,
      row_number() OVER w  AS rn,
      first_value(id) OVER w AS keeper_id
    FROM contacts
    WINDOW w AS (
      PARTITION BY contacts_name_key(full_name),
                   coalesce(object_id, '00000000-0000-0000-0000-000000000000'::uuid)
      ORDER BY created_at NULLS LAST, id
    )
  )
  SELECT id AS dup_id, keeper_id FROM ranked WHERE rn > 1;

  SELECT count(*) INTO v_dups FROM contacts_dedup_map;

  IF v_dups = 0 THEN
    RAISE NOTICE 'Дублей сотрудников не найдено — менять нечего.';
    DROP TABLE contacts_dedup_map;
    RETURN;
  END IF;

  -- 2. Достраиваем «выжившего»: пустые поля заполняем непустыми из дублей,
  --    чтобы при схлопывании не потерять телефон/почту, введённые в дубле.
  UPDATE contacts k
  SET phone         = coalesce(nullif(btrim(k.phone), ''), d.phone),
      email         = coalesce(nullif(btrim(k.email), ''), d.email),
      notes         = coalesce(nullif(btrim(k.notes), ''), d.notes),
      department_id = coalesce(k.department_id, d.department_id)
  FROM (
    SELECT m.keeper_id,
           min(nullif(btrim(c.phone), '')) AS phone,
           min(nullif(btrim(c.email), '')) AS email,
           min(nullif(btrim(c.notes), '')) AS notes,
           min(c.department_id::text)::uuid AS department_id
    FROM contacts_dedup_map m
    JOIN contacts c ON c.id = m.dup_id
    GROUP BY m.keeper_id
  ) d
  WHERE k.id = d.keeper_id;

  -- 3. Переводим ВСЕ внешние ссылки с дублей на «выживших».
  --    Список ссылающихся таблиц и колонок берём из системного каталога, а не
  --    перечисляем руками: так ничего не забудется, включая FK, добавленные позже.
  FOR r IN
    SELECT con.conrelid::regclass AS tbl, att.attname AS col
    FROM pg_constraint con
    JOIN unnest(con.conkey) AS k(attnum) ON true
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.contacts'::regclass
  LOOP
    EXECUTE format(
      'UPDATE %s t SET %I = m.keeper_id FROM contacts_dedup_map m WHERE t.%I = m.dup_id',
      r.tbl, r.col, r.col
    );
    RAISE NOTICE 'Ссылки переведены: %.%', r.tbl, r.col;
  END LOOP;

  -- 4. Теперь дубли ни с чем не связаны — удаляем.
  DELETE FROM contacts c USING contacts_dedup_map m WHERE c.id = m.dup_id;

  RAISE NOTICE 'Схлопнуто дублей сотрудников: %', v_dups;
  DROP TABLE contacts_dedup_map;
END $$;

DROP FUNCTION IF EXISTS contacts_name_key(text);
