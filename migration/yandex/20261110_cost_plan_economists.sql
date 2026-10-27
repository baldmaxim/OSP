-- «Планы затрат» и «Общая информация → Отделы» → «Документы» → «Экономисты ОСП»: экономист ОСП по объекту —
-- ответственный за планы затрат; новому тендеру основного строительства форма тендера подставляет его в
-- tenders.cost_plan_responsible_id. Тело supabase/migrations/20261110_cost_plan_economists.sql: та же таблица,
-- триггер и начальное назначение, иначе — только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), назначает только администратор (is_admin).
-- Начальное назначение — по id объектов и сотрудников справочника (ФИО в репозитории не храним); нет объекта или
-- сотрудника — строка пропускается, уже назначенное не перезаписывается. Повтор безопасен.

CREATE TABLE IF NOT EXISTS public.cost_plan_economists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_plan_economists_object_key UNIQUE (object_id)
);
CREATE INDEX IF NOT EXISTS cost_plan_economists_contact_idx ON public.cost_plan_economists (contact_id);
COMMENT ON TABLE public.cost_plan_economists IS
  'Экономист ОСП по объекту — ответственный за планы затрат; новому тендеру основного строительства подставляется в cost_plan_responsible_id';

CREATE OR REPLACE FUNCTION public.cost_plan_economists_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cost_plan_economists_touch ON public.cost_plan_economists;
CREATE TRIGGER cost_plan_economists_touch
  BEFORE INSERT OR UPDATE ON public.cost_plan_economists
  FOR EACH ROW EXECUTE FUNCTION public.cost_plan_economists_touch();

-- ── Права под одну учётку ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cost_plan_economists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_plan_economists FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.cost_plan_economists;
CREATE POLICY osp_internal ON public.cost_plan_economists FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS cost_plan_economists_read ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_read ON public.cost_plan_economists FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS cost_plan_economists_insert ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_insert ON public.cost_plan_economists FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);
DROP POLICY IF EXISTS cost_plan_economists_update ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_update ON public.cost_plan_economists FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);
DROP POLICY IF EXISTS cost_plan_economists_delete ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_delete ON public.cost_plan_economists FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'cost_plan_economists', 'cost_plan_economists_read', ARRAY['authenticated']),
  ('public', 'cost_plan_economists', 'cost_plan_economists_insert', ARRAY['authenticated']),
  ('public', 'cost_plan_economists', 'cost_plan_economists_update', ARRAY['authenticated']),
  ('public', 'cost_plan_economists', 'cost_plan_economists_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table cost_plan_economists authenticated=select,insert,update,delete

-- ── Начальное назначение ─────────────────────────────────────────────────────────────────────────────
-- Три экономиста ОСП: первый — 4 объекта, второй — 3, третий — 2.
INSERT INTO public.cost_plan_economists (object_id, contact_id)
SELECT v.object_id, v.contact_id
FROM (VALUES
  ('1fb5f7cf-f2ab-4dff-9dd1-f78a127cf071'::uuid, '35a2b27f-14c4-4063-bde0-6ba780802720'::uuid), -- ЖК ЗИЛ 33
  ('1fd91c8f-7380-4f61-8e30-c79564bea922'::uuid, '35a2b27f-14c4-4063-bde0-6ba780802720'::uuid), -- ЖК King & Sons
  ('cb878fd0-9069-4f6b-99bf-ce5179b82656'::uuid, '35a2b27f-14c4-4063-bde0-6ba780802720'::uuid), -- ЖК Алия
  ('c47b4d0a-57f4-4e78-9bdf-82e2b66327da'::uuid, '35a2b27f-14c4-4063-bde0-6ba780802720'::uuid), -- ЖК Дом 56
  ('092f3657-ebb4-43dd-a0b5-7e762b78a017'::uuid, 'e7d0406d-f8b2-4ddc-a2cc-ebf0fcf70c32'::uuid), -- ЖК INJOY
  ('7d9e4296-0f8f-4e61-b217-deaf9ab6b3c0'::uuid, 'e7d0406d-f8b2-4ddc-a2cc-ebf0fcf70c32'::uuid), -- ЖК Primavera к14
  ('a5e5c0f6-0711-459f-987d-bd4b4b1d7b1a'::uuid, 'e7d0406d-f8b2-4ddc-a2cc-ebf0fcf70c32'::uuid), -- Событие 6.1
  ('b36691aa-3be5-4be1-9d95-51b66da602e1'::uuid, '5a52f864-c4b2-4df6-b3bf-249d6ef4b38e'::uuid), -- Событие 6.2
  ('81d0d58c-f41c-4e82-97c9-20dee23080a4'::uuid, '5a52f864-c4b2-4df6-b3bf-249d6ef4b38e'::uuid)  -- ЖК ЗИЛ 31
) AS v(object_id, contact_id)
JOIN public.objects o ON o.id = v.object_id
JOIN public.contacts c ON c.id = v.contact_id
ON CONFLICT ON CONSTRAINT cost_plan_economists_object_key DO NOTHING;
