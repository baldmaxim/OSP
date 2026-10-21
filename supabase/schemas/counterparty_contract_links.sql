-- Договор, прикреплённый к контрагенту вручную: карточка контрагента → «Общая информация» → «Договоры и ДС».
-- Источник истины — supabase/migrations/20261031_counterparty_contract_links.sql (права, триггер).
-- Стороны договора не меняет: реестр договоров и кабинет подрядчика привязку не видят.
CREATE TABLE IF NOT EXISTS public.counterparty_contract_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),   -- кто прикрепил (ставит триггер counterparty_contract_links_stamp)
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counterparty_contract_links_key UNIQUE (counterparty_id, contract_id)
);

CREATE INDEX IF NOT EXISTS counterparty_contract_links_contract_idx
  ON public.counterparty_contract_links (contract_id);

-- RLS: читает сотрудник (osp_is_employee), INSERT / DELETE — osp_can('counterparties', 'edit'), UPDATE не выдан.
