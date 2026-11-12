-- «Заявки на проверку ДП/ДС»: файлы в обсуждении, история заявки от базы, согласование ПСДЦ, «прочитано» у каждого
-- (решения пользователя 12.11.2026). База нового портала — migration/yandex/20270216_doc_check_chat_history.sql (те же тела
-- функций, иначе — только права под одну учётку).
--
-- 1. Файлы в обсуждении. Файл сообщения — строка s3_documents заявки с doc_category = 'doc_check_chat'; сообщение хранит
--    снимок файла (attachments: id, имя, тип, размер, отпечаток sha256, ключ в хранилище). Снимок собирает база из строки
--    файла — что прислала страница, кроме id, не важно. Приложить можно только свой файл этой заявки, загруженный для
--    сообщения и ещё не отправленный. Отправленный файл не меняется и не удаляется никем (ни имя, ни ключ, ни заявка, ни
--    категория): переписка хранится как есть. Свой черновик вложения (загружен, сообщение не ушло) убрать можно.
--    Загружает файл в обсуждение тот, кто видит раздел и заявку, — как пишет сообщение; к удалённой заявке — нельзя.
-- 2. Строка любого файла заявки — только имя и описание (и часть — категорией, правом раздела): ключ объекта, размер,
--    отпечаток и автор не меняются — подменить содержимое, переставив строку на другой объект хранилища, нельзя.
-- 3. История заявки пишется базой (триггеры, в той же транзакции): создание, статус, удаление и восстановление, архив, поля
--    (и ответственный за ПСДЦ), а файлы — кто прикрепил, открепил, переименовал, перенёс в другую часть; файлы обсуждения —
--    когда отправлены сообщением. Запись страницы в историю больше не нужна: от вошедшего она молча отбрасывается (прежняя
--    вкладка пишет — дублей нет); автор, роль и время — от базы. Служебные операции (без вошедшего) не пишутся, как раньше.
--    Запись истории не правится и не удаляется (только вместе с заявкой), саму заявку вошедший удаляет только мягко — иначе с
--    ней ушли бы переписка и история.
-- 4. Согласование ПСДЦ: doc_check_requests.psdc_responsible_id — ответственный, необязателен, только действующий экономист
--    ОСП (роль economist). Назначает право правки раздела (по умолчанию — юрист ОСП); при подаче правом «только создавать»
--    не ставится.
-- 5. «Прочитано» в обсуждении — у каждого сотрудника своё и в базе (doc_check_talk_reads: граница «всё прежнее прочитано» и
--    отметки по заявкам), а не в браузере: на телефоне и компьютере одно и то же. Пишут и читают только функции
--    doc_check_talk_state / doc_check_talk_mark, свою строку.
-- 6. s3_documents.content_etag — отпечаток объекта в хранилище (ETag) на момент подтверждения загрузки: его ставит osp-api, и
--    при скачивании файла заявки он сверяется с хранилищем — перезапись объекта по ещё действующей ссылке на загрузку
--    (15 минут) не отдастся молча.
-- Блокировки: колонки без значения по умолчанию, триггеры на s3_documents — короткая блокировка, применять в нерабочее время.
-- Данные заявок, сообщений и файлов не меняются. Повтор безопасен.
-- Проверка: migration/backup/checks/20270216.sql, откат — migration/rollback/20270216_doc_check_chat_history_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Согласование ПСДЦ ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.doc_check_requests ADD COLUMN IF NOT EXISTS psdc_responsible_id uuid;
COMMENT ON COLUMN public.doc_check_requests.psdc_responsible_id IS
  'Согласование ПСДЦ: ответственный — экономист ОСП (user_roles.role = economist); необязателен';

CREATE OR REPLACE FUNCTION public.doc_check_requests_psdc_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Подача правом «только создавать»: работа отдела снимается, как исполнители и срок (doc_check_requests_write_guard).
  IF TG_OP = 'INSERT' AND NOT public.osp_can('doc_check_requests', 'edit') THEN
    NEW.psdc_responsible_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.psdc_responsible_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.psdc_responsible_id IS NOT DISTINCT FROM OLD.psdc_responsible_id) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur
                 WHERE ur.user_id = NEW.psdc_responsible_id AND ur.role = 'economist'
                   AND ur.is_approved IS TRUE AND ur.is_blocked IS NOT TRUE) THEN
    RAISE EXCEPTION 'Ответственный за согласование ПСДЦ — только действующий экономист ОСП'
      USING ERRCODE = '23514', HINT = 'doc_check_psdc_economist';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS doc_check_requests_psdc_guard ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_psdc_guard
  BEFORE INSERT OR UPDATE OF psdc_responsible_id ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_requests_psdc_guard();

-- ── 2. История заявки от базы ────────────────────────────────────────────────────────────────────────
-- Запись истории от имени вошедшего. Вызывают только триггеры ниже (выдачи нет никому): подделать запись нельзя. Отметка
-- application_name = 'osp:internal' — «пишет база» (у служебных функций она и так есть: в базе Яндекса это пропуск правил по
-- строкам): её видит doc_check_audit_log_server_only и пропускает запись. Свой параметр сеанса задать нельзя — база Яндекса
-- не даёт («permission denied to set parameter»).
CREATE OR REPLACE FUNCTION public.doc_check_history_write(p_request uuid, p_event text, p_field text, p_old jsonb, p_new jsonb,
                                                          p_description text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_name text;
  v_role text;
BEGIN
  -- Заявки уже нет (строку удалили целиком — служебная операция): писать некуда.
  IF NOT EXISTS (SELECT 1 FROM public.doc_check_requests WHERE id = p_request) THEN RETURN; END IF;
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  INSERT INTO public.doc_check_request_audit_log
    (request_id, event_type, field_name, old_value, new_value, description, changed_at, changed_by_role, changed_by_name)
  VALUES (p_request, p_event, p_field, p_old, p_new, p_description, now(), v_role, coalesce(v_name, 'Пользователь'));
END
$$;

-- Историю пишет база: запись страницы от вошедшего (прежняя вкладка, прямой запрос) молча отбрасывается — ни дублей, ни
-- выдуманных событий. Служебные операции без вошедшего (миграции, разовые скрипты) пишут как раньше.
CREATE OR REPLACE FUNCTION public.doc_check_audit_log_server_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR current_setting('application_name', true) = 'osp:internal' THEN RETURN NEW; END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_audit_log_server_only ON public.doc_check_request_audit_log;
CREATE TRIGGER doc_check_audit_log_server_only
  BEFORE INSERT ON public.doc_check_request_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_audit_log_server_only();

-- Запись истории не правится и не удаляется (кроме как вместе с заявкой); саму заявку удаляют только мягко (deleted_at) — иначе
-- вместе с ней ушли бы переписка, история и сведения о файлах. Страница строку заявки не удаляет (шлюз: delete — none); здесь —
-- и для прямого запроса к базе прежнего портала. Служебные операции (без вошедшего) — как раньше. База Яндекса держит журнал ещё
-- и правилом audit_log_guard (20270121) — второй замок не мешает.
CREATE OR REPLACE FUNCTION public.doc_check_keep_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'doc_check_requests' THEN
    RAISE EXCEPTION 'Заявку на проверку удаляют в «Удалённые»: переписка и история заявки хранятся'
      USING ERRCODE = '42501', HINT = 'doc_check_soft_delete_only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Запись истории заявки изменить нельзя' USING ERRCODE = '42501', HINT = 'audit_log_immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.doc_check_requests WHERE id = OLD.request_id) THEN
    RAISE EXCEPTION 'Запись истории заявки удалить нельзя' USING ERRCODE = '42501', HINT = 'audit_log_immutable';
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS doc_check_audit_log_keep ON public.doc_check_request_audit_log;
CREATE TRIGGER doc_check_audit_log_keep
  BEFORE UPDATE OR DELETE ON public.doc_check_request_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_keep_history();
DROP TRIGGER IF EXISTS doc_check_requests_keep_history ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_keep_history
  BEFORE DELETE ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_keep_history();

-- Заявка: создание, статус, удаление и восстановление, архив, поля. Те же события и поля, что писала страница (fieldEvents):
-- история прежних заявок и новых читается одинаково. Порядок колонок, номер и отметки времени — не события.
CREATE OR REPLACE FUNCTION public.doc_check_requests_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  f text;
  v_fields constant text[] := ARRAY['object_id', 'counterparty_id', 'doc_type', 'doc_number', 'doc_date', 'notes',
    'assignee_ids', 'manual_assignees', 'email_link', 'due_date', 'priority', 'color', 'labels', 'created_at',
    'created_by_name', 'psdc_responsible_id'];
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.doc_check_history_write(NEW.id, 'created', NULL, NULL, NULL, 'Заявка создана');
    RETURN NULL;
  END IF;
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.doc_check_history_write(NEW.id, 'status_changed', 'status', to_jsonb(OLD.status), to_jsonb(NEW.status), NULL);
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM public.doc_check_history_write(NEW.id, 'soft_deleted', NULL, NULL, NULL, 'Заявка удалена');
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    PERFORM public.doc_check_history_write(NEW.id, 'restored', NULL, NULL, NULL, 'Заявка восстановлена');
  END IF;
  -- Архив (колонка доски 20261113) — через jsonb: в базе без неё функция не ломается.
  IF (v_old ->> 'archived_at') IS NULL AND (v_new ->> 'archived_at') IS NOT NULL THEN
    PERFORM public.doc_check_history_write(NEW.id, 'archived', NULL, NULL, NULL, 'Заявка отправлена в архив');
  ELSIF (v_old ->> 'archived_at') IS NOT NULL AND (v_new ->> 'archived_at') IS NULL THEN
    PERFORM public.doc_check_history_write(NEW.id, 'unarchived', NULL, NULL, NULL, 'Заявка возвращена из архива');
  END IF;
  FOREACH f IN ARRAY v_fields LOOP
    IF v_new ? f AND (v_new -> f) IS DISTINCT FROM (v_old -> f) THEN
      PERFORM public.doc_check_history_write(NEW.id, 'field_updated', f, v_old -> f, v_new -> f, NULL);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_requests_history ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_history
  AFTER INSERT OR UPDATE ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_requests_history();

-- Файлы заявки: прикрепили, открепили, переименовали, перенесли в другую часть (или к другой заявке). Файлы обсуждения — когда
-- отправлены сообщением (doc_check_request_comments_history): черновик вложения, убранный до отправки, историю не засоряет.
CREATE OR REPLACE FUNCTION public.s3_documents_doc_check_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_part_old text;
  v_part_new text;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' AND OLD.owner_type = 'doc_check_request' THEN
    v_part_old := CASE OLD.doc_category WHEN 'doc_check_concept_agreement' THEN 'Понятийное соглашение'
                                        WHEN 'doc_check_chat' THEN 'Обсуждение' ELSE 'Загружаемые документы' END;
    v_old := jsonb_build_object('id', OLD.id, 'file_name', OLD.file_name, 'category', OLD.doc_category,
                                'size_bytes', OLD.size_bytes, 'sha256', OLD.sha256);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.owner_type = 'doc_check_request' THEN
    v_part_new := CASE NEW.doc_category WHEN 'doc_check_concept_agreement' THEN 'Понятийное соглашение'
                                        WHEN 'doc_check_chat' THEN 'Обсуждение' ELSE 'Загружаемые документы' END;
    v_new := jsonb_build_object('id', NEW.id, 'file_name', NEW.file_name, 'category', NEW.doc_category,
                                'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.doc_category IS DISTINCT FROM 'doc_check_chat' THEN
      PERFORM public.doc_check_history_write(NEW.owner_id, 'file_attached', 'file', NULL, v_new, v_part_new || ': ' || NEW.file_name);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.doc_category IS DISTINCT FROM 'doc_check_chat' THEN
      PERFORM public.doc_check_history_write(OLD.owner_id, 'file_removed', 'file', v_old, NULL, v_part_old || ': ' || OLD.file_name);
    END IF;
  ELSIF (OLD.owner_type, OLD.owner_id) IS DISTINCT FROM (NEW.owner_type, NEW.owner_id) THEN
    IF v_old IS NOT NULL THEN
      PERFORM public.doc_check_history_write(OLD.owner_id, 'file_removed', 'file', v_old, NULL, v_part_old || ': ' || OLD.file_name);
    END IF;
    IF v_new IS NOT NULL THEN
      PERFORM public.doc_check_history_write(NEW.owner_id, 'file_attached', 'file', NULL, v_new, v_part_new || ': ' || NEW.file_name);
    END IF;
  ELSIF v_new IS NOT NULL THEN
    IF NEW.doc_category IS DISTINCT FROM OLD.doc_category THEN
      PERFORM public.doc_check_history_write(NEW.owner_id, 'file_moved', 'file', v_old, v_new,
                                             NEW.file_name || ': ' || v_part_old || ' → ' || v_part_new);
    END IF;
    IF NEW.file_name IS DISTINCT FROM OLD.file_name THEN
      PERFORM public.doc_check_history_write(NEW.owner_id, 'file_renamed', 'file', v_old, v_new, OLD.file_name || ' → ' || NEW.file_name);
    END IF;
    -- Содержимое строки (ключ, размер, отпечаток) вошедший сменить не может (s3_documents_doc_check_guard); если это
    -- когда-нибудь случится — в истории будет видно.
    IF (NEW.s3_key, NEW.size_bytes, NEW.sha256) IS DISTINCT FROM (OLD.s3_key, OLD.size_bytes, OLD.sha256) THEN
      PERFORM public.doc_check_history_write(NEW.owner_id, 'file_replaced', 'file', v_old, v_new, v_part_new || ': ' || NEW.file_name);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS s3_documents_doc_check_history_ins ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_history_ins
  AFTER INSERT ON public.s3_documents
  FOR EACH ROW WHEN (NEW.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_history();
DROP TRIGGER IF EXISTS s3_documents_doc_check_history_upd ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_history_upd
  AFTER UPDATE ON public.s3_documents
  FOR EACH ROW WHEN (OLD.owner_type = 'doc_check_request' OR NEW.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_history();
DROP TRIGGER IF EXISTS s3_documents_doc_check_history_del ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_history_del
  AFTER DELETE ON public.s3_documents
  FOR EACH ROW WHEN (OLD.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_history();

-- ── 3. Файлы в обсуждении ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.doc_check_request_comments ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN public.doc_check_request_comments.attachments IS
  'Файлы сообщения: снимок строк s3_documents (id, имя, тип, размер, sha256, ключ) — собирает триггер, не страница';
-- Сообщение — текст, файлы или то и другое.
ALTER TABLE public.doc_check_request_comments DROP CONSTRAINT IF EXISTS doc_check_request_comments_body_check;
ALTER TABLE public.doc_check_request_comments ADD CONSTRAINT doc_check_request_comments_body_check
  CHECK (char_length(body) <= 4000 AND (char_length(body) >= 1 OR jsonb_array_length(attachments) > 0));
ALTER TABLE public.doc_check_request_comments DROP CONSTRAINT IF EXISTS doc_check_request_comments_attachments_check;
ALTER TABLE public.doc_check_request_comments ADD CONSTRAINT doc_check_request_comments_attachments_check
  CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20);

CREATE OR REPLACE FUNCTION public.doc_check_request_comments_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_list jsonb := CASE WHEN jsonb_typeof(NEW.attachments) = 'array' THEN NEW.attachments ELSE '[]'::jsonb END;
  v_ids uuid[];
  v_files jsonb := '[]'::jsonb;
  v_deleted timestamptz;
  d record;
BEGIN
  NEW.author_user_id := v_uid;
  NEW.author_name := (SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), ''))
                      FROM public.user_roles ur WHERE ur.user_id = NEW.author_user_id LIMIT 1);
  NEW.body := btrim(coalesce(NEW.body, ''));
  NEW.created_at := now();

  IF v_uid IS NOT NULL THEN
    SELECT r.deleted_at INTO v_deleted FROM public.doc_check_requests r WHERE r.id = NEW.request_id;
    IF v_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'Заявка удалена: обсуждение только для чтения' USING ERRCODE = '42501', HINT = 'doc_check_request_deleted';
    END IF;
  END IF;

  -- Вложения: страница присылает id файлов (строкой или {"id": …}); записывается снимок строки файла из базы. Файл — этой
  -- заявки, из обсуждения, загружен самим автором и ещё ни в одном сообщении (один файл — одно сообщение).
  SELECT coalesce(array_agg(x.id::uuid ORDER BY x.n), '{}') INTO v_ids
  FROM (SELECT CASE jsonb_typeof(e.v) WHEN 'string' THEN e.v #>> '{}' WHEN 'object' THEN e.v ->> 'id' END AS id, e.n
        FROM jsonb_array_elements(v_list) WITH ORDINALITY AS e(v, n)) x
  WHERE x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  FOR d IN
    SELECT s.id, s.owner_type, s.owner_id, s.doc_category, s.uploaded_by, s.file_name, s.mime_type, s.size_bytes, s.sha256, s.s3_key
    FROM unnest(v_ids) WITH ORDINALITY AS g(id, n)
    JOIN public.s3_documents s ON s.id = g.id
    ORDER BY g.n
  LOOP
    IF d.owner_type IS DISTINCT FROM 'doc_check_request' OR d.owner_id IS DISTINCT FROM NEW.request_id
       OR d.doc_category IS DISTINCT FROM 'doc_check_chat' OR (v_uid IS NOT NULL AND d.uploaded_by IS DISTINCT FROM v_uid) THEN
      RAISE EXCEPTION 'К сообщению прикладывается только свой файл этой заявки, загруженный для обсуждения'
        USING ERRCODE = '42501', HINT = 'doc_check_chat_file_foreign';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('doc_check_chat:' || d.id::text, 0));
    IF EXISTS (SELECT 1 FROM public.doc_check_request_comments c
               WHERE c.request_id = NEW.request_id AND c.attachments @> jsonb_build_array(jsonb_build_object('id', d.id))) THEN
      RAISE EXCEPTION 'Этот файл уже отправлен в обсуждении' USING ERRCODE = '23505', HINT = 'doc_check_chat_file_posted';
    END IF;
    v_files := v_files || jsonb_build_array(jsonb_build_object('id', d.id, 'file_name', d.file_name, 'mime_type', d.mime_type,
      'size_bytes', d.size_bytes, 'sha256', d.sha256, 's3_key', d.s3_key));
  END LOOP;
  IF jsonb_array_length(v_files) <> jsonb_array_length(v_list) THEN
    RAISE EXCEPTION 'Файл сообщения не найден — загрузите его заново' USING ERRCODE = 'P0002', HINT = 'doc_check_chat_file_missing';
  END IF;
  NEW.attachments := v_files;
  RETURN NEW;
END
$$;

-- Отправленные файлы — в историю заявки (кто и когда приложил).
CREATE OR REPLACE FUNCTION public.doc_check_request_comments_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  a jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  FOR a IN SELECT e FROM jsonb_array_elements(NEW.attachments) e LOOP
    PERFORM public.doc_check_history_write(NEW.request_id, 'file_attached', 'file', NULL,
      jsonb_build_object('id', a -> 'id', 'file_name', a -> 'file_name', 'category', 'doc_check_chat',
                         'size_bytes', a -> 'size_bytes', 'sha256', a -> 'sha256', 'comment_id', NEW.id),
      'Обсуждение: ' || (a ->> 'file_name'));
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_request_comments_history ON public.doc_check_request_comments;
CREATE TRIGGER doc_check_request_comments_history
  AFTER INSERT ON public.doc_check_request_comments
  FOR EACH ROW WHEN (jsonb_array_length(NEW.attachments) > 0)
  EXECUTE FUNCTION public.doc_check_request_comments_history();

-- Файлы заявок (тело 20270102 + файлы обсуждения и неизменность строки). Права вызывающего, как раньше.
CREATE OR REPLACE FUNCTION public.s3_documents_doc_check_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_detach boolean := TG_ARGV[0] = 'detach';
  v_owner uuid;
  v_status text;
  v_author uuid;
  v_deleted timestamptz;
  v_free constant text[] := ARRAY['file_name', 'notes', 'doc_category', 'owner_type', 'owner_id', 'updated_at'];
BEGIN
  IF auth.uid() IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Файл обсуждения: отправленный не меняется и не удаляется никем; свой черновик (сообщение не ушло) автор убрать может.
  IF TG_OP <> 'INSERT' AND OLD.owner_type = 'doc_check_request' AND OLD.doc_category = 'doc_check_chat' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Файл из обсуждения изменить нельзя: переписка хранится как есть'
        USING ERRCODE = '42501', HINT = 'doc_check_chat_file_locked';
    END IF;
    IF OLD.uploaded_by IS DISTINCT FROM auth.uid()
       OR NOT (public.osp_can('doc_check_requests', 'view') OR public.osp_can('doc_check_requests', 'edit'))
       OR NOT EXISTS (SELECT 1 FROM public.doc_check_requests r WHERE r.id = OLD.owner_id)
       OR EXISTS (SELECT 1 FROM public.doc_check_request_comments c
                  WHERE c.request_id = OLD.owner_id AND c.attachments @> jsonb_build_array(jsonb_build_object('id', OLD.id))) THEN
      RAISE EXCEPTION 'Файл из обсуждения удалить нельзя: переписка хранится как есть'
        USING ERRCODE = '42501', HINT = 'doc_check_chat_file_locked';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.owner_type = 'doc_check_request' AND NEW.doc_category = 'doc_check_chat' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Файл нельзя перенести в обсуждение — его прикладывают к сообщению'
        USING ERRCODE = '42501', HINT = 'doc_check_chat_file_locked';
    END IF;
    -- Новый файл обсуждения — кто видит раздел и заявку (как пишет сообщение); к удалённой заявке — нельзя.
    SELECT r.deleted_at INTO v_deleted FROM public.doc_check_requests r WHERE r.id = NEW.owner_id;
    IF NOT FOUND OR v_deleted IS NOT NULL
       OR NOT (public.osp_can('doc_check_requests', 'view') OR public.osp_can('doc_check_requests', 'edit')) THEN
      RAISE EXCEPTION 'Файл в обсуждение прикладывает сотрудник, который видит заявку'
        USING ERRCODE = '42501', HINT = 'doc_check_chat_file_write';
    END IF;
    NEW.uploaded_by := auth.uid();
    RETURN NEW;
  END IF;

  -- Строка файла заявки указывает на свой объект хранилища: ключ, размер, отпечаток и автор не меняются.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'У файла заявки можно изменить только имя и описание' USING ERRCODE = '42501', HINT = 's3_document_immutable';
  END IF;

  IF public.osp_can('doc_check_requests', 'edit')
     OR (TG_OP = 'UPDATE' AND v_detach
         AND (NEW.doc_category, NEW.owner_type, NEW.owner_id) IS NOT DISTINCT FROM (OLD.doc_category, OLD.owner_type, OLD.owner_id)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  v_owner := CASE WHEN v_detach THEN OLD.owner_id ELSE NEW.owner_id END;
  SELECT r.status, r.created_by, r.deleted_at INTO v_status, v_author, v_deleted
  FROM public.doc_check_requests r WHERE r.id = v_owner;
  IF FOUND AND v_author = auth.uid() AND v_status = 'new' AND v_deleted IS NULL
     AND public.osp_can('doc_check_requests_create', 'edit') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Файлы этой заявки на проверку меняет сотрудник с правом правки раздела'
    USING ERRCODE = '42501', HINT = 'doc_check_file_edit';
END
$$;

-- Триггеры файлов заявок — те же, что в 20270102 (пересоздаются, если её откатывали).
DROP TRIGGER IF EXISTS s3_documents_doc_check_attach ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_attach
  BEFORE INSERT OR UPDATE ON public.s3_documents
  FOR EACH ROW WHEN (NEW.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_guard('attach');
DROP TRIGGER IF EXISTS s3_documents_doc_check_detach ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_detach
  BEFORE DELETE OR UPDATE OF doc_category, owner_type, owner_id ON public.s3_documents
  FOR EACH ROW WHEN (OLD.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_guard('detach');

-- ── 4. «Прочитано» в обсуждении — у каждого своё ─────────────────────────────────────────────────────
-- Строка на сотрудника: since — всё, что написано раньше, прочитано (первый вход); seen — заявка → время (мс) самого позднего
-- показанного сообщения коллеги. Не больше 3000 отметок (самые давние уходят). Сообщение коллеги непрочитано, если оно позже
-- since, отметки заявки и своего последнего сообщения в ней.
CREATE TABLE IF NOT EXISTS public.doc_check_talk_reads (
  user_id uuid PRIMARY KEY,
  since timestamptz NOT NULL DEFAULT now(),
  seen jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_check_talk_reads_seen_check CHECK (jsonb_typeof(seen) = 'object')
);
COMMENT ON TABLE public.doc_check_talk_reads IS
  'Обсуждение заявок на проверку ДП/ДС: что прочитал сотрудник (своё у каждого); пишут только doc_check_talk_state / _mark';

-- Отметки из запроса: ключ — id заявки, значение — мс не позже p_now; не больше 3000 самых поздних.
CREATE OR REPLACE FUNCTION public.doc_check_talk_clean(p_seen jsonb, p_now bigint) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(x.k, x.v), '{}'::jsonb)
  FROM (SELECT e.key AS k, least(floor((e.value #>> '{}')::numeric), p_now)::bigint AS v
        FROM jsonb_each(CASE WHEN jsonb_typeof(p_seen) = 'object' THEN p_seen ELSE '{}'::jsonb END) e
        WHERE e.key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND jsonb_typeof(e.value) = 'number' AND (e.value #>> '{}')::numeric >= 0
        ORDER BY 2 DESC, 1
        LIMIT 3000) x
$$;

-- Отметки вошедшего: { since: мс, seen: { заявка: мс } }. Первый вызов заводит строку: граница — p_since (прежняя граница
-- браузера) или сейчас, отметки — p_seen (прежние отметки браузера); дальше они не меняют ничего.
CREATE OR REPLACE FUNCTION public.doc_check_talk_state(p_since bigint DEFAULT NULL, p_seen jsonb DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  r record;
BEGIN
  IF v_uid IS NULL OR NOT (public.osp_can('doc_check_requests', 'view') OR public.osp_can('doc_check_requests', 'edit')) THEN
    RAISE EXCEPTION 'Нет доступа к заявкам на проверку ДП/ДС' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.doc_check_talk_reads (user_id, since, seen)
  VALUES (v_uid, to_timestamp(least(greatest(coalesce(p_since, v_now), 0), v_now) / 1000.0),
          public.doc_check_talk_clean(p_seen, v_now))
  ON CONFLICT (user_id) DO NOTHING;
  SELECT t.since, t.seen INTO r FROM public.doc_check_talk_reads t WHERE t.user_id = v_uid;
  RETURN jsonb_build_object('since', floor(extract(epoch FROM r.since) * 1000)::bigint, 'seen', r.seen);
END
$$;

-- Сообщения коллег заявки показаны до p_at (мс) включительно: отметка растёт, назад не идёт, не позже «сейчас». Заявка — та,
-- что видна вошедшему (раздел и охват по объектам). Ответ — отметка заявки (мс); заявка не видна — NULL.
CREATE OR REPLACE FUNCTION public.doc_check_talk_mark(p_request uuid, p_at bigint) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  v_at bigint := least(greatest(coalesce(p_at, 0), 0), v_now);
  v_key text := p_request::text;
  v_scope uuid[];
  v_seen jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (public.osp_can('doc_check_requests', 'view') OR public.osp_can('doc_check_requests', 'edit')) THEN
    RAISE EXCEPTION 'Нет доступа к заявкам на проверку ДП/ДС' USING ERRCODE = '42501';
  END IF;
  v_scope := public.doc_check_scope();
  IF NOT EXISTS (SELECT 1 FROM public.doc_check_requests q
                 WHERE q.id = p_request AND (v_scope IS NULL OR q.object_id = ANY (v_scope))) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.doc_check_talk_reads AS t (user_id, since, seen)
  VALUES (v_uid, clock_timestamp(), jsonb_build_object(v_key, v_at))
  ON CONFLICT (user_id) DO UPDATE
    SET seen = t.seen || jsonb_build_object(v_key, greatest(v_at, coalesce((t.seen ->> v_key)::numeric, 0)::bigint)),
        updated_at = now()
  RETURNING t.seen INTO v_seen;
  IF (SELECT count(*) FROM jsonb_object_keys(v_seen)) > 3200 THEN
    UPDATE public.doc_check_talk_reads SET seen = public.doc_check_talk_clean(seen, v_now) WHERE user_id = v_uid;
  END IF;
  RETURN (v_seen ->> v_key)::bigint;
END
$$;

-- ── 5. Отпечаток объекта в хранилище ─────────────────────────────────────────────────────────────────
ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS content_etag text;
ALTER TABLE public.s3_documents DROP CONSTRAINT IF EXISTS s3_documents_content_etag_check;
ALTER TABLE public.s3_documents ADD CONSTRAINT s3_documents_content_etag_check
  CHECK (content_etag IS NULL OR char_length(content_etag) BETWEEN 1 AND 200);
COMMENT ON COLUMN public.s3_documents.content_etag IS
  'ETag объекта в хранилище при подтверждении загрузки (osp-api); скачивание файла заявки на проверку сверяет его с хранилищем';

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.doc_check_talk_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.doc_check_talk_reads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.doc_check_talk_reads TO service_role;

REVOKE ALL ON FUNCTION public.doc_check_requests_psdc_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_history_write(uuid, text, text, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_audit_log_server_only() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.doc_check_keep_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_requests_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.s3_documents_doc_check_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_request_comments_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_talk_clean(jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_talk_state(bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.doc_check_talk_state(bigint, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.doc_check_talk_mark(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.doc_check_talk_mark(uuid, bigint) TO authenticated, service_role;

COMMIT;
