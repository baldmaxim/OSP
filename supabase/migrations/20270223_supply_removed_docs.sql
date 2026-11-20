-- След удалённого файла счёта / КП в расценке снабжением (просьба пользователя 19.11.2026: «когда убираю счёт, как снять
-- цены, которые из него проставлялись … и после удаления тоже»).
--
--  • Цена связана с файлом только через документ позиции (tender_supply_links.s3_document_id, ON DELETE CASCADE): удалили
--    файл — связь пропала, и его цены не отличить от введённых вручную. Поэтому перед удалением файла страница записывает,
--    какие цены поставлены из него: tender_supply_removed_docs — строка на цену (rate_id), id и имя удалённого файла, цена за
--    единицу на тот момент. Позже по этим строкам окно «Счета и КП» предлагает снять цены удалённого файла.
--  • След живёт, пока жива цена: цену очистили — строка уходит сама (ON DELETE CASCADE по rate_id); перенос ВОР на другое
--    имя и новая версия ВОР его не задевают (ссылка — на строку цены, а не на имя). Одна цена — один след (последний
--    удалённый файл). Цену после удаления правили — страница след не показывает (сравнивает цену за единицу).
--  • Тендер следа — тендер цены (триггер берёт его у цены). Права — как у цен и документов позиций: читает сотрудник, пишет
--    «Тендеры» или «Тендеры на материалы» с правкой; тендер на материалы «Завершён» — только чтение (tender_supply_guard).
--  • Файлы, удалённые до миграции, следа не оставили: их цены так и остаются обычными ценами.
--
-- Только добавление, данные не меняются, повтор безопасен. База нового портала — migration/yandex/20270223_supply_removed_docs.sql
-- (те же объекты, права под одну учётку). Требует 20261020_supply_pricing. Проверка: migration/backup/checks/20270223.sql,
-- откат: migration/rollback/20270223_supply_removed_docs_rollback.sql. Без миграции страница работает как раньше: цены файла можно
-- снять только в момент его удаления.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.tender_supply_removed_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  rate_id uuid NOT NULL REFERENCES public.tender_vor_supply_rates(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL,
  doc_name text NOT NULL CHECK (btrim(doc_name) <> '' AND length(doc_name) <= 500),
  price numeric NOT NULL CHECK (price >= 0),
  removed_by uuid,
  removed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_id)
);
CREATE INDEX IF NOT EXISTS tender_supply_removed_docs_tender_idx ON public.tender_supply_removed_docs (tender_id);
COMMENT ON TABLE public.tender_supply_removed_docs IS
  'След удалённого файла счёта / КП: цена расценки снабжением, поставленная из него (чтобы её можно было снять после удаления файла)';
COMMENT ON COLUMN public.tender_supply_removed_docs.doc_id IS 'id удалённого файла (строки s3_documents уже нет — без внешнего ключа)';
COMMENT ON COLUMN public.tender_supply_removed_docs.price IS 'Цена за единицу на момент удаления файла: след жив, пока цена та же';

CREATE OR REPLACE FUNCTION public.tender_supply_removed_docs_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.doc_name := btrim(NEW.doc_name);
  NEW.tender_id := coalesce((SELECT r.tender_id FROM public.tender_vor_supply_rates r WHERE r.id = NEW.rate_id), NEW.tender_id);
  NEW.removed_by := auth.uid();
  NEW.removed_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_removed_docs_touch ON public.tender_supply_removed_docs;
CREATE TRIGGER tender_supply_removed_docs_touch
  BEFORE INSERT OR UPDATE ON public.tender_supply_removed_docs
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_removed_docs_touch();

DROP TRIGGER IF EXISTS tender_supply_removed_docs_guard ON public.tender_supply_removed_docs;
CREATE TRIGGER tender_supply_removed_docs_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_removed_docs
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

ALTER TABLE public.tender_supply_removed_docs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_removed_docs_read ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_read ON public.tender_supply_removed_docs FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS supply_removed_docs_insert ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_insert ON public.tender_supply_removed_docs FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_removed_docs_update ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_update ON public.tender_supply_removed_docs FOR UPDATE TO authenticated
  USING ((SELECT public.supply_can_edit())) WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_removed_docs_delete ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_delete ON public.tender_supply_removed_docs FOR DELETE TO authenticated
  USING ((SELECT public.supply_can_edit()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.tender_supply_removed_docs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tender_supply_removed_docs TO authenticated;
GRANT ALL ON TABLE public.tender_supply_removed_docs TO service_role;
REVOKE ALL ON FUNCTION public.tender_supply_removed_docs_touch() FROM PUBLIC, anon;

COMMIT;
