-- Позиции ВОР для расценки снабжением — заранее, на сервере: состояние разбора по тендеру (служба osp-api,
-- server/osp-api/src/lib/supplyImport.js, включается OSP_SUPPLY_IMPORT=1). База нового портала: правила по строкам
-- под одну учётку (README рядом); Supabase-вариант — supabase/migrations/20261024_supply_import_state.sql.
--
--  • tender_supply_import_state — строка на основной тендер: status ok | no_vor | issues | locked | pending, подписи
--    файлов и вкладки «ВОР», версия разбора, причины отказов (issues). По ней реестр тендеров на материалы
--    показывает статус расценки без её открытия, а страница не скачивает файл, который служба не смогла разобрать.
--  • Читает сотрудник; пишет только служба (служебная операция, отметка osp:internal) — правил записи для
--    вошедших нет, шлюз пускает только чтение.
--
-- Только добавление, повтор безопасен.

CREATE TABLE IF NOT EXISTS public.tender_supply_import_state (
  tender_id uuid PRIMARY KEY REFERENCES public.tenders(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ok', 'no_vor', 'issues', 'locked', 'pending')),
  files_sig text,
  tab_sig text,
  parser_version integer NOT NULL DEFAULT 0,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array'),
  positions_count integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.tender_supply_import_state IS
  'Разбор позиций ВОР для расценки снабжением службой osp-api: итог по основному тендеру (статус для реестра тендеров на материалы и причины отказов)';

-- ── Права под одну учётку ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_import_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_import_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_supply_import_state;
CREATE POLICY osp_internal ON public.tender_supply_import_state FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (osp_is_employee()) на проде).
DROP POLICY IF EXISTS supply_import_state_read ON public.tender_supply_import_state;
CREATE POLICY supply_import_state_read ON public.tender_supply_import_state FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_supply_import_state', 'supply_import_state_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_supply_import_state authenticated=select
