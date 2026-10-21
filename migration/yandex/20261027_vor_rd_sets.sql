-- «ВОРы и РД»: комплекты РД тендера или заявки на ВОР — список, раскрывающийся под строкой по нажатию.
-- Тело supabase/migrations/20261027_vor_rd_sets.sql: та же таблица, триггер и функция, иначе — только права
-- под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), пишет «Тендеры: редактирование» или «ВОРы и РД: редактирование»
--    (vor_rd_can_edit) — как статус, срок и ответственного на той же странице.
-- № п/п не хранится — порядковый номер в списке. Владелец — тендер или заявка на ВОР, ровно один; удаление
-- владельца удаляет комплекты. Повтор безопасен.

-- ── 1. Комплекты РД ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vor_rd_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid REFERENCES public.tenders(id) ON DELETE CASCADE,
  vor_request_id uuid REFERENCES public.vor_requests(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  rd_set text NOT NULL DEFAULT '' CHECK (length(rd_set) <= 500),
  vor_ready boolean NOT NULL DEFAULT false,
  vor_due_date date,
  link text CHECK (link IS NULL OR (length(link) <= 2000 AND link ~* '^(https?://\S|\\\\\S)')),
  note text CHECK (note IS NULL OR length(note) <= 4000),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vor_rd_sets_owner_check CHECK (num_nonnulls(tender_id, vor_request_id) = 1)
);
COMMENT ON TABLE public.vor_rd_sets IS
  'Комплекты РД тендера или заявки на ВОР (раздел «ВОРы и РД»): название, ВОР готов, срок выдачи ВОРа, ссылка, примечание';
COMMENT ON COLUMN public.vor_rd_sets.sort_order IS 'Порядок в списке; № п/п на странице — порядковый номер, не хранится';
COMMENT ON COLUMN public.vor_rd_sets.vor_due_date IS 'Срок выдачи ВОРа по комплекту';
COMMENT ON COLUMN public.vor_rd_sets.link IS 'Ссылка на РД и ВОР: адрес http(s) или сетевой путь \\сервер\папка';

CREATE INDEX IF NOT EXISTS vor_rd_sets_tender_idx ON public.vor_rd_sets (tender_id, sort_order) WHERE tender_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vor_rd_sets_request_idx ON public.vor_rd_sets (vor_request_id, sort_order) WHERE vor_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.vor_rd_sets_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.rd_set := btrim(coalesce(NEW.rd_set, ''));
  NEW.link := nullif(btrim(NEW.link), '');
  NEW.note := nullif(btrim(NEW.note), '');
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS vor_rd_sets_touch ON public.vor_rd_sets;
CREATE TRIGGER vor_rd_sets_touch
  BEFORE INSERT OR UPDATE ON public.vor_rd_sets
  FOR EACH ROW EXECUTE FUNCTION public.vor_rd_sets_touch();

CREATE OR REPLACE FUNCTION public.vor_rd_can_edit() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT public.osp_can('tenders', 'edit') OR public.osp_can('vors', 'edit')
$$;

-- ── 2. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.vor_rd_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vor_rd_sets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.vor_rd_sets;
CREATE POLICY osp_internal ON public.vor_rd_sets FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS vor_rd_sets_read ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_read ON public.vor_rd_sets FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS vor_rd_sets_insert ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_insert ON public.vor_rd_sets FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.vor_rd_can_edit())) END);
DROP POLICY IF EXISTS vor_rd_sets_update ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_update ON public.vor_rd_sets FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.vor_rd_can_edit())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.vor_rd_can_edit())) END);
DROP POLICY IF EXISTS vor_rd_sets_delete ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_delete ON public.vor_rd_sets FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.vor_rd_can_edit())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'vor_rd_sets', 'vor_rd_sets_read', ARRAY['authenticated']),
  ('public', 'vor_rd_sets', 'vor_rd_sets_insert', ARRAY['authenticated']),
  ('public', 'vor_rd_sets', 'vor_rd_sets_update', ARRAY['authenticated']),
  ('public', 'vor_rd_sets', 'vor_rd_sets_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table vor_rd_sets authenticated=select,insert,update,delete
