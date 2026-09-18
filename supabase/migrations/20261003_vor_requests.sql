-- «ВОРы и РД»: заявка на подготовку ВОР без привязки к тендеру.
--
-- ВОР готовят не только под объявленный тендер: бывает, что тендера ещё нет
-- (готовятся заранее) или он не нужен вовсе. Раньше такую работу было не завести:
-- поля ВОР живут прямо в tenders. Отдельная таблица с теми же полями, что у
-- тендера (статус, подразделение, ответственный СТО, срок, ссылка) — страница
-- «ВОРы и РД» показывает заявки в общем списке с пометкой «Заявка №…».
--
-- Начало срока подготовки — дата создания заявки (как у тендеров — дата создания
-- тендера), поэтому отдельного поля начала нет.
-- Файлы заявки — s3_documents с owner_type='general', owner_id=id заявки,
-- doc_category 'vor_request_rd' / 'vor_request_vor' (редеплой s3-presign не нужен).
-- tender_id — на будущее: привязать заявку к тендеру, когда он появится.
--
-- Миграция идемпотентна.

CREATE SEQUENCE IF NOT EXISTS public.vor_requests_number_seq;

CREATE TABLE IF NOT EXISTS public.vor_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number INTEGER NOT NULL DEFAULT nextval('public.vor_requests_number_seq') UNIQUE,
  department TEXT NOT NULL DEFAULT 'construction',
  object_id UUID REFERENCES public.objects(id) ON DELETE SET NULL,
  work_description TEXT NOT NULL,
  notes TEXT,
  vor_status TEXT NOT NULL DEFAULT 'not_started',
  vor_division TEXT,
  vor_sto_user_id UUID,
  vor_sto_name TEXT,
  vor_end_date DATE,
  vor_link TEXT,
  tender_id UUID REFERENCES public.tenders(id) ON DELETE SET NULL,
  created_by UUID DEFAULT auth.uid(),
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT vor_requests_department_check CHECK (department IN ('construction', 'joint')),
  CONSTRAINT vor_requests_status_check CHECK (vor_status IN ('not_started', 'in_progress', 'completed', 'not_required')),
  CONSTRAINT vor_requests_division_check CHECK (vor_division IS NULL OR vor_division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical')),
  CONSTRAINT vor_requests_description_check CHECK (btrim(work_description) <> '')
);

ALTER SEQUENCE public.vor_requests_number_seq OWNED BY public.vor_requests.request_number;

CREATE INDEX IF NOT EXISTS idx_vor_requests_department ON public.vor_requests(department);
CREATE INDEX IF NOT EXISTS idx_vor_requests_object_id ON public.vor_requests(object_id);
CREATE INDEX IF NOT EXISTS idx_vor_requests_deleted_at ON public.vor_requests(deleted_at);

CREATE OR REPLACE FUNCTION public.vor_requests_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vor_requests_updated_at ON public.vor_requests;
CREATE TRIGGER trg_vor_requests_updated_at
  BEFORE UPDATE ON public.vor_requests
  FOR EACH ROW EXECUTE FUNCTION public.vor_requests_touch_updated_at();

-- Доступ — сотрудникам (подтверждённая роль, не подрядчик) и владельцу системы.
-- SECURITY DEFINER: проверка не должна зависеть от RLS самой user_roles.
CREATE OR REPLACE FUNCTION public.vor_requests_can_access()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND ur.role <> 'contractor'
  )
  OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$$;
REVOKE ALL ON FUNCTION public.vor_requests_can_access() FROM public;
GRANT EXECUTE ON FUNCTION public.vor_requests_can_access() TO authenticated;

ALTER TABLE public.vor_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vor_requests_employees ON public.vor_requests;
CREATE POLICY vor_requests_employees ON public.vor_requests
  FOR ALL TO authenticated
  USING (public.vor_requests_can_access())
  WITH CHECK (public.vor_requests_can_access());

REVOKE ALL ON public.vor_requests FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vor_requests TO authenticated;
GRANT USAGE ON SEQUENCE public.vor_requests_number_seq TO authenticated;

COMMENT ON TABLE public.vor_requests IS
  'Заявки на подготовку ВОР без привязки к тендеру (раздел «ВОРы и РД»).';
