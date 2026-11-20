-- След удалённого файла счёта / КП в расценке снабжением (просьба пользователя 19.11.2026: «когда убираю счёт, как снять
-- цены, которые из него проставлялись … и после удаления тоже»). Тело supabase/migrations/20270223_supply_removed_docs.sql:
-- та же таблица, триггеры и функция (тексты совпадают — сторожит tests/supply/migrations.test.mjs), иначе — только права
-- под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), пишет «Тендеры: редактирование» или «Тендеры на материалы: редактирование»
--    (supply_can_edit) — как цены и документы позиций;
--  • тендер на материалы «Завершён» — только чтение (тот же триггер закрытия, что у цен).
-- Цена связана с файлом только через документ позиции (tender_supply_links.s3_document_id, ON DELETE CASCADE): удалили файл —
-- связь пропала. Перед удалением страница записывает сюда цены, поставленные из файла: строка на цену (rate_id), id и имя
-- файла, цена за единицу на тот момент; окно «Счета и КП» по ним предлагает снять цены удалённого файла. Цену очистили —
-- строка уходит сама (ON DELETE CASCADE по rate_id); тендер следа — тендер цены (триггер). Файлы, удалённые до миграции,
-- следа не оставили. Только добавление, данные не меняются, повтор безопасен. Требует 20261020_supply_pricing.
-- Проверка — 20270223_supply_removed_docs.check.sql, для прода — migration/backup/checks/20270223.sql; откат —
-- migration/rollback/20270223_supply_removed_docs_rollback.sql.

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

-- ── Права под одну учётку ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_removed_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_removed_docs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_supply_removed_docs;
CREATE POLICY osp_internal ON public.tender_supply_removed_docs FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS supply_removed_docs_read ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_read ON public.tender_supply_removed_docs FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS supply_removed_docs_insert ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_insert ON public.tender_supply_removed_docs FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_removed_docs_update ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_update ON public.tender_supply_removed_docs FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_removed_docs_delete ON public.tender_supply_removed_docs;
CREATE POLICY supply_removed_docs_delete ON public.tender_supply_removed_docs FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_supply_removed_docs', 'supply_removed_docs_read', ARRAY['authenticated']),
  ('public', 'tender_supply_removed_docs', 'supply_removed_docs_insert', ARRAY['authenticated']),
  ('public', 'tender_supply_removed_docs', 'supply_removed_docs_update', ARRAY['authenticated']),
  ('public', 'tender_supply_removed_docs', 'supply_removed_docs_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_supply_removed_docs authenticated=select,insert,update,delete
