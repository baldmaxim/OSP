-- «Планы затрат» → «Документы» → «Расчёт ПЗ»: документы объектов прикрепляет и открепляет экономист ОСП, каждое действие
-- — в журнале (решение пользователя 02.11.2026).
--
--  • Право — новый раздел прав cost_plan_docs («Права доступа»): его проверяют страница и osp-api (CATEGORY_RULES),
--    у администратора оно есть всегда. Выдаётся роли economist («Экономист ОСП»); другой роли — галочкой в «Правах
--    доступа». Повторный прогон ручные настройки не трогает. Инструкции и компенсация НДС и инфляции — по-прежнему
--    только администратор.
--  • Журнал cost_plan_calc_file_log — кто, когда, какой файл, какого объекта. Пишет только триггер на s3_documents:
--    откуда бы ни шла запись (osp-api, функция s3-presign, прямой запрос), мимо журнала файл не прикрепить и не убрать;
--    прямой записи в журнал нет ни у кого, правок и удаления записей тоже. Файл и объект могут исчезнуть — имя файла и
--    название объекта хранятся слепком, внешних ключей нет. Читает сотрудник (как и сами файлы).
--  • Уже прикреплённые файлы попадают в журнал записью «прикреплён» с их датой и автором загрузки.
--
-- Только добавление, данные портала не меняются. CREATE TRIGGER на s3_documents берёт короткую блокировку таблицы —
-- применять в нерабочее время. База нового портала — migration/yandex/20261130_cost_plan_calc_file_log.sql. Проверка —
-- migration/backup/checks/20261130.sql, откат — migration/rollback/20261130_cost_plan_calc_file_log_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.cost_plan_calc_file_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('attach', 'detach')),
  document_id uuid NOT NULL,
  file_name text NOT NULL,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  doc_category text NOT NULL,
  object_name text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_plan_calc_file_log_time_idx ON public.cost_plan_calc_file_log (changed_at DESC, id DESC);
COMMENT ON TABLE public.cost_plan_calc_file_log IS
  'Журнал файлов «Расчёта ПЗ» («Планы затрат» → «Документы»): кто и когда прикрепил и открепил. Пишет только триггер на s3_documents; без внешних ключей — запись переживает файл и объект';

CREATE OR REPLACE FUNCTION public.cost_plan_calc_file_log_write() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_categories constant text[] := ARRAY['cost_plan_calc', 'cost_plan_direct_costs', 'cost_plan_kp_before_transfers'];
  v_attach boolean := false;
  v_detach boolean := false;
  v_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_attach := NEW.doc_category = ANY (v_categories);
  ELSIF TG_OP = 'DELETE' THEN
    v_detach := OLD.doc_category = ANY (v_categories);
  ELSIF (NEW.doc_category, NEW.owner_type, NEW.owner_id) IS DISTINCT FROM (OLD.doc_category, OLD.owner_type, OLD.owner_id) THEN
    -- Файл перенесли в другую категорию или к другому владельцу: для журнала он убран оттуда и прикреплён сюда.
    v_detach := OLD.doc_category = ANY (v_categories);
    v_attach := NEW.doc_category = ANY (v_categories);
  END IF;
  IF NOT (v_attach OR v_detach) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')) INTO v_name
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;

  IF v_detach THEN
    INSERT INTO public.cost_plan_calc_file_log (action, document_id, file_name, owner_type, owner_id, doc_category,
      object_name, changed_by, changed_by_name)
    VALUES ('detach', OLD.id, OLD.file_name, OLD.owner_type, OLD.owner_id, OLD.doc_category,
      CASE WHEN OLD.owner_type = 'object' THEN (SELECT o.name FROM public.objects o WHERE o.id = OLD.owner_id) END,
      auth.uid(), v_name);
  END IF;
  IF v_attach THEN
    INSERT INTO public.cost_plan_calc_file_log (action, document_id, file_name, owner_type, owner_id, doc_category,
      object_name, changed_by, changed_by_name)
    VALUES ('attach', NEW.id, NEW.file_name, NEW.owner_type, NEW.owner_id, NEW.doc_category,
      CASE WHEN NEW.owner_type = 'object' THEN (SELECT o.name FROM public.objects o WHERE o.id = NEW.owner_id) END,
      auth.uid(), v_name);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS s3_documents_cost_plan_calc_log ON public.s3_documents;
CREATE TRIGGER s3_documents_cost_plan_calc_log
  AFTER INSERT OR DELETE OR UPDATE OF doc_category, owner_type, owner_id ON public.s3_documents
  FOR EACH ROW EXECUTE FUNCTION public.cost_plan_calc_file_log_write();

INSERT INTO public.cost_plan_calc_file_log (action, document_id, file_name, owner_type, owner_id, doc_category,
  object_name, changed_by, changed_by_name, changed_at)
SELECT 'attach', d.id, d.file_name, d.owner_type, d.owner_id, d.doc_category,
  CASE WHEN d.owner_type = 'object' THEN (SELECT o.name FROM public.objects o WHERE o.id = d.owner_id) END,
  d.uploaded_by, d.uploaded_by_name, d.created_at
FROM public.s3_documents d
WHERE d.doc_category IN ('cost_plan_calc', 'cost_plan_direct_costs', 'cost_plan_kp_before_transfers')
  AND NOT EXISTS (SELECT 1 FROM public.cost_plan_calc_file_log l WHERE l.document_id = d.id AND l.action = 'attach');

INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, 'cost_plan_docs', true, true FROM public.roles r WHERE r.key = 'economist'
ON CONFLICT (role, section) DO NOTHING;

-- ── Права: журнал читает сотрудник, записи — только через триггер ────────────────────────────────────
ALTER TABLE public.cost_plan_calc_file_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_plan_calc_file_log_read ON public.cost_plan_calc_file_log;
CREATE POLICY cost_plan_calc_file_log_read ON public.cost_plan_calc_file_log FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));

REVOKE ALL ON TABLE public.cost_plan_calc_file_log FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.cost_plan_calc_file_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cost_plan_calc_file_log TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cost_plan_calc_file_log_write() FROM PUBLIC, anon, authenticated;

COMMIT;
