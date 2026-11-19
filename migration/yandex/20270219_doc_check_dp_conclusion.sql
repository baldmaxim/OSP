-- «Заявка на заключение ДП» переезжает на доску «Заявки на проверку ДП/ДС» (решение пользователя 19.11.2026: «в /dp-requests
-- нужно убрать вкладку. Созданные заявки должны помещаться в /doc-check-requests с светло-фиолетовым цветом и помечаться, что
-- это Заключение ДП. Существующие заявки перенеси в новые заявки»). Отдельного раздела больше нет: заявка на заключение ДП —
-- заявка доски с третьим типом документа doc_type = 'dp_conclusion' (страница красит её светло-фиолетовым и подписывает).
--  • 1. Ограничение типа: 'dp', 'ds', 'dp_conclusion'.
--  • 2. Резерв для отката — osp_private (FORCE RLS, только служебные операции): перенесённые заявки, их файлы, уведомления.
--  • 3. Перенос: все поданные заявки на ДП (и удалённые) — заявками доски с ТЕМ ЖЕ id, тип «Заключение ДП», колонка «Новые
--    заявки» сверху, автор, объект и даты прежние; прежний № и поля отдела — в примечании; история — «перенесена»; файлы — к
--    заявке доски (понятийное соглашение — своей частью, остальное — «Загружаемые документы»), ключи хранилища прежние
--    (каталог dp-requests/<id>/ шлюз файлов принимает у заявки доски с тем же id). Прежние строки остаются, живые — удалены.
--  • 4. Большое окно о новой заявке: уведомления (dp_request_alerts) ссылаются на заявки доски; новое заводит триггер, когда на
--    доске появляется «Заключение ДП»; dp_request_my_alerts — та же выдача для окна (и прежних вкладок), но из доски.
--  • 5. Прежний раздел заявок не принимает (вкладка, открытая до выкладки, получает «обновите страницу»).
-- Права раздела доски не меняются: создают заявку те же, кто создаёт заявки на проверку (doc_check_requests_create —
-- руководитель строительства и экономист объекта, как и dp_requests_create; правка раздела — отдел); понятийное соглашение
-- «Заключения ДП» требует форма, база — нет (у заявки доски нет черновика: файл грузится к уже созданной строке).
-- Тело (от «── 1.» до «── Права») — то же, что supabase/migrations/20270219_doc_check_dp_conclusion.sql; различаются права.
-- Проверка — 20270219_doc_check_dp_conclusion.check.sql, для прода — migration/backup/checks/20270219.sql; откат (отказ, если с
-- перенесёнными уже работали) — migration/rollback/20270219_doc_check_dp_conclusion_rollback.sql.
-- В нерабочее время: ALTER TABLE ненадолго блокирует таблицы заявок и уведомлений. Повтор безопасен.

-- ── 1. Третий тип заявки доски: «Заключение ДП» ───────────────────────────────────────────────────────
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_doc_type_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_doc_type_check
  CHECK (doc_type IN ('dp', 'ds', 'dp_conclusion'));
COMMENT ON COLUMN public.doc_check_requests.doc_type IS
  'dp — договор подряда, ds — дополнительное соглашение, dp_conclusion — заявка на заключение ДП (с 20270219; раньше — раздел /dp-requests)';

-- ── 2. Резерв для отката ──────────────────────────────────────────────────────────────────────────────
-- Перенесённые заявки (id тот же), их файлы (прежние владелец и категория) и уведомления, которые некуда было перенести.
CREATE TABLE IF NOT EXISTS osp_private.dp_moved_requests_20270219 (
  request_id uuid PRIMARY KEY,
  dp_number integer,
  dp_deleted_at timestamptz,
  moved_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE osp_private.dp_moved_requests_20270219 IS
  'Заявки на заключение ДП, перенесённые миграцией 20270219 на доску ДП/ДС (тот же id): прежний номер и отметка удаления — для отката';
CREATE TABLE IF NOT EXISTS osp_private.dp_moved_files_20270219 (
  doc_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  owner_type text NOT NULL,
  doc_category text,
  moved_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE osp_private.dp_moved_files_20270219 IS
  'Файлы перенесённых заявок на заключение ДП: прежние owner_type и doc_category (миграция 20270219) — для отката';
CREATE TABLE IF NOT EXISTS osp_private.dp_moved_alerts_20270219 (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz,
  read_at timestamptz,
  moved_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE osp_private.dp_moved_alerts_20270219 IS
  'Уведомления о заявках на ДП, которых нет на доске (черновики), убранные миграцией 20270219 — для отката';

-- ── 3. Перенос заявок, их файлов и истории ────────────────────────────────────────────────────────────
-- Все поданные заявки (и удалённые — в «Удалённые» доски), черновики — нет: их никто, кроме автора, не видел. Тот же id: по нему
-- работают прежние ссылки ?request=<id>, уведомления и файлы (объекты хранилища лежат в каталоге dp-requests/<id>/ — шлюз
-- файлов принимает его у заявки доски с тем же id). Все — в «Новые заявки», наверх колонки, новее выше. Номер на доске — свой
-- (ID доски), прежний № — строкой в примечании. Поля отдела (договор, сумма, ответственный), если были, — тоже в примечание.
-- Автор (created_by) сохраняется: по нему он меняет файлы своей заявки, пока она в «Новых». Триггер
-- doc_check_requests_write_guard на вставке ставит created_by := auth.uid() (у миграции пусто) — выключен только на неё.
-- Прежние строки dp_requests остаются (резерв, прежние вкладки), живые помечаются удалёнными. Повтор безопасен: перенесённое
-- (копия уже есть) не переносится второй раз.
DO $$
DECLARE
  v_guard boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'doc_check_requests_write_guard' AND NOT tgisinternal);
  -- created_by (20270102) — не во всех базах: без неё автор только текстом, как у прежних заявок доски.
  v_author boolean := EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_schema = 'public' AND table_name = 'doc_check_requests' AND column_name = 'created_by');
  v_clash bigint;
  v_top integer;
BEGIN
  IF to_regclass('public.dp_requests') IS NULL OR to_regclass('public.dp_request_alerts') IS NULL THEN
    RAISE EXCEPTION 'Нет таблиц заявок на ДП: сначала 20261227_dp_requests';
  END IF;

  SELECT count(*) INTO v_clash
  FROM public.dp_requests d JOIN public.doc_check_requests c ON c.id = d.id
  WHERE d.status <> 'draft' AND c.doc_type <> 'dp_conclusion';
  IF v_clash > 0 THEN
    RAISE EXCEPTION 'Перенос остановлен: % заявок на ДП совпадают по id с заявками доски другого типа', v_clash;
  END IF;

  INSERT INTO osp_private.dp_moved_requests_20270219 (request_id, dp_number, dp_deleted_at)
  SELECT d.id, d.request_number, d.deleted_at
  FROM public.dp_requests d
  WHERE d.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM public.doc_check_requests c WHERE c.id = d.id)
  ON CONFLICT (request_id) DO NOTHING;

  SELECT coalesce(max(c.sort_order), 0) INTO v_top
  FROM public.doc_check_requests c WHERE c.status = 'new' AND c.deleted_at IS NULL;

  IF v_guard THEN
    ALTER TABLE public.doc_check_requests DISABLE TRIGGER doc_check_requests_write_guard;
  END IF;
  EXECUTE format($q$
  WITH moved AS (
    INSERT INTO public.doc_check_requests
      (id, object_id, doc_type, status, notes, sort_order, deleted_at, created_at, updated_at, created_by_name%s)
    SELECT d.id, d.object_id, 'dp_conclusion', 'new',
           concat_ws(E'\n',
             nullif(btrim(d.reason), ''),
             'Договор: ' || nullif(btrim(d.contract_title), ''),
             'Сумма: ' || replace(to_char(d.amount, 'FM999999999999990.00'), '.', ',') || ' ₽',
             'Ответственный: ' || nullif(btrim(d.responsible_name), '')
               || CASE d.responsible_role WHEN 'economist' THEN ' (экономист)'
                                          WHEN 'construction_manager' THEN ' (руководитель строительства)' ELSE '' END,
             'Перенесена из «Заявки на заключение ДП» № ' || coalesce(b.dp_number::text, '—')),
           $1 + row_number() OVER (ORDER BY d.created_at, d.id),
           b.dp_deleted_at, d.created_at, d.updated_at, d.created_by_name%s
    FROM public.dp_requests d
    JOIN osp_private.dp_moved_requests_20270219 b ON b.request_id = d.id
    WHERE NOT EXISTS (SELECT 1 FROM public.doc_check_requests c WHERE c.id = d.id)
    RETURNING id
  )
  INSERT INTO public.doc_check_request_audit_log (request_id, event_type, description, changed_at, changed_by_name)
  SELECT d.id, 'created',
         'Заявка на заключение ДП № ' || coalesce(b.dp_number::text, '—') || ' перенесена из раздела «Заявка на заключение ДП»',
         d.created_at, coalesce(d.created_by_name, 'Пользователь')
  FROM moved m
  JOIN public.dp_requests d ON d.id = m.id
  JOIN osp_private.dp_moved_requests_20270219 b ON b.request_id = d.id
  UNION ALL
  SELECT d.id, 'soft_deleted', 'Заявка удалена (в прежнем разделе)', b.dp_deleted_at, coalesce(d.deleted_by_name, 'Пользователь')
  FROM moved m
  JOIN public.dp_requests d ON d.id = m.id
  JOIN osp_private.dp_moved_requests_20270219 b ON b.request_id = d.id
  WHERE b.dp_deleted_at IS NOT NULL
  $q$, CASE WHEN v_author THEN ', created_by' ELSE '' END, CASE WHEN v_author THEN ', d.created_by' ELSE '' END) USING v_top;
  IF v_guard THEN
    ALTER TABLE public.doc_check_requests ENABLE TRIGGER doc_check_requests_write_guard;
  END IF;

  -- Прежняя страница заявок на ДП (вкладка, открытая до выкладки) их больше не показывает.
  UPDATE public.dp_requests d SET deleted_at = now()
  FROM osp_private.dp_moved_requests_20270219 b
  WHERE b.request_id = d.id AND d.deleted_at IS NULL;

  -- Файлы: понятийное соглашение — своя часть заявки доски, остальное — «Загружаемые документы» (категория по умолчанию).
  -- Ключ в хранилище (s3_key) прежний.
  INSERT INTO osp_private.dp_moved_files_20270219 (doc_id, request_id, owner_type, doc_category)
  SELECT s.id, s.owner_id, s.owner_type, s.doc_category
  FROM public.s3_documents s
  JOIN osp_private.dp_moved_requests_20270219 b ON b.request_id = s.owner_id
  WHERE s.owner_type = 'dp_request'
  ON CONFLICT (doc_id) DO NOTHING;
  UPDATE public.s3_documents s
  SET owner_type = 'doc_check_request',
      doc_category = CASE WHEN s.doc_category = 'dp_concept_agreement' THEN 'doc_check_concept_agreement' ELSE 'general' END
  FROM osp_private.dp_moved_requests_20270219 b
  WHERE b.request_id = s.owner_id AND s.owner_type = 'dp_request';

  -- Уведомления, которым некуда указывать (заявки нет на доске), — в резерв: ссылка уведомлений переходит на доску.
  INSERT INTO osp_private.dp_moved_alerts_20270219 (id, request_id, user_id, created_at, read_at)
  SELECT a.id, a.request_id, a.user_id, a.created_at, a.read_at
  FROM public.dp_request_alerts a
  WHERE NOT EXISTS (SELECT 1 FROM public.doc_check_requests c WHERE c.id = a.request_id)
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.dp_request_alerts a
  WHERE NOT EXISTS (SELECT 1 FROM public.doc_check_requests c WHERE c.id = a.request_id);
END
$$;

-- ── 4. Большое окно о новой заявке — теперь о заявке «Заключение ДП» на доске ─────────────────────────
-- Получатели прежние (dp_request_alert_recipients, ведёт администратор). Уведомление заводится, когда на доске появилась заявка
-- типа «Заключение ДП» (кем бы ни была создана); перенесённые выше своих уведомлений заново не получают — триггер создан после.
ALTER TABLE public.dp_request_alerts DROP CONSTRAINT IF EXISTS dp_request_alerts_request_id_fkey;
ALTER TABLE public.dp_request_alerts ADD CONSTRAINT dp_request_alerts_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.doc_check_requests(id) ON DELETE CASCADE;
COMMENT ON TABLE public.dp_request_alerts IS
  'Уведомление получателю о новой заявке «Заключение ДП» на доске ДП/ДС (до 20270219 — о заявке на ДП): заводит триггер, read_at ставит dp_request_alerts_ack';

CREATE OR REPLACE FUNCTION public.doc_check_dp_conclusion_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  INSERT INTO public.dp_request_alerts (request_id, user_id)
  SELECT NEW.id, r.user_id FROM public.dp_request_alert_recipients r
  ON CONFLICT (request_id, user_id) DO NOTHING;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_dp_conclusion_alert ON public.doc_check_requests;
CREATE TRIGGER doc_check_dp_conclusion_alert
  AFTER INSERT ON public.doc_check_requests
  FOR EACH ROW WHEN (NEW.doc_type = 'dp_conclusion' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.doc_check_dp_conclusion_alert();

-- Окно читает то же, что раньше (прежние вкладки до выкладки сайта — тоже): номер — ID доски, примечание — примечание заявки;
-- договора, суммы и ответственного у заявки доски нет.
CREATE OR REPLACE FUNCTION public.dp_request_my_alerts()
  RETURNS TABLE (request_id uuid, request_number integer, object_name text, contract_title text, amount numeric,
                 responsible_name text, responsible_role text, reason text, created_by_name text, alerted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT r.id, r.request_number, o.name::text, NULL::text, NULL::numeric, NULL::text, NULL::text, r.notes,
         r.created_by_name, a.created_at
  FROM public.dp_request_alerts a
  JOIN public.doc_check_requests r ON r.id = a.request_id AND r.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = r.object_id
  WHERE a.user_id = auth.uid() AND a.read_at IS NULL AND public.osp_is_employee()
  ORDER BY a.created_at, a.id
  LIMIT 200
$$;

-- ── 5. Прежний раздел больше не принимает заявок ─────────────────────────────────────────────────────
-- Вкладка, открытая до выкладки сайта, создавала бы заявку, которую на доске никто не увидит. Таблица и её правила остаются
-- (резерв, откат); служебные операции без вошедшего — как раньше.
CREATE OR REPLACE FUNCTION public.dp_requests_moved_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Заявки на заключение ДП подаются в «Заявках на проверку ДП/ДС»: обновите страницу'
      USING ERRCODE = '42501', HINT = 'dp_requests_moved';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS dp_requests_moved ON public.dp_requests;
CREATE TRIGGER dp_requests_moved
  BEFORE INSERT ON public.dp_requests
  FOR EACH ROW EXECUTE FUNCTION public.dp_requests_moved_guard();
COMMENT ON TABLE public.dp_requests IS
  'Заявка на договор подряда (до 20270219). С 20270219 заявки — на доске ДП/ДС (doc_check_requests, doc_type = dp_conclusion, тот же id); новые сюда не пишутся';

-- ── Права ─────────────────────────────────────────────────────────────────────────────────────────────
-- Резерв — только служебным операциям (как osp_private.doc_check_marks_backup_20270218).
ALTER TABLE osp_private.dp_moved_requests_20270219 ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.dp_moved_requests_20270219 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.dp_moved_requests_20270219;
CREATE POLICY osp_internal ON osp_private.dp_moved_requests_20270219 FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
ALTER TABLE osp_private.dp_moved_files_20270219 ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.dp_moved_files_20270219 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.dp_moved_files_20270219;
CREATE POLICY osp_internal ON osp_private.dp_moved_files_20270219 FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
ALTER TABLE osp_private.dp_moved_alerts_20270219 ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.dp_moved_alerts_20270219 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.dp_moved_alerts_20270219;
CREATE POLICY osp_internal ON osp_private.dp_moved_alerts_20270219 FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
