-- Комментарий к расценке позиции снабжением (колонка «Комментарий» справа в таблице расценки: вкладка «Расценки
-- снабжения» карточки и страница /tenders/materials/:id/pricing; просьба пользователя 09.11.2026).
--
--  • tender_supply_comments — один комментарий на позицию основного тендера: (tender_id, ключ наименования
--    material_key = supply_norm_name(material_name)), как у цен, но без имени ВОР: в таблице одна строка на позицию,
--    сложенную из всех ВОР, и цена пишется во все её ВОР — комментарий у позиции один на тендер. Поэтому перенос ВОР
--    на другое имя и новая версия ВОР его не задевают. Комментарий живёт отдельно от цены (как документ позиции):
--    его можно написать до цены, и он остаётся, если цену очистили. Пустой не хранится — строка удаляется.
--  • Права — как у цен и документов: читает сотрудник, пишет «Тендеры» или «Тендеры на материалы» с правкой; тендер
--    на материалы «Завершён» — только чтение (тот же триггер закрытия tender_supply_guard). Кто и когда — триггером.
--
-- Только добавление, повтор безопасен. База нового портала — migration/yandex/20270105_supply_rate_comments.sql
-- (те же объекты, права под одну учётку). Требует 20261020_supply_pricing.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tender_supply_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  material_name text NOT NULL CHECK (btrim(material_name) <> ''),
  material_key text GENERATED ALWAYS AS (public.supply_norm_name(material_name)) STORED,
  comment text NOT NULL CHECK (btrim(comment) <> '' AND length(comment) <= 2000),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, material_key)
);
COMMENT ON TABLE public.tender_supply_comments IS
  'Комментарий к расценке позиции снабжением: основной тендер и ключ наименования (одна строка на позицию всех ВОР)';

CREATE OR REPLACE FUNCTION public.tender_supply_comments_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.comment := btrim(NEW.comment);
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_comments_touch ON public.tender_supply_comments;
CREATE TRIGGER tender_supply_comments_touch
  BEFORE INSERT OR UPDATE ON public.tender_supply_comments
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_comments_touch();

DROP TRIGGER IF EXISTS tender_supply_comments_guard ON public.tender_supply_comments;
CREATE TRIGGER tender_supply_comments_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_comments
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

ALTER TABLE public.tender_supply_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_comments_read ON public.tender_supply_comments;
CREATE POLICY supply_comments_read ON public.tender_supply_comments FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS supply_comments_insert ON public.tender_supply_comments;
CREATE POLICY supply_comments_insert ON public.tender_supply_comments FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_comments_update ON public.tender_supply_comments;
CREATE POLICY supply_comments_update ON public.tender_supply_comments FOR UPDATE TO authenticated
  USING ((SELECT public.supply_can_edit())) WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_comments_delete ON public.tender_supply_comments;
CREATE POLICY supply_comments_delete ON public.tender_supply_comments FOR DELETE TO authenticated
  USING ((SELECT public.supply_can_edit()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.tender_supply_comments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tender_supply_comments TO authenticated;
GRANT ALL ON TABLE public.tender_supply_comments TO service_role;
REVOKE ALL ON FUNCTION public.tender_supply_comments_touch() FROM PUBLIC, anon;

COMMIT;
