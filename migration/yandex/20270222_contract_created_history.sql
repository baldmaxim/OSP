-- «Договоры и ДС» → карточка → «История»: у каждого договора и ДС — событие «Создание» (только база Яндекса: основание
-- берётся из журнала базы osp_private.data_audit_log, которого в Supabase нет; запрос пользователя 19.11.2026 — «добавить в
-- Историю, откуда появился документ, … сделай также историю создания для всех остальных документов в реестре»).
--
-- Что было (чтение базы Яндекса 19.11.2026): из 1814 документов «Создание» в «Истории» есть у 162 — его пишет форма «Добавить».
-- У остальных 1652 записи нет:
--   • загрузки пакетом (импорт из Excel и внешние загрузки): 14.09 (135 + 40), 16.09 (20 + 26), 20.10 (3), 27.10 (283 ДС),
--     30.10 с 22:00 по 22:14 МСК (1121: 560 договоров и 561 ДС, ID 870–2000 — среди них ДС ID 1827, с которого начался
--     вопрос), 06.11 (6), 09.11 (3 + 7). Кто загружал — база тогда не записывала;
--   • документы, созданные до появления «Истории» (первая запись в ней — 04.07.2026);
--   • одиночные документы, у которых событие создания не записалось (форма пишет его отдельным запросом после сохранения);
--   • созданные после 11.11.2026, когда автора создания уже записывает журнал базы (17.11 — два договора), но событие в
--     «Историю» не попало.
--
-- Что делает: каждому документу без «Создания» — одна запись «Создание» с датой создания документа (contracts.created_at) и
-- тем же началом текста, что пишет форма («Создан договор № …» / «Создано ДС … к документу ID …»), плюс основание:
--   journal        — автор и роль из журнала базы (INSERT строки договора);
--   before_history — документ создан раньше первой записи «Истории»: кто создал — не записано;
--   batch          — документ появился вместе с другими (3 и больше документов без «Создания», между соседними не больше
--                    15 минут): дата и время загрузки по Москве, сколько документов, из них договоров и ДС, диапазон ID;
--                    кто загружал — не записано;
--   single         — остальные: событие создания не записано, кто создал — неизвестно.
-- Автора, которого база не записала, миграция не придумывает: changed_by / changed_by_name / changed_by_role — пустые (страница
-- тогда не показывает строку автора). Отметка в new_value: {"restored": "20270222", "basis": …} — по ней проверка и откат.
-- Записи истории и сами документы больше ничем не меняются. Повтор безопасен: документам, у которых «Создание» уже есть,
-- ничего не добавляется. Проверка — 20270222_contract_created_history.check.sql, для прода — migration/backup/checks/20270222.sql;
-- откат — migration/rollback/20270222_contract_created_history_rollback.sql.
WITH
params AS (
  SELECT (SELECT min(l.changed_at) FROM public.contract_audit_log l) AS history_from,
         -- С какого времени база записывает автора создания: применение 20270121_audit_trail (на проде — 11.11.2026).
         coalesce((SELECT m.applied_at FROM osp_meta.schema_migrations m WHERE m.name = '20270121_audit_trail'),
                  (SELECT min(d.at) FROM osp_private.data_audit_log d)) AS journal_from,
         to_char(now() AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS today
),
missing AS (
  SELECT c.id, c.display_id, c.record_type, c.contract_number, c.created_at, p.display_id AS parent_display_id
  FROM public.contracts c
  LEFT JOIN public.contracts p ON p.id = c.parent_contract_id
  WHERE NOT EXISTS (SELECT 1 FROM public.contract_audit_log l WHERE l.contract_id = c.id AND l.event_type = 'created')
),
journal AS (
  SELECT DISTINCT ON (d.row_id) d.row_id, d.actor, d.actor_name, d.actor_role
  FROM osp_private.data_audit_log d
  WHERE d.table_name = 'contracts' AND d.op = 'INSERT' AND d.row_id IS NOT NULL
  ORDER BY d.row_id, d.at, d.id
),
classified AS (
  SELECT m.*, j.actor, j.actor_name, j.actor_role,
         CASE WHEN j.row_id IS NOT NULL THEN 'journal'
              WHEN m.created_at < (SELECT history_from FROM params) THEN 'before_history'
              ELSE 'other' END AS kind
  FROM missing m
  LEFT JOIN journal j ON j.row_id = m.id
),
gaps AS (
  SELECT c.id, c.display_id, c.record_type, c.created_at,
         CASE WHEN lag(c.created_at) OVER w IS NULL OR c.created_at - lag(c.created_at) OVER w > interval '15 minutes'
              THEN 1 ELSE 0 END AS brk
  FROM classified c
  WHERE c.kind = 'other'
  WINDOW w AS (ORDER BY c.created_at, c.display_id, c.id)
),
waves AS (
  SELECT g.*, sum(g.brk) OVER (ORDER BY g.created_at, g.display_id, g.id) AS wave
  FROM gaps g
),
wave_stats AS (
  SELECT w.wave, count(*) AS n,
         count(*) FILTER (WHERE w.record_type = 'dp') AS n_dp,
         count(*) FILTER (WHERE w.record_type IS DISTINCT FROM 'dp') AS n_ds,
         min(w.created_at) AS t0, max(w.created_at) AS t1, min(w.display_id) AS id0, max(w.display_id) AS id1
  FROM waves w
  GROUP BY w.wave
),
prepared AS (
  SELECT c.id, c.created_at, c.actor, c.actor_name, c.actor_role,
         CASE WHEN c.kind = 'other' AND s.n >= 3 THEN 'batch'
              WHEN c.kind = 'other' THEN 'single'
              ELSE c.kind END AS basis,
         -- Начало — как у формы «Добавить» (ContractsPage.jsx): «Создан договор № …» / «Создано <вид ДС> № … к документу ID …».
         CASE WHEN c.record_type = 'dp' OR c.record_type IS NULL THEN 'Создан договор'
              ELSE 'Создано ' || CASE c.record_type WHEN 'ds_vor' THEN 'ДС на изменение ВОР'
                                                    WHEN 'ds_extra' THEN 'ДС на дополнительные работы'
                                                    ELSE 'ДС' END END
           || CASE WHEN nullif(btrim(c.contract_number), '') IS NULL THEN ' (без номера)'
                   ELSE ' № ' || btrim(c.contract_number) END
           || CASE WHEN c.record_type IS DISTINCT FROM 'dp' AND c.parent_display_id IS NOT NULL
                   THEN ' к документу ID ' || c.parent_display_id ELSE '' END AS head,
         s.n, s.n_dp, s.n_ds, s.t0, s.t1, s.id0, s.id1
  FROM classified c
  LEFT JOIN waves w ON w.id = c.id
  LEFT JOIN wave_stats s ON s.wave = w.wave
),
texts AS (
  SELECT p.*,
         to_char(p.t0 AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS d0, to_char(p.t0 AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS h0,
         to_char(p.t1 AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS d1, to_char(p.t1 AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS h1,
         CASE WHEN (SELECT journal_from FROM params) IS NULL THEN ''
              ELSE ': автора создания база записывает с '
                   || to_char((SELECT journal_from FROM params) AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') END AS journal_note,
         CASE WHEN p.n % 10 = 1 AND p.n % 100 <> 11 THEN 'документ'
              WHEN p.n % 10 BETWEEN 2 AND 4 AND p.n % 100 NOT BETWEEN 12 AND 14 THEN 'документа'
              ELSE 'документов' END AS docs_word
  FROM prepared p
)
INSERT INTO public.contract_audit_log
  (contract_id, event_type, description, new_value, changed_at, changed_by, changed_by_name, changed_by_role)
SELECT t.id, 'created',
       t.head || '. ' || CASE t.basis
         WHEN 'journal' THEN
           'При создании событие в «Историю» не записалось; автор — по журналу базы. Запись восстановлена '
             || (SELECT today FROM params) || '.'
         WHEN 'before_history' THEN
           'Документ создан до появления «Истории» (первая запись в ней — '
             || to_char((SELECT history_from FROM params) AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI') || ' МСК), кто создал — не записано. '
             || 'Запись восстановлена ' || (SELECT today FROM params) || ' по дате создания документа.'
         WHEN 'batch' THEN
           'Документ появился в реестре в составе загрузки '
             || CASE WHEN t.d0 = t.d1 AND t.h0 = t.h1 THEN t.d0 || ' в ' || t.h0
                     WHEN t.d0 = t.d1 THEN t.d0 || ' с ' || t.h0 || ' по ' || t.h1
                     ELSE 'с ' || t.d0 || ' ' || t.h0 || ' по ' || t.d1 || ' ' || t.h1 END
             || ' (МСК): ' || t.n || ' ' || t.docs_word || ' ('
             || CASE WHEN t.n_dp > 0 AND t.n_ds > 0 THEN 'договоров — ' || t.n_dp || ', ДС — ' || t.n_ds || '; ' ELSE '' END
             || CASE WHEN t.id0 = t.id1 THEN 'ID ' || t.id0 ELSE 'ID ' || t.id0 || '–' || t.id1 END || '). '
             || 'Кто загружал — не записано' || t.journal_note || '. '
             || 'Запись восстановлена ' || (SELECT today FROM params) || ' по данным базы.'
         ELSE
           'Событие создания в «Историю» не записано, кто создал — неизвестно' || t.journal_note || '. '
             || 'Запись восстановлена ' || (SELECT today FROM params) || ' по дате создания документа.'
       END,
       CASE WHEN t.basis = 'batch'
            THEN jsonb_build_object('restored', '20270222', 'basis', t.basis,
                                    'batch', jsonb_build_object('from', t.t0, 'to', t.t1, 'documents', t.n, 'first_id', t.id0, 'last_id', t.id1))
            ELSE jsonb_build_object('restored', '20270222', 'basis', t.basis) END,
       t.created_at,
       CASE WHEN t.basis = 'journal' THEN t.actor END,
       CASE WHEN t.basis = 'journal' THEN t.actor_name END,
       CASE WHEN t.basis = 'journal' THEN t.actor_role END
FROM texts t;
