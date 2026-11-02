-- «Заявки на проверку ДП/ДС»: то, чего не хватало карточке заявки — обсуждение, шаги, ссылка на письмо, исполнители без
-- учётной записи. Тело supabase/migrations/20261124_doc_check_card.sql: те же колонки, таблицы и триггеры, иначе — только
-- права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • обсуждение: читает и пишет, кто видит раздел; правки и удаления сообщений нет (ни правил, ни списка шлюза);
--  • шаги: читает, кто видит раздел; добавляет, переименовывает, удаляет, переставляет право правки раздела; отметить шаг
--    может ещё и исполнитель заявки (остальное ему закрывает триггер).
-- Только добавление, повтор безопасен.

ALTER TABLE public.doc_check_requests
  ADD COLUMN IF NOT EXISTS assignee_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS email_link text,
  ADD COLUMN IF NOT EXISTS manual_assignees text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_email_link_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_email_link_check
  CHECK (email_link IS NULL OR (char_length(email_link) <= 2000 AND email_link ~* '^https?://[^[:space:]]+$'));

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_manual_assignees_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_manual_assignees_check
  CHECK (cardinality(manual_assignees) <= 20);

COMMENT ON COLUMN public.doc_check_requests.email_link IS 'Ссылка на письмо по заявке: адрес http(s)';
COMMENT ON COLUMN public.doc_check_requests.manual_assignees IS 'Исполнители без учётной записи: имена текстом, до 20';

-- ── Обсуждение ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.doc_check_request_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.doc_check_requests(id) ON DELETE CASCADE,
  author_user_id uuid,
  author_name text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_check_request_comments_body_check CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX IF NOT EXISTS doc_check_request_comments_request_idx ON public.doc_check_request_comments (request_id, created_at);
COMMENT ON TABLE public.doc_check_request_comments IS 'Обсуждение заявки на проверку ДП/ДС: сообщения только добавляются';
COMMENT ON COLUMN public.doc_check_request_comments.author_name IS 'Автор: ФИО (иначе почта) на момент сообщения, ставит триггер';

CREATE OR REPLACE FUNCTION public.doc_check_request_comments_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.author_user_id := auth.uid();
  NEW.author_name := (SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), ''))
                      FROM public.user_roles ur WHERE ur.user_id = NEW.author_user_id LIMIT 1);
  NEW.body := btrim(NEW.body);
  NEW.created_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS doc_check_request_comments_stamp ON public.doc_check_request_comments;
CREATE TRIGGER doc_check_request_comments_stamp
  BEFORE INSERT ON public.doc_check_request_comments
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_request_comments_stamp();

-- ── Шаги ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.doc_check_request_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.doc_check_requests(id) ON DELETE CASCADE,
  title text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_check_request_steps_title_check CHECK (char_length(title) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS doc_check_request_steps_request_idx ON public.doc_check_request_steps (request_id, sort_order);
COMMENT ON TABLE public.doc_check_request_steps IS 'Шаги (чек-лист) заявки на проверку ДП/ДС';

CREATE OR REPLACE FUNCTION public.doc_check_request_steps_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  IF TG_OP = 'UPDATE' THEN
    NEW.request_id := OLD.request_id;
    NEW.created_at := OLD.created_at;
    IF auth.uid() IS NOT NULL
       AND (NEW.title, NEW.sort_order) IS DISTINCT FROM (OLD.title, OLD.sort_order)
       AND NOT public.osp_can('doc_check_requests', 'edit') THEN
      RAISE EXCEPTION 'Шаг меняет сотрудник с правом правки раздела: исполнитель только отмечает выполнение'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS doc_check_request_steps_guard ON public.doc_check_request_steps;
CREATE TRIGGER doc_check_request_steps_guard
  BEFORE INSERT OR UPDATE ON public.doc_check_request_steps
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_request_steps_guard();

-- ── Права под одну учётку ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.doc_check_request_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_check_request_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON public.doc_check_request_comments;
CREATE POLICY osp_internal ON public.doc_check_request_comments FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS doc_check_request_comments_read ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_read ON public.doc_check_request_comments FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'view'))) END);
DROP POLICY IF EXISTS doc_check_request_comments_insert ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_insert ON public.doc_check_request_comments FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'view'))) END);

ALTER TABLE public.doc_check_request_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_check_request_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON public.doc_check_request_steps;
CREATE POLICY osp_internal ON public.doc_check_request_steps FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS doc_check_request_steps_read ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_read ON public.doc_check_request_steps FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'view'))) END);
DROP POLICY IF EXISTS doc_check_request_steps_insert ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_insert ON public.doc_check_request_steps FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'edit'))) END);
DROP POLICY IF EXISTS doc_check_request_steps_update ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_update ON public.doc_check_request_steps FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_can('doc_check_requests', 'edit'))
                         OR ((SELECT public.osp_can('doc_check_requests', 'view'))
                             AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                                         WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated'))
                         AND ((SELECT public.osp_can('doc_check_requests', 'edit'))
                              OR ((SELECT public.osp_can('doc_check_requests', 'view'))
                                  AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                                              WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))) END);
DROP POLICY IF EXISTS doc_check_request_steps_delete ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_delete ON public.doc_check_request_steps FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'edit'))) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'doc_check_request_comments', 'doc_check_request_comments_read', ARRAY['authenticated']),
  ('public', 'doc_check_request_comments', 'doc_check_request_comments_insert', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_read', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_insert', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_update', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table doc_check_request_comments authenticated=select,insert
-- osp:allow table doc_check_request_steps authenticated=select,insert,update,delete
