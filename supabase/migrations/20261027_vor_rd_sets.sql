-- «ВОРы и РД»: комплекты РД тендера или заявки на ВОР — список, раскрывающийся под строкой по нажатию.
--
--  • vor_rd_sets — строка = комплект РД: название (вписывается вручную), «ВОР готов» (да / нет), срок
--    выдачи ВОРа, ссылка на РД и ВОР, примечание. № п/п не хранится — это порядковый номер в списке
--    (sort_order, затем дата создания), после удаления строки нумерация сдвигается сама.
--  • Владелец — тендер (tender_id) или заявка на ВОР без тендера (vor_request_id), ровно один; удаление
--    тендера или заявки удаляет и комплекты.
--  • Ссылка — http(s) или сетевой путь \\сервер\папка; кто и когда изменил — триггером.
--  • Права — как у остальных полей раздела: читает сотрудник, пишет право правки «Тендеры» или «ВОРы и РД»
--    (vor_rd_can_edit = canEdit('tenders') || canEdit('vors') на странице).
--
-- Только добавление, повтор безопасен. Пока миграции нет, страница показывает в раскрытой строке, что
-- список появится после обновления базы. База нового портала — migration/yandex/20261027_vor_rd_sets.sql.
-- Проверка: migration/backup/checks/20261027.sql, откат — migration/rollback/20261027_vor_rd_sets_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

-- Пробелы по краям не храним, пустые ссылка и примечание — NULL; кто и когда изменил.
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

-- Может ли вошедший править комплекты (как canEdit('tenders') || canEdit('vors') на странице).
CREATE OR REPLACE FUNCTION public.vor_rd_can_edit() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT public.osp_can('tenders', 'edit') OR public.osp_can('vors', 'edit')
$$;

-- ── 2. Права ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.vor_rd_sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vor_rd_sets_read ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_read ON public.vor_rd_sets FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS vor_rd_sets_insert ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_insert ON public.vor_rd_sets FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.vor_rd_can_edit()));
DROP POLICY IF EXISTS vor_rd_sets_update ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_update ON public.vor_rd_sets FOR UPDATE TO authenticated
  USING ((SELECT public.vor_rd_can_edit())) WITH CHECK ((SELECT public.vor_rd_can_edit()));
DROP POLICY IF EXISTS vor_rd_sets_delete ON public.vor_rd_sets;
CREATE POLICY vor_rd_sets_delete ON public.vor_rd_sets FOR DELETE TO authenticated
  USING ((SELECT public.vor_rd_can_edit()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.vor_rd_sets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vor_rd_sets TO authenticated;
GRANT ALL ON TABLE public.vor_rd_sets TO service_role;
REVOKE ALL ON FUNCTION public.vor_rd_sets_touch() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.vor_rd_can_edit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vor_rd_can_edit() TO authenticated, service_role;

COMMIT;
