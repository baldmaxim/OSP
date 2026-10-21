-- «Тендеры — Основное строительство» → «Документы раздела» → «Контакт площадки»: подразделение «Отделка» и
-- контакты площадки по объекту и подразделению ВОР (ФИО, телефон, Telegram — в письме подрядчикам).
-- Тело supabase/migrations/20261030_site_contacts.sql: те же ограничения, таблица и триггер, иначе — только
-- права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), назначает только администратор (is_admin).
-- CHECK подразделения — шире прежнего, данные не меняются. Повтор безопасен.

-- ── 1. Подразделение «Отделка» ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS valid_vor_division;
ALTER TABLE public.tenders ADD CONSTRAINT valid_vor_division
  CHECK (vor_division IS NULL OR vor_division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));
COMMENT ON COLUMN public.tenders.vor_division IS
  'Подразделение ВОР: monolith (Монолит) | nvf_spk (НВФ, СПК) | general (Общестроительные работы) | hvac_water (ОВ, ВК) | electrical (ЭОМ, СС) | finishing (Отделка)';

ALTER TABLE public.vor_requests DROP CONSTRAINT IF EXISTS vor_requests_division_check;
ALTER TABLE public.vor_requests ADD CONSTRAINT vor_requests_division_check
  CHECK (vor_division IS NULL OR vor_division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));

-- ── 2. Контакты площадки ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.object_site_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  division text NOT NULL
    CHECK (division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing')),
  full_name text NOT NULL CHECK (full_name <> '' AND length(full_name) <= 200),
  phone text NOT NULL CHECK (phone <> '' AND length(phone) <= 100),
  telegram text CHECK (telegram IS NULL OR length(telegram) <= 200),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT object_site_contacts_object_division_key UNIQUE (object_id, division)
);
COMMENT ON TABLE public.object_site_contacts IS
  'Контакт площадки по объекту и подразделению ВОР («Документы раздела» тендеров): ФИО, телефон, Telegram — в письме подрядчикам';
COMMENT ON COLUMN public.object_site_contacts.division IS 'Подразделение ВОР — те же коды, что tenders.vor_division';
COMMENT ON COLUMN public.object_site_contacts.telegram IS 'Telegram: @имя, ссылка t.me или номер — как ввёл администратор';

CREATE OR REPLACE FUNCTION public.object_site_contacts_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.full_name := btrim(coalesce(NEW.full_name, ''));
  NEW.phone := btrim(coalesce(NEW.phone, ''));
  NEW.telegram := nullif(btrim(NEW.telegram), '');
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS object_site_contacts_touch ON public.object_site_contacts;
CREATE TRIGGER object_site_contacts_touch
  BEFORE INSERT OR UPDATE ON public.object_site_contacts
  FOR EACH ROW EXECUTE FUNCTION public.object_site_contacts_touch();

-- ── 3. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.object_site_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_site_contacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.object_site_contacts;
CREATE POLICY osp_internal ON public.object_site_contacts FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS object_site_contacts_read ON public.object_site_contacts;
CREATE POLICY object_site_contacts_read ON public.object_site_contacts FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS object_site_contacts_insert ON public.object_site_contacts;
CREATE POLICY object_site_contacts_insert ON public.object_site_contacts FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);
DROP POLICY IF EXISTS object_site_contacts_update ON public.object_site_contacts;
CREATE POLICY object_site_contacts_update ON public.object_site_contacts FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);
DROP POLICY IF EXISTS object_site_contacts_delete ON public.object_site_contacts;
CREATE POLICY object_site_contacts_delete ON public.object_site_contacts FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'object_site_contacts', 'object_site_contacts_read', ARRAY['authenticated']),
  ('public', 'object_site_contacts', 'object_site_contacts_insert', ARRAY['authenticated']),
  ('public', 'object_site_contacts', 'object_site_contacts_update', ARRAY['authenticated']),
  ('public', 'object_site_contacts', 'object_site_contacts_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table object_site_contacts authenticated=select,insert,update,delete
