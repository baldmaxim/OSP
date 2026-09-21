-- ═══════════════════════════════════════════════════════════════════════════
-- Заполнение пустых ИНН у контрагентов (public.counterparties.inn).
-- Supabase → SQL Editor. Выполнять ПО ШАГАМ, выделяя нужный блок.
--
-- Правила: обновляется только пустой ИНН (NULL, '' или пробелы); карточка
-- ищется по точному названию (без внешних пробелов), регистр и кавычки —
-- запасной проход; при нескольких подходящих карточках запись пропускается;
-- чужой ИНН не перезаписывается; ИНН пишется строкой (0276088789 сохраняется);
-- карточки не создаются, не удаляются и не объединяются; другие поля не
-- меняются. Повторный запуск ничего не портит.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── ШАГ 1. План. Ничего не меняет — посмотрите, что получится ──────────────
WITH input(idx, name, inn, contact_name, phone, email, work_type) AS (
  VALUES
    (1::int, 'ООО "СТРОЙИНВЕСТ"'::text, '7716986926'::text, NULL::text, NULL::text, NULL::text, NULL::text),
    (2, 'АО "ТопРендж"', '7704025036', NULL, NULL, NULL, NULL),
    (3, 'Астро-лифт', '0276088789', NULL, NULL, NULL, NULL),
    (4, 'БК Глобус', '5001148873', NULL, NULL, NULL, NULL),
    (5, 'ДСК Профстрой', '7720378790', NULL, NULL, NULL, NULL),
    (6, 'Империя', '9701146276', NULL, NULL, NULL, NULL),
    (7, 'Интеллект Обслуживание', '7722465946', NULL, NULL, NULL, NULL),
    (8, 'ИП "Гаджиев"', '370606654100', NULL, NULL, NULL, NULL),
    (9, 'ИП "Лихолитов"', '771311712158', NULL, NULL, NULL, NULL),
    (10, 'ИП "Порунов"', '524310784550', NULL, NULL, NULL, NULL),
    (11, 'ИП "Соловьева"', '645109889300', NULL, NULL, NULL, NULL),
    (12, 'ИП "Хэлл"', '270414747284', NULL, NULL, NULL, NULL),
    (13, 'ИП Ганичев', '292501781094', NULL, NULL, NULL, NULL),
    (14, 'Корона Лифт', '7725275319', NULL, NULL, NULL, NULL),
    (15, 'МеталлАлмазСтрой', '7720965005', NULL, NULL, NULL, NULL),
    (16, 'ООО "АДМ СТРОЙ"', '9723012117', NULL, NULL, NULL, NULL),
    (17, 'ООО "Адм-Строй"', '9723012117', NULL, NULL, NULL, NULL),
    (18, 'ООО "Азимут ВСК"', '5005065184', NULL, NULL, NULL, NULL),
    (19, 'ООО "Алюспейс"', '5047145219', NULL, NULL, NULL, NULL),
    (20, 'ООО "Атриум"', '7725496212', NULL, NULL, NULL, NULL),
    (21, 'ООО "ВЕКТОР-СТРОЙ 26"', '5047326617', NULL, NULL, NULL, NULL),
    (22, 'ООО “ВОКСЭМ”', '9726043106', NULL, NULL, NULL, NULL),
    (23, 'ООО "Гранд Строй Мир"', '7725476304', NULL, NULL, NULL, NULL),
    (24, 'ООО "Интегрированное Комплексное Строительство"', '9724214130', NULL, NULL, NULL, NULL),
    (25, 'ООО "ИНТЕЛ МУЗ"', '9710154629', NULL, NULL, NULL, NULL),
    (26, 'ООО "Инфотрейд"', '7730176190', NULL, NULL, NULL, NULL),
    (27, 'ООО "КД Дельта"', '9705046530', NULL, NULL, NULL, NULL),
    (28, 'ООО "Кросс-ГРУПП"', '9701157694', NULL, NULL, NULL, NULL),
    (29, 'ООО "ЛЭНДМЭН"', '9701309114', NULL, NULL, NULL, NULL),
    (30, 'ООО "Омен Групп"', '9721174031', NULL, NULL, NULL, NULL),
    (31, 'ООО "РСК (РСД)"', '5047197930', NULL, NULL, NULL, NULL),
    (32, 'ООО "Техстронг" (ТС Инжиниринг)', '7716890075', NULL, NULL, NULL, NULL),
    (33, 'ООО "ТОНОЗ"', '9729384746', NULL, NULL, NULL, NULL),
    (34, 'ООО "Фасадные системы"', '7703443104', NULL, NULL, NULL, NULL),
    (35, 'ООО "ЭСКО"', '3123301684', NULL, NULL, NULL, NULL),
    (36, 'ООО «АТС ГРУПП»', '9701097212', 'Агафонов Дмитрий Анатольевич', '+7(495)649-09-63', 'office@atsgroup.pro', 'ВИС'),
    (37, 'ООО «ПартнерЦентр»', '7713743869', NULL, NULL, NULL, NULL),
    (38, 'ООО «Спецпорт „Надежда“», Москва', '7726448317', NULL, NULL, NULL, NULL),
    (39, 'ООО «ТехСтройГарант»', '9704140307', NULL, NULL, NULL, NULL),
    (40, 'ООО ГК РВ Инжиниринг', '7708801138', 'Андреев Алексей Владимирович', '+7(903)759-04-15', 'olec91@list.ru', 'Водомерный узел, Кондиционирование, ВИС'),
    (41, 'ООО ЛТМ', '6678002550', NULL, NULL, NULL, NULL),
    (42, 'ООО ТетраГрупп', '7727362341', NULL, NULL, NULL, NULL),
    (43, 'ООО Фаст-Групп', '9727113518', NULL, NULL, NULL, NULL),
    (44, 'ПАО "МГТС"', '7710016640', NULL, NULL, NULL, NULL),
    (45, 'Промальянс', '5048026687', NULL, NULL, NULL, NULL),
    (46, 'ПромАтомСтрой', '9717186066', NULL, NULL, NULL, NULL),
    (47, 'Профистрой', '9701191600', NULL, NULL, NULL, NULL),
    (48, 'ПЭМ-ЭНЕРГО', '7743190837', NULL, NULL, NULL, NULL),
    (49, 'СК Стройсервис', '9728074050', NULL, NULL, NULL, NULL),
    (50, 'Спектрарстрой', '9715000245', NULL, NULL, NULL, NULL),
    (51, 'ТехСтройГарант', '9704140307', NULL, NULL, NULL, NULL),
    (52, 'ФСК Инжиниринг', '7725494913', NULL, NULL, NULL, NULL),
    (53, 'ЭМДМ-строй', '7720961314', NULL, NULL, NULL, NULL),
    (54, 'QWENT / ООО «ИНЖСИСТЕМС»', '9724214532', NULL, NULL, NULL, NULL)
),
inp AS (
  SELECT i.*, btrim(i.name) AS ex, lower(regexp_replace(translate(btrim(translate(i.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm FROM input i
),
card AS (
  SELECT c.id, c.name, c.inn, c.work_type, btrim(c.name) AS ex, lower(regexp_replace(translate(btrim(translate(c.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm
  FROM public.counterparties c
  WHERE c.deleted_at IS NULL
),
cand AS (
  SELECT inp.idx, inp.name AS in_name, inp.inn AS in_inn,
         inp.contact_name, inp.phone, inp.email, inp.work_type AS in_work_type,
         card.id, card.name AS card_name, card.inn AS card_inn, card.work_type AS card_work_type,
         (card.ex = inp.ex) AS is_exact
  FROM inp JOIN card ON card.ex = inp.ex OR card.nm = inp.nm
),
scored AS (
  SELECT cand.*,
      (CASE WHEN cand.contact_name IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.full_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.contact_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.phone IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id
            AND regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') = regexp_replace(cand.phone, '\D', '', 'g')) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.email IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.in_work_type IS NOT NULL AND lower(regexp_replace(translate(btrim(translate(cand.card_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.in_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) THEN 1 ELSE 0 END) AS hits
  FROM cand
),
pool AS (
  -- точное совпадение названия важнее; регистр и кавычки — запасной проход
  SELECT s.* FROM scored s
  WHERE s.is_exact OR NOT EXISTS (SELECT 1 FROM scored s2 WHERE s2.idx = s.idx AND s2.is_exact)
),
best AS (
  SELECT p.*, max(p.hits) OVER (PARTITION BY p.idx) AS max_hits FROM pool p
),
winner AS (
  SELECT b.*, count(*) OVER (PARTITION BY b.idx) AS tie_cnt
  FROM best b WHERE b.hits = b.max_hits
),
plan AS (
  SELECT w.idx, w.in_name, w.in_inn, w.id, w.card_name, w.card_inn, w.tie_cnt,
    CASE
      WHEN w.tie_cnt > 1 THEN 'ambiguous'
      WHEN coalesce(btrim(w.card_inn), '') = '' THEN 'to_update'
      WHEN btrim(w.card_inn) = w.in_inn THEN 'already'
      ELSE 'conflict'
    END AS status
  FROM winner w
  UNION ALL
  SELECT i.idx, i.name, i.inn, NULL::uuid, NULL::varchar, NULL::varchar, 0::bigint, 'not_found'
  FROM inp i WHERE NOT EXISTS (SELECT 1 FROM cand c WHERE c.idx = i.idx)
)
SELECT p.status,
       p.id,
       p.in_name              AS "название в файле",
       p.card_name            AS "название в базе",
       coalesce(p.card_inn, '') AS "ИНН сейчас",
       p.in_inn               AS "ИНН к записи",
       CASE p.status
         WHEN 'to_update' THEN 'будет записан'
         WHEN 'already'   THEN 'уже такой же — не трогаем'
         WHEN 'conflict'  THEN 'в базе другой ИНН — не перезаписываем'
         WHEN 'ambiguous' THEN 'несколько подходящих карточек — нужна ручная проверка'
         ELSE 'карточка с таким названием не найдена'
       END                    AS "что будет"
FROM plan p
ORDER BY CASE p.status WHEN 'to_update' THEN 1 WHEN 'already' THEN 2 WHEN 'conflict' THEN 3 WHEN 'ambiguous' THEN 4 ELSE 5 END, p.in_name;

-- ── ШАГ 1б. Сводка по статусам ─────────────────────────────────────────────
WITH input(idx, name, inn, contact_name, phone, email, work_type) AS (
  VALUES
    (1::int, 'ООО "СТРОЙИНВЕСТ"'::text, '7716986926'::text, NULL::text, NULL::text, NULL::text, NULL::text),
    (2, 'АО "ТопРендж"', '7704025036', NULL, NULL, NULL, NULL),
    (3, 'Астро-лифт', '0276088789', NULL, NULL, NULL, NULL),
    (4, 'БК Глобус', '5001148873', NULL, NULL, NULL, NULL),
    (5, 'ДСК Профстрой', '7720378790', NULL, NULL, NULL, NULL),
    (6, 'Империя', '9701146276', NULL, NULL, NULL, NULL),
    (7, 'Интеллект Обслуживание', '7722465946', NULL, NULL, NULL, NULL),
    (8, 'ИП "Гаджиев"', '370606654100', NULL, NULL, NULL, NULL),
    (9, 'ИП "Лихолитов"', '771311712158', NULL, NULL, NULL, NULL),
    (10, 'ИП "Порунов"', '524310784550', NULL, NULL, NULL, NULL),
    (11, 'ИП "Соловьева"', '645109889300', NULL, NULL, NULL, NULL),
    (12, 'ИП "Хэлл"', '270414747284', NULL, NULL, NULL, NULL),
    (13, 'ИП Ганичев', '292501781094', NULL, NULL, NULL, NULL),
    (14, 'Корона Лифт', '7725275319', NULL, NULL, NULL, NULL),
    (15, 'МеталлАлмазСтрой', '7720965005', NULL, NULL, NULL, NULL),
    (16, 'ООО "АДМ СТРОЙ"', '9723012117', NULL, NULL, NULL, NULL),
    (17, 'ООО "Адм-Строй"', '9723012117', NULL, NULL, NULL, NULL),
    (18, 'ООО "Азимут ВСК"', '5005065184', NULL, NULL, NULL, NULL),
    (19, 'ООО "Алюспейс"', '5047145219', NULL, NULL, NULL, NULL),
    (20, 'ООО "Атриум"', '7725496212', NULL, NULL, NULL, NULL),
    (21, 'ООО "ВЕКТОР-СТРОЙ 26"', '5047326617', NULL, NULL, NULL, NULL),
    (22, 'ООО “ВОКСЭМ”', '9726043106', NULL, NULL, NULL, NULL),
    (23, 'ООО "Гранд Строй Мир"', '7725476304', NULL, NULL, NULL, NULL),
    (24, 'ООО "Интегрированное Комплексное Строительство"', '9724214130', NULL, NULL, NULL, NULL),
    (25, 'ООО "ИНТЕЛ МУЗ"', '9710154629', NULL, NULL, NULL, NULL),
    (26, 'ООО "Инфотрейд"', '7730176190', NULL, NULL, NULL, NULL),
    (27, 'ООО "КД Дельта"', '9705046530', NULL, NULL, NULL, NULL),
    (28, 'ООО "Кросс-ГРУПП"', '9701157694', NULL, NULL, NULL, NULL),
    (29, 'ООО "ЛЭНДМЭН"', '9701309114', NULL, NULL, NULL, NULL),
    (30, 'ООО "Омен Групп"', '9721174031', NULL, NULL, NULL, NULL),
    (31, 'ООО "РСК (РСД)"', '5047197930', NULL, NULL, NULL, NULL),
    (32, 'ООО "Техстронг" (ТС Инжиниринг)', '7716890075', NULL, NULL, NULL, NULL),
    (33, 'ООО "ТОНОЗ"', '9729384746', NULL, NULL, NULL, NULL),
    (34, 'ООО "Фасадные системы"', '7703443104', NULL, NULL, NULL, NULL),
    (35, 'ООО "ЭСКО"', '3123301684', NULL, NULL, NULL, NULL),
    (36, 'ООО «АТС ГРУПП»', '9701097212', 'Агафонов Дмитрий Анатольевич', '+7(495)649-09-63', 'office@atsgroup.pro', 'ВИС'),
    (37, 'ООО «ПартнерЦентр»', '7713743869', NULL, NULL, NULL, NULL),
    (38, 'ООО «Спецпорт „Надежда“», Москва', '7726448317', NULL, NULL, NULL, NULL),
    (39, 'ООО «ТехСтройГарант»', '9704140307', NULL, NULL, NULL, NULL),
    (40, 'ООО ГК РВ Инжиниринг', '7708801138', 'Андреев Алексей Владимирович', '+7(903)759-04-15', 'olec91@list.ru', 'Водомерный узел, Кондиционирование, ВИС'),
    (41, 'ООО ЛТМ', '6678002550', NULL, NULL, NULL, NULL),
    (42, 'ООО ТетраГрупп', '7727362341', NULL, NULL, NULL, NULL),
    (43, 'ООО Фаст-Групп', '9727113518', NULL, NULL, NULL, NULL),
    (44, 'ПАО "МГТС"', '7710016640', NULL, NULL, NULL, NULL),
    (45, 'Промальянс', '5048026687', NULL, NULL, NULL, NULL),
    (46, 'ПромАтомСтрой', '9717186066', NULL, NULL, NULL, NULL),
    (47, 'Профистрой', '9701191600', NULL, NULL, NULL, NULL),
    (48, 'ПЭМ-ЭНЕРГО', '7743190837', NULL, NULL, NULL, NULL),
    (49, 'СК Стройсервис', '9728074050', NULL, NULL, NULL, NULL),
    (50, 'Спектрарстрой', '9715000245', NULL, NULL, NULL, NULL),
    (51, 'ТехСтройГарант', '9704140307', NULL, NULL, NULL, NULL),
    (52, 'ФСК Инжиниринг', '7725494913', NULL, NULL, NULL, NULL),
    (53, 'ЭМДМ-строй', '7720961314', NULL, NULL, NULL, NULL),
    (54, 'QWENT / ООО «ИНЖСИСТЕМС»', '9724214532', NULL, NULL, NULL, NULL)
),
inp AS (
  SELECT i.*, btrim(i.name) AS ex, lower(regexp_replace(translate(btrim(translate(i.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm FROM input i
),
card AS (
  SELECT c.id, c.name, c.inn, c.work_type, btrim(c.name) AS ex, lower(regexp_replace(translate(btrim(translate(c.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm
  FROM public.counterparties c
  WHERE c.deleted_at IS NULL
),
cand AS (
  SELECT inp.idx, inp.name AS in_name, inp.inn AS in_inn,
         inp.contact_name, inp.phone, inp.email, inp.work_type AS in_work_type,
         card.id, card.name AS card_name, card.inn AS card_inn, card.work_type AS card_work_type,
         (card.ex = inp.ex) AS is_exact
  FROM inp JOIN card ON card.ex = inp.ex OR card.nm = inp.nm
),
scored AS (
  SELECT cand.*,
      (CASE WHEN cand.contact_name IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.full_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.contact_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.phone IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id
            AND regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') = regexp_replace(cand.phone, '\D', '', 'g')) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.email IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.in_work_type IS NOT NULL AND lower(regexp_replace(translate(btrim(translate(cand.card_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.in_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) THEN 1 ELSE 0 END) AS hits
  FROM cand
),
pool AS (
  -- точное совпадение названия важнее; регистр и кавычки — запасной проход
  SELECT s.* FROM scored s
  WHERE s.is_exact OR NOT EXISTS (SELECT 1 FROM scored s2 WHERE s2.idx = s.idx AND s2.is_exact)
),
best AS (
  SELECT p.*, max(p.hits) OVER (PARTITION BY p.idx) AS max_hits FROM pool p
),
winner AS (
  SELECT b.*, count(*) OVER (PARTITION BY b.idx) AS tie_cnt
  FROM best b WHERE b.hits = b.max_hits
),
plan AS (
  SELECT w.idx, w.in_name, w.in_inn, w.id, w.card_name, w.card_inn, w.tie_cnt,
    CASE
      WHEN w.tie_cnt > 1 THEN 'ambiguous'
      WHEN coalesce(btrim(w.card_inn), '') = '' THEN 'to_update'
      WHEN btrim(w.card_inn) = w.in_inn THEN 'already'
      ELSE 'conflict'
    END AS status
  FROM winner w
  UNION ALL
  SELECT i.idx, i.name, i.inn, NULL::uuid, NULL::varchar, NULL::varchar, 0::bigint, 'not_found'
  FROM inp i WHERE NOT EXISTS (SELECT 1 FROM cand c WHERE c.idx = i.idx)
)
SELECT p.status, count(*) AS "строк"
FROM plan p GROUP BY p.status ORDER BY 2 DESC;

-- ── ШАГ 1в. Карточки на ручное решение: две одинаковые «ООО "3М Групп"» ──
--     ИНН из файла — 7730263252. Автоматически не обновляем: решаете вы.
SELECT id, name, inn, work_type, created_at
FROM public.counterparties
WHERE deleted_at IS NULL
  AND lower(regexp_replace(translate(btrim(translate(name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate('ООО "3М Групп"', E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))
ORDER BY created_at;


-- ── ШАГ 1г. Подсказки по ненайденным: как эти карточки называются в базе ───
--     Для каждой строки со статусом not_found ищем похожие карточки по самому
--     длинному слову названия. Ничего не меняет — нужно, чтобы решить, та ли
--     это карточка (тогда правим название в файле и повторяем шаг 1).
WITH input(idx, name, inn, contact_name, phone, email, work_type) AS (
  VALUES
    (1::int, 'ООО "СТРОЙИНВЕСТ"'::text, '7716986926'::text, NULL::text, NULL::text, NULL::text, NULL::text),
    (2, 'АО "ТопРендж"', '7704025036', NULL, NULL, NULL, NULL),
    (3, 'Астро-лифт', '0276088789', NULL, NULL, NULL, NULL),
    (4, 'БК Глобус', '5001148873', NULL, NULL, NULL, NULL),
    (5, 'ДСК Профстрой', '7720378790', NULL, NULL, NULL, NULL),
    (6, 'Империя', '9701146276', NULL, NULL, NULL, NULL),
    (7, 'Интеллект Обслуживание', '7722465946', NULL, NULL, NULL, NULL),
    (8, 'ИП "Гаджиев"', '370606654100', NULL, NULL, NULL, NULL),
    (9, 'ИП "Лихолитов"', '771311712158', NULL, NULL, NULL, NULL),
    (10, 'ИП "Порунов"', '524310784550', NULL, NULL, NULL, NULL),
    (11, 'ИП "Соловьева"', '645109889300', NULL, NULL, NULL, NULL),
    (12, 'ИП "Хэлл"', '270414747284', NULL, NULL, NULL, NULL),
    (13, 'ИП Ганичев', '292501781094', NULL, NULL, NULL, NULL),
    (14, 'Корона Лифт', '7725275319', NULL, NULL, NULL, NULL),
    (15, 'МеталлАлмазСтрой', '7720965005', NULL, NULL, NULL, NULL),
    (16, 'ООО "АДМ СТРОЙ"', '9723012117', NULL, NULL, NULL, NULL),
    (17, 'ООО "Адм-Строй"', '9723012117', NULL, NULL, NULL, NULL),
    (18, 'ООО "Азимут ВСК"', '5005065184', NULL, NULL, NULL, NULL),
    (19, 'ООО "Алюспейс"', '5047145219', NULL, NULL, NULL, NULL),
    (20, 'ООО "Атриум"', '7725496212', NULL, NULL, NULL, NULL),
    (21, 'ООО "ВЕКТОР-СТРОЙ 26"', '5047326617', NULL, NULL, NULL, NULL),
    (22, 'ООО “ВОКСЭМ”', '9726043106', NULL, NULL, NULL, NULL),
    (23, 'ООО "Гранд Строй Мир"', '7725476304', NULL, NULL, NULL, NULL),
    (24, 'ООО "Интегрированное Комплексное Строительство"', '9724214130', NULL, NULL, NULL, NULL),
    (25, 'ООО "ИНТЕЛ МУЗ"', '9710154629', NULL, NULL, NULL, NULL),
    (26, 'ООО "Инфотрейд"', '7730176190', NULL, NULL, NULL, NULL),
    (27, 'ООО "КД Дельта"', '9705046530', NULL, NULL, NULL, NULL),
    (28, 'ООО "Кросс-ГРУПП"', '9701157694', NULL, NULL, NULL, NULL),
    (29, 'ООО "ЛЭНДМЭН"', '9701309114', NULL, NULL, NULL, NULL),
    (30, 'ООО "Омен Групп"', '9721174031', NULL, NULL, NULL, NULL),
    (31, 'ООО "РСК (РСД)"', '5047197930', NULL, NULL, NULL, NULL),
    (32, 'ООО "Техстронг" (ТС Инжиниринг)', '7716890075', NULL, NULL, NULL, NULL),
    (33, 'ООО "ТОНОЗ"', '9729384746', NULL, NULL, NULL, NULL),
    (34, 'ООО "Фасадные системы"', '7703443104', NULL, NULL, NULL, NULL),
    (35, 'ООО "ЭСКО"', '3123301684', NULL, NULL, NULL, NULL),
    (36, 'ООО «АТС ГРУПП»', '9701097212', 'Агафонов Дмитрий Анатольевич', '+7(495)649-09-63', 'office@atsgroup.pro', 'ВИС'),
    (37, 'ООО «ПартнерЦентр»', '7713743869', NULL, NULL, NULL, NULL),
    (38, 'ООО «Спецпорт „Надежда“», Москва', '7726448317', NULL, NULL, NULL, NULL),
    (39, 'ООО «ТехСтройГарант»', '9704140307', NULL, NULL, NULL, NULL),
    (40, 'ООО ГК РВ Инжиниринг', '7708801138', 'Андреев Алексей Владимирович', '+7(903)759-04-15', 'olec91@list.ru', 'Водомерный узел, Кондиционирование, ВИС'),
    (41, 'ООО ЛТМ', '6678002550', NULL, NULL, NULL, NULL),
    (42, 'ООО ТетраГрупп', '7727362341', NULL, NULL, NULL, NULL),
    (43, 'ООО Фаст-Групп', '9727113518', NULL, NULL, NULL, NULL),
    (44, 'ПАО "МГТС"', '7710016640', NULL, NULL, NULL, NULL),
    (45, 'Промальянс', '5048026687', NULL, NULL, NULL, NULL),
    (46, 'ПромАтомСтрой', '9717186066', NULL, NULL, NULL, NULL),
    (47, 'Профистрой', '9701191600', NULL, NULL, NULL, NULL),
    (48, 'ПЭМ-ЭНЕРГО', '7743190837', NULL, NULL, NULL, NULL),
    (49, 'СК Стройсервис', '9728074050', NULL, NULL, NULL, NULL),
    (50, 'Спектрарстрой', '9715000245', NULL, NULL, NULL, NULL),
    (51, 'ТехСтройГарант', '9704140307', NULL, NULL, NULL, NULL),
    (52, 'ФСК Инжиниринг', '7725494913', NULL, NULL, NULL, NULL),
    (53, 'ЭМДМ-строй', '7720961314', NULL, NULL, NULL, NULL),
    (54, 'QWENT / ООО «ИНЖСИСТЕМС»', '9724214532', NULL, NULL, NULL, NULL)
),
inp AS (
  SELECT i.*, btrim(i.name) AS ex, lower(regexp_replace(translate(btrim(translate(i.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm FROM input i
),
card AS (
  SELECT c.id, c.name, c.inn, c.work_type, btrim(c.name) AS ex, lower(regexp_replace(translate(btrim(translate(c.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm
  FROM public.counterparties c
  WHERE c.deleted_at IS NULL
),
cand AS (
  SELECT inp.idx, inp.name AS in_name, inp.inn AS in_inn,
         inp.contact_name, inp.phone, inp.email, inp.work_type AS in_work_type,
         card.id, card.name AS card_name, card.inn AS card_inn, card.work_type AS card_work_type,
         (card.ex = inp.ex) AS is_exact
  FROM inp JOIN card ON card.ex = inp.ex OR card.nm = inp.nm
),
scored AS (
  SELECT cand.*,
      (CASE WHEN cand.contact_name IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.full_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.contact_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.phone IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id
            AND regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') = regexp_replace(cand.phone, '\D', '', 'g')) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.email IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.in_work_type IS NOT NULL AND lower(regexp_replace(translate(btrim(translate(cand.card_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.in_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) THEN 1 ELSE 0 END) AS hits
  FROM cand
),
pool AS (
  -- точное совпадение названия важнее; регистр и кавычки — запасной проход
  SELECT s.* FROM scored s
  WHERE s.is_exact OR NOT EXISTS (SELECT 1 FROM scored s2 WHERE s2.idx = s.idx AND s2.is_exact)
),
best AS (
  SELECT p.*, max(p.hits) OVER (PARTITION BY p.idx) AS max_hits FROM pool p
),
winner AS (
  SELECT b.*, count(*) OVER (PARTITION BY b.idx) AS tie_cnt
  FROM best b WHERE b.hits = b.max_hits
),
plan AS (
  SELECT w.idx, w.in_name, w.in_inn, w.id, w.card_name, w.card_inn, w.tie_cnt,
    CASE
      WHEN w.tie_cnt > 1 THEN 'ambiguous'
      WHEN coalesce(btrim(w.card_inn), '') = '' THEN 'to_update'
      WHEN btrim(w.card_inn) = w.in_inn THEN 'already'
      ELSE 'conflict'
    END AS status
  FROM winner w
  UNION ALL
  SELECT i.idx, i.name, i.inn, NULL::uuid, NULL::varchar, NULL::varchar, 0::bigint, 'not_found'
  FROM inp i WHERE NOT EXISTS (SELECT 1 FROM cand c WHERE c.idx = i.idx)
),
missing AS (
  SELECT p.idx, p.in_name, p.in_inn FROM plan p WHERE p.status = 'not_found'
),
kw AS (
  SELECT m.*, (
    SELECT w
    FROM unnest(regexp_split_to_array(regexp_replace(lower(m.in_name), '[^a-zа-яё0-9]+', ' ', 'g'), ' +')) AS w
    WHERE w NOT IN ('ооо', 'ип', 'ао', 'пао', 'зао', 'гк', 'групп', 'москва') AND length(w) >= 2
    ORDER BY length(w) DESC
    LIMIT 1
  ) AS word
  FROM missing m
)
SELECT k.in_name                              AS "название в файле",
       k.in_inn                               AS "ИНН к записи",
       k.word                                 AS "искали по слову",
       c.id                                   AS "id карточки",
       c.name                                 AS "похожая карточка в базе",
       coalesce(c.inn, '')                    AS "ИНН карточки",
       CASE WHEN c.id IS NULL THEN '' WHEN c.deleted_at IS NULL THEN 'активна' ELSE 'удалена' END AS "состояние"
FROM kw k
LEFT JOIN public.counterparties c
  ON k.word IS NOT NULL AND lower(c.name) LIKE '%' || k.word || '%'
ORDER BY k.in_name, c.name;

-- ── ШАГ 2. Снимок перед записью (нужен для отката) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.counterparties_inn_backup_2026_09_21 AS
SELECT id, name, inn, updated_at, now() AS backup_at
FROM public.counterparties;

-- В снимке те же данные контрагентов, поэтому закрываем его так же, как
-- рабочие таблицы: RLS без политик + снятие прав у ключей anon/authenticated.
-- Редактор SQL работает от владельца базы, ему это не мешает (шаги 3-5 и откат).
ALTER TABLE public.counterparties_inn_backup_2026_09_21 ENABLE ROW LEVEL SECURITY;
DO $revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.counterparties_inn_backup_2026_09_21 FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.counterparties_inn_backup_2026_09_21 FROM authenticated';
  END IF;
END
$revoke$;

SELECT count(*) AS "записей в снимке" FROM public.counterparties_inn_backup_2026_09_21;


-- ── ШАГ 3. Запись. Обновляет только строки со статусом to_update и только
--     пока ИНН всё ещё пуст. Заодно пишет историю, как это делает интерфейс.
WITH input(idx, name, inn, contact_name, phone, email, work_type) AS (
  VALUES
    (1::int, 'ООО "СТРОЙИНВЕСТ"'::text, '7716986926'::text, NULL::text, NULL::text, NULL::text, NULL::text),
    (2, 'АО "ТопРендж"', '7704025036', NULL, NULL, NULL, NULL),
    (3, 'Астро-лифт', '0276088789', NULL, NULL, NULL, NULL),
    (4, 'БК Глобус', '5001148873', NULL, NULL, NULL, NULL),
    (5, 'ДСК Профстрой', '7720378790', NULL, NULL, NULL, NULL),
    (6, 'Империя', '9701146276', NULL, NULL, NULL, NULL),
    (7, 'Интеллект Обслуживание', '7722465946', NULL, NULL, NULL, NULL),
    (8, 'ИП "Гаджиев"', '370606654100', NULL, NULL, NULL, NULL),
    (9, 'ИП "Лихолитов"', '771311712158', NULL, NULL, NULL, NULL),
    (10, 'ИП "Порунов"', '524310784550', NULL, NULL, NULL, NULL),
    (11, 'ИП "Соловьева"', '645109889300', NULL, NULL, NULL, NULL),
    (12, 'ИП "Хэлл"', '270414747284', NULL, NULL, NULL, NULL),
    (13, 'ИП Ганичев', '292501781094', NULL, NULL, NULL, NULL),
    (14, 'Корона Лифт', '7725275319', NULL, NULL, NULL, NULL),
    (15, 'МеталлАлмазСтрой', '7720965005', NULL, NULL, NULL, NULL),
    (16, 'ООО "АДМ СТРОЙ"', '9723012117', NULL, NULL, NULL, NULL),
    (17, 'ООО "Адм-Строй"', '9723012117', NULL, NULL, NULL, NULL),
    (18, 'ООО "Азимут ВСК"', '5005065184', NULL, NULL, NULL, NULL),
    (19, 'ООО "Алюспейс"', '5047145219', NULL, NULL, NULL, NULL),
    (20, 'ООО "Атриум"', '7725496212', NULL, NULL, NULL, NULL),
    (21, 'ООО "ВЕКТОР-СТРОЙ 26"', '5047326617', NULL, NULL, NULL, NULL),
    (22, 'ООО “ВОКСЭМ”', '9726043106', NULL, NULL, NULL, NULL),
    (23, 'ООО "Гранд Строй Мир"', '7725476304', NULL, NULL, NULL, NULL),
    (24, 'ООО "Интегрированное Комплексное Строительство"', '9724214130', NULL, NULL, NULL, NULL),
    (25, 'ООО "ИНТЕЛ МУЗ"', '9710154629', NULL, NULL, NULL, NULL),
    (26, 'ООО "Инфотрейд"', '7730176190', NULL, NULL, NULL, NULL),
    (27, 'ООО "КД Дельта"', '9705046530', NULL, NULL, NULL, NULL),
    (28, 'ООО "Кросс-ГРУПП"', '9701157694', NULL, NULL, NULL, NULL),
    (29, 'ООО "ЛЭНДМЭН"', '9701309114', NULL, NULL, NULL, NULL),
    (30, 'ООО "Омен Групп"', '9721174031', NULL, NULL, NULL, NULL),
    (31, 'ООО "РСК (РСД)"', '5047197930', NULL, NULL, NULL, NULL),
    (32, 'ООО "Техстронг" (ТС Инжиниринг)', '7716890075', NULL, NULL, NULL, NULL),
    (33, 'ООО "ТОНОЗ"', '9729384746', NULL, NULL, NULL, NULL),
    (34, 'ООО "Фасадные системы"', '7703443104', NULL, NULL, NULL, NULL),
    (35, 'ООО "ЭСКО"', '3123301684', NULL, NULL, NULL, NULL),
    (36, 'ООО «АТС ГРУПП»', '9701097212', 'Агафонов Дмитрий Анатольевич', '+7(495)649-09-63', 'office@atsgroup.pro', 'ВИС'),
    (37, 'ООО «ПартнерЦентр»', '7713743869', NULL, NULL, NULL, NULL),
    (38, 'ООО «Спецпорт „Надежда“», Москва', '7726448317', NULL, NULL, NULL, NULL),
    (39, 'ООО «ТехСтройГарант»', '9704140307', NULL, NULL, NULL, NULL),
    (40, 'ООО ГК РВ Инжиниринг', '7708801138', 'Андреев Алексей Владимирович', '+7(903)759-04-15', 'olec91@list.ru', 'Водомерный узел, Кондиционирование, ВИС'),
    (41, 'ООО ЛТМ', '6678002550', NULL, NULL, NULL, NULL),
    (42, 'ООО ТетраГрупп', '7727362341', NULL, NULL, NULL, NULL),
    (43, 'ООО Фаст-Групп', '9727113518', NULL, NULL, NULL, NULL),
    (44, 'ПАО "МГТС"', '7710016640', NULL, NULL, NULL, NULL),
    (45, 'Промальянс', '5048026687', NULL, NULL, NULL, NULL),
    (46, 'ПромАтомСтрой', '9717186066', NULL, NULL, NULL, NULL),
    (47, 'Профистрой', '9701191600', NULL, NULL, NULL, NULL),
    (48, 'ПЭМ-ЭНЕРГО', '7743190837', NULL, NULL, NULL, NULL),
    (49, 'СК Стройсервис', '9728074050', NULL, NULL, NULL, NULL),
    (50, 'Спектрарстрой', '9715000245', NULL, NULL, NULL, NULL),
    (51, 'ТехСтройГарант', '9704140307', NULL, NULL, NULL, NULL),
    (52, 'ФСК Инжиниринг', '7725494913', NULL, NULL, NULL, NULL),
    (53, 'ЭМДМ-строй', '7720961314', NULL, NULL, NULL, NULL),
    (54, 'QWENT / ООО «ИНЖСИСТЕМС»', '9724214532', NULL, NULL, NULL, NULL)
),
inp AS (
  SELECT i.*, btrim(i.name) AS ex, lower(regexp_replace(translate(btrim(translate(i.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm FROM input i
),
card AS (
  SELECT c.id, c.name, c.inn, c.work_type, btrim(c.name) AS ex, lower(regexp_replace(translate(btrim(translate(c.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm
  FROM public.counterparties c
  WHERE c.deleted_at IS NULL
),
cand AS (
  SELECT inp.idx, inp.name AS in_name, inp.inn AS in_inn,
         inp.contact_name, inp.phone, inp.email, inp.work_type AS in_work_type,
         card.id, card.name AS card_name, card.inn AS card_inn, card.work_type AS card_work_type,
         (card.ex = inp.ex) AS is_exact
  FROM inp JOIN card ON card.ex = inp.ex OR card.nm = inp.nm
),
scored AS (
  SELECT cand.*,
      (CASE WHEN cand.contact_name IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.full_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.contact_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.phone IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id
            AND regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') = regexp_replace(cand.phone, '\D', '', 'g')) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.email IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.in_work_type IS NOT NULL AND lower(regexp_replace(translate(btrim(translate(cand.card_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.in_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) THEN 1 ELSE 0 END) AS hits
  FROM cand
),
pool AS (
  -- точное совпадение названия важнее; регистр и кавычки — запасной проход
  SELECT s.* FROM scored s
  WHERE s.is_exact OR NOT EXISTS (SELECT 1 FROM scored s2 WHERE s2.idx = s.idx AND s2.is_exact)
),
best AS (
  SELECT p.*, max(p.hits) OVER (PARTITION BY p.idx) AS max_hits FROM pool p
),
winner AS (
  SELECT b.*, count(*) OVER (PARTITION BY b.idx) AS tie_cnt
  FROM best b WHERE b.hits = b.max_hits
),
plan AS (
  SELECT w.idx, w.in_name, w.in_inn, w.id, w.card_name, w.card_inn, w.tie_cnt,
    CASE
      WHEN w.tie_cnt > 1 THEN 'ambiguous'
      WHEN coalesce(btrim(w.card_inn), '') = '' THEN 'to_update'
      WHEN btrim(w.card_inn) = w.in_inn THEN 'already'
      ELSE 'conflict'
    END AS status
  FROM winner w
  UNION ALL
  SELECT i.idx, i.name, i.inn, NULL::uuid, NULL::varchar, NULL::varchar, 0::bigint, 'not_found'
  FROM inp i WHERE NOT EXISTS (SELECT 1 FROM cand c WHERE c.idx = i.idx)
),
upd AS (
  UPDATE public.counterparties c
  SET inn = p.in_inn
  FROM plan p
  WHERE c.id = p.id
    AND p.status = 'to_update'
    AND coalesce(btrim(c.inn), '') = ''
  RETURNING c.id, c.name, c.inn AS new_inn, p.card_inn AS old_inn
)
INSERT INTO public.counterparty_audit_log
  (counterparty_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
SELECT u.id, 'field_updated', 'inn', to_jsonb(u.old_inn), to_jsonb(u.new_inn),
       'ИНН: ' || coalesce(nullif(btrim(coalesce(u.old_inn, '')), ''), 'не указан') || ' → ' || u.new_inn,
       'script', 'Массовое заполнение ИНН (SQL Editor)'
FROM upd u
RETURNING counterparty_id AS id, new_value AS "записанный ИНН";


-- ── ШАГ 4. Проверка: перечитываем записи и сверяем ─────────────────────────
WITH input(idx, name, inn, contact_name, phone, email, work_type) AS (
  VALUES
    (1::int, 'ООО "СТРОЙИНВЕСТ"'::text, '7716986926'::text, NULL::text, NULL::text, NULL::text, NULL::text),
    (2, 'АО "ТопРендж"', '7704025036', NULL, NULL, NULL, NULL),
    (3, 'Астро-лифт', '0276088789', NULL, NULL, NULL, NULL),
    (4, 'БК Глобус', '5001148873', NULL, NULL, NULL, NULL),
    (5, 'ДСК Профстрой', '7720378790', NULL, NULL, NULL, NULL),
    (6, 'Империя', '9701146276', NULL, NULL, NULL, NULL),
    (7, 'Интеллект Обслуживание', '7722465946', NULL, NULL, NULL, NULL),
    (8, 'ИП "Гаджиев"', '370606654100', NULL, NULL, NULL, NULL),
    (9, 'ИП "Лихолитов"', '771311712158', NULL, NULL, NULL, NULL),
    (10, 'ИП "Порунов"', '524310784550', NULL, NULL, NULL, NULL),
    (11, 'ИП "Соловьева"', '645109889300', NULL, NULL, NULL, NULL),
    (12, 'ИП "Хэлл"', '270414747284', NULL, NULL, NULL, NULL),
    (13, 'ИП Ганичев', '292501781094', NULL, NULL, NULL, NULL),
    (14, 'Корона Лифт', '7725275319', NULL, NULL, NULL, NULL),
    (15, 'МеталлАлмазСтрой', '7720965005', NULL, NULL, NULL, NULL),
    (16, 'ООО "АДМ СТРОЙ"', '9723012117', NULL, NULL, NULL, NULL),
    (17, 'ООО "Адм-Строй"', '9723012117', NULL, NULL, NULL, NULL),
    (18, 'ООО "Азимут ВСК"', '5005065184', NULL, NULL, NULL, NULL),
    (19, 'ООО "Алюспейс"', '5047145219', NULL, NULL, NULL, NULL),
    (20, 'ООО "Атриум"', '7725496212', NULL, NULL, NULL, NULL),
    (21, 'ООО "ВЕКТОР-СТРОЙ 26"', '5047326617', NULL, NULL, NULL, NULL),
    (22, 'ООО “ВОКСЭМ”', '9726043106', NULL, NULL, NULL, NULL),
    (23, 'ООО "Гранд Строй Мир"', '7725476304', NULL, NULL, NULL, NULL),
    (24, 'ООО "Интегрированное Комплексное Строительство"', '9724214130', NULL, NULL, NULL, NULL),
    (25, 'ООО "ИНТЕЛ МУЗ"', '9710154629', NULL, NULL, NULL, NULL),
    (26, 'ООО "Инфотрейд"', '7730176190', NULL, NULL, NULL, NULL),
    (27, 'ООО "КД Дельта"', '9705046530', NULL, NULL, NULL, NULL),
    (28, 'ООО "Кросс-ГРУПП"', '9701157694', NULL, NULL, NULL, NULL),
    (29, 'ООО "ЛЭНДМЭН"', '9701309114', NULL, NULL, NULL, NULL),
    (30, 'ООО "Омен Групп"', '9721174031', NULL, NULL, NULL, NULL),
    (31, 'ООО "РСК (РСД)"', '5047197930', NULL, NULL, NULL, NULL),
    (32, 'ООО "Техстронг" (ТС Инжиниринг)', '7716890075', NULL, NULL, NULL, NULL),
    (33, 'ООО "ТОНОЗ"', '9729384746', NULL, NULL, NULL, NULL),
    (34, 'ООО "Фасадные системы"', '7703443104', NULL, NULL, NULL, NULL),
    (35, 'ООО "ЭСКО"', '3123301684', NULL, NULL, NULL, NULL),
    (36, 'ООО «АТС ГРУПП»', '9701097212', 'Агафонов Дмитрий Анатольевич', '+7(495)649-09-63', 'office@atsgroup.pro', 'ВИС'),
    (37, 'ООО «ПартнерЦентр»', '7713743869', NULL, NULL, NULL, NULL),
    (38, 'ООО «Спецпорт „Надежда“», Москва', '7726448317', NULL, NULL, NULL, NULL),
    (39, 'ООО «ТехСтройГарант»', '9704140307', NULL, NULL, NULL, NULL),
    (40, 'ООО ГК РВ Инжиниринг', '7708801138', 'Андреев Алексей Владимирович', '+7(903)759-04-15', 'olec91@list.ru', 'Водомерный узел, Кондиционирование, ВИС'),
    (41, 'ООО ЛТМ', '6678002550', NULL, NULL, NULL, NULL),
    (42, 'ООО ТетраГрупп', '7727362341', NULL, NULL, NULL, NULL),
    (43, 'ООО Фаст-Групп', '9727113518', NULL, NULL, NULL, NULL),
    (44, 'ПАО "МГТС"', '7710016640', NULL, NULL, NULL, NULL),
    (45, 'Промальянс', '5048026687', NULL, NULL, NULL, NULL),
    (46, 'ПромАтомСтрой', '9717186066', NULL, NULL, NULL, NULL),
    (47, 'Профистрой', '9701191600', NULL, NULL, NULL, NULL),
    (48, 'ПЭМ-ЭНЕРГО', '7743190837', NULL, NULL, NULL, NULL),
    (49, 'СК Стройсервис', '9728074050', NULL, NULL, NULL, NULL),
    (50, 'Спектрарстрой', '9715000245', NULL, NULL, NULL, NULL),
    (51, 'ТехСтройГарант', '9704140307', NULL, NULL, NULL, NULL),
    (52, 'ФСК Инжиниринг', '7725494913', NULL, NULL, NULL, NULL),
    (53, 'ЭМДМ-строй', '7720961314', NULL, NULL, NULL, NULL),
    (54, 'QWENT / ООО «ИНЖСИСТЕМС»', '9724214532', NULL, NULL, NULL, NULL)
),
inp AS (
  SELECT i.*, btrim(i.name) AS ex, lower(regexp_replace(translate(btrim(translate(i.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm FROM input i
),
card AS (
  SELECT c.id, c.name, c.inn, c.work_type, btrim(c.name) AS ex, lower(regexp_replace(translate(btrim(translate(c.name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) AS nm
  FROM public.counterparties c
  WHERE c.deleted_at IS NULL
),
cand AS (
  SELECT inp.idx, inp.name AS in_name, inp.inn AS in_inn,
         inp.contact_name, inp.phone, inp.email, inp.work_type AS in_work_type,
         card.id, card.name AS card_name, card.inn AS card_inn, card.work_type AS card_work_type,
         (card.ex = inp.ex) AS is_exact
  FROM inp JOIN card ON card.ex = inp.ex OR card.nm = inp.nm
),
scored AS (
  SELECT cand.*,
      (CASE WHEN cand.contact_name IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.full_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.contact_name, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.phone IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id
            AND regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') = regexp_replace(cand.phone, '\D', '', 'g')) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.email IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.counterparty_contacts cc
          WHERE cc.counterparty_id = cand.id AND lower(regexp_replace(translate(btrim(translate(cc.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.email, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g'))) THEN 1 ELSE 0 END)
    + (CASE WHEN cand.in_work_type IS NOT NULL AND lower(regexp_replace(translate(btrim(translate(cand.card_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) = lower(regexp_replace(translate(btrim(translate(cand.in_work_type, E'\u00A0\u2007\u202F', '   ')), '«»„“”‘’''"', '"""""""""'), '\s+', ' ', 'g')) THEN 1 ELSE 0 END) AS hits
  FROM cand
),
pool AS (
  -- точное совпадение названия важнее; регистр и кавычки — запасной проход
  SELECT s.* FROM scored s
  WHERE s.is_exact OR NOT EXISTS (SELECT 1 FROM scored s2 WHERE s2.idx = s.idx AND s2.is_exact)
),
best AS (
  SELECT p.*, max(p.hits) OVER (PARTITION BY p.idx) AS max_hits FROM pool p
),
winner AS (
  SELECT b.*, count(*) OVER (PARTITION BY b.idx) AS tie_cnt
  FROM best b WHERE b.hits = b.max_hits
),
plan AS (
  SELECT w.idx, w.in_name, w.in_inn, w.id, w.card_name, w.card_inn, w.tie_cnt,
    CASE
      WHEN w.tie_cnt > 1 THEN 'ambiguous'
      WHEN coalesce(btrim(w.card_inn), '') = '' THEN 'to_update'
      WHEN btrim(w.card_inn) = w.in_inn THEN 'already'
      ELSE 'conflict'
    END AS status
  FROM winner w
  UNION ALL
  SELECT i.idx, i.name, i.inn, NULL::uuid, NULL::varchar, NULL::varchar, 0::bigint, 'not_found'
  FROM inp i WHERE NOT EXISTS (SELECT 1 FROM cand c WHERE c.idx = i.idx)
)
SELECT CASE WHEN coalesce(btrim(c.inn), '') = p.in_inn THEN 'ок' ELSE 'расхождение' END AS "итог",
       p.id, c.name AS "карточка", c.inn AS "ИНН в базе", p.in_inn AS "ожидалось", p.status AS "был статус"
FROM plan p
JOIN public.counterparties c ON c.id = p.id
WHERE p.status IN ('to_update', 'already')
ORDER BY 1 DESC, 3;

-- Повторный ШАГ 1 после записи должен показать у этих строк статус already.


-- ── ШАГ 5 (по желанию). Откат и уборка ─────────────────────────────────────
-- Вернуть ИНН как было на момент снимка:
-- UPDATE public.counterparties c
-- SET inn = b.inn
-- FROM public.counterparties_inn_backup_2026_09_21 b
-- WHERE b.id = c.id
--   AND coalesce(btrim(c.inn), '') IS DISTINCT FROM coalesce(btrim(b.inn), '');
--
-- Удалить снимок, когда он больше не нужен:
-- DROP TABLE public.counterparties_inn_backup_2026_09_21;
