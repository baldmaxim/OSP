-- «Планы затрат» и «Общая информация → Отделы» → «Документы» → «Экономисты ОСП»: кто из экономистов ОСП отвечает
-- за планы затрат объекта. Новому тендеру основного строительства этот экономист сразу ставится ответственным
-- за план затрат (tenders.cost_plan_responsible_id — форма тендера подставляет его по объекту, сменить можно там
-- же, в «Планах затрат» и в карточке тендера). Уже созданные тендеры не меняются.
--
--  • cost_plan_economists — строка = объект (одна на объект) + сотрудник из справочника contacts (тот же
--    справочник, что у ответственного за план затрат); удаление объекта или сотрудника удаляет и назначение.
--    Кто и когда изменил — триггером.
--  • Права: читает сотрудник, назначает только администратор (is_admin()).
--  • Начальное назначение (решение пользователя 27.10) — по id объектов и сотрудников справочника: ФИО в
--    репозитории не храним. Нет объекта или сотрудника в базе — строка пропускается, её назначит администратор.
--    Уже назначенное не перезаписывается.
--
-- Только добавление, повтор безопасен. Пока миграции нет, вкладка подсказывает про обновление базы, а форма
-- тендера ничего не подставляет. База нового портала — migration/yandex/20261110_cost_plan_economists.sql.
-- Проверка: migration/backup/checks/20261110.sql, откат — migration/rollback/20261110_cost_plan_economists_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cost_plan_economists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_plan_economists_read ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_read ON public.cost_plan_economists FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS cost_plan_economists_insert ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_insert ON public.cost_plan_economists FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS cost_plan_economists_update ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_update ON public.cost_plan_economists FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS cost_plan_economists_delete ON public.cost_plan_economists;
CREATE POLICY cost_plan_economists_delete ON public.cost_plan_economists FOR DELETE TO authenticated
  USING ((SELECT public.is_admin()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.cost_plan_economists FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cost_plan_economists TO authenticated;
GRANT ALL ON TABLE public.cost_plan_economists TO service_role;
REVOKE ALL ON FUNCTION public.cost_plan_economists_touch() FROM PUBLIC, anon;

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

COMMIT;
