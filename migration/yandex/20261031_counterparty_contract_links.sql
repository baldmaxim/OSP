-- Карточка контрагента → «Общая информация» → «Договоры и ДС»: договор, прикреплённый к контрагенту вручную.
-- Тело supabase/migrations/20261031_counterparty_contract_links.sql: те же таблица, индекс и триггер, иначе —
-- только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), прикрепляет и открепляет право правки «Контрагентов»
--    (osp_can('counterparties', 'edit')); изменять строку нельзя.
-- Стороны договора не меняются, данные не трогаются. Повтор безопасен.

-- ── 1. Привязки ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.counterparty_contract_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counterparty_contract_links_key UNIQUE (counterparty_id, contract_id)
);
COMMENT ON TABLE public.counterparty_contract_links IS
  'Договор, прикреплённый к контрагенту вручную (карточка контрагента → «Договоры и ДС»); стороны договора не меняет';
COMMENT ON COLUMN public.counterparty_contract_links.created_by IS 'Кто прикрепил (ставит триггер)';

CREATE INDEX IF NOT EXISTS counterparty_contract_links_contract_idx
  ON public.counterparty_contract_links (contract_id);

CREATE OR REPLACE FUNCTION public.counterparty_contract_links_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.created_by := auth.uid();
  NEW.created_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS counterparty_contract_links_stamp ON public.counterparty_contract_links;
CREATE TRIGGER counterparty_contract_links_stamp
  BEFORE INSERT ON public.counterparty_contract_links
  FOR EACH ROW EXECUTE FUNCTION public.counterparty_contract_links_stamp();

-- ── 2. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.counterparty_contract_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counterparty_contract_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.counterparty_contract_links;
CREATE POLICY osp_internal ON public.counterparty_contract_links FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS counterparty_contract_links_read ON public.counterparty_contract_links;
CREATE POLICY counterparty_contract_links_read ON public.counterparty_contract_links FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS counterparty_contract_links_insert ON public.counterparty_contract_links;
CREATE POLICY counterparty_contract_links_insert ON public.counterparty_contract_links FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('counterparties', 'edit'))) END);
DROP POLICY IF EXISTS counterparty_contract_links_delete ON public.counterparty_contract_links;
CREATE POLICY counterparty_contract_links_delete ON public.counterparty_contract_links FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('counterparties', 'edit'))) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'counterparty_contract_links', 'counterparty_contract_links_read', ARRAY['authenticated']),
  ('public', 'counterparty_contract_links', 'counterparty_contract_links_insert', ARRAY['authenticated']),
  ('public', 'counterparty_contract_links', 'counterparty_contract_links_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table counterparty_contract_links authenticated=select,insert,delete
