-- Шаблоны разделов: «Понятийное соглашение» в «Документах раздела» тендеров и «Шаблон Было-Стало» в «Документах»
-- заявок на ДС. Тело supabase/migrations/20261107_section_templates.sql: та же таблица-якорь и те же два шаблона,
-- иначе — только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), писать некому — строки заводят миграции.
-- Файл шаблона — s3_documents (owner_type 'general', doc_category 'section_template'); прикрепить и удалить его
-- может только администратор — проверяет osp-api (WRITE_RULES.section_templates).
-- Только добавление, повтор безопасен.

CREATE TABLE IF NOT EXISTS public.section_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.section_templates IS
  'Шаблоны разделов: якорь для файла (s3_documents owner_type general, doc_category section_template); строки заводят миграции';
COMMENT ON COLUMN public.section_templates.code IS
  'Постоянный код шаблона в коде страницы: tenders_concept_agreement, dc_was_became';

-- ── Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.section_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.section_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.section_templates;
CREATE POLICY osp_internal ON public.section_templates FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS section_templates_read ON public.section_templates;
CREATE POLICY section_templates_read ON public.section_templates FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'section_templates', 'section_templates_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table section_templates authenticated=select

-- ── Шаблоны ──────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.section_templates (code, title) VALUES
  ('tenders_concept_agreement', 'Понятийное соглашение'),
  ('dc_was_became', 'Шаблон Было-Стало')
ON CONFLICT (code) DO NOTHING;
