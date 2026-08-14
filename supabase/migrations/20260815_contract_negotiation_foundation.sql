-- Согласование условий договора (протокол разногласий).
-- Пункты договора + споры (наша/контрагент/итоговая редакция) + обсуждение.
-- Настоящая изоляция контрагента: доступ к «своим» договорам через RLS, а не только
-- клиентской фильтрацией. Существующие таблицы и данные не затрагиваются.

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Связь логина контрагента с организацией.
--    counterparty_id = NULL → сотрудник; NOT NULL → контрагент, привязанный к организации.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS counterparty_id UUID
  REFERENCES counterparties(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_user_roles_counterparty_id ON user_roles(counterparty_id);
COMMENT ON COLUMN user_roles.counterparty_id IS 'Организация-контрагент, к которой привязан логин (NULL = сотрудник СУ-10)';

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Helper-функции (SECURITY DEFINER → читают user_roles в обход RLS, без рекурсии).

-- Организация текущего пользователя (NULL для сотрудников/неподтверждённых).
CREATE OR REPLACE FUNCTION public.current_counterparty_id()
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.current_counterparty_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_counterparty_id() TO authenticated;

-- Сотрудник СУ-10 = подтверждённый пользователь без привязки к контрагенту.
CREATE OR REPLACE FUNCTION public.is_negotiation_employee()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.counterparty_id IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.is_negotiation_employee() FROM public;
GRANT EXECUTE ON FUNCTION public.is_negotiation_employee() TO authenticated;

-- Договор принадлежит организации текущего контрагента (он — сторона договора).
CREATE OR REPLACE FUNCTION public.is_my_contract(contract_uuid uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT public.current_counterparty_id() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_uuid AND c.counterparty_id = public.current_counterparty_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.contract_counterparties cc
      WHERE cc.contract_id = contract_uuid AND cc.counterparty_id = public.current_counterparty_id()
    )
  );
$$;
REVOKE ALL ON FUNCTION public.is_my_contract(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_my_contract(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Пункты договора (базовый текст, ведём мы; «всегда актуальная редакция»).
CREATE TABLE IF NOT EXISTS contract_clauses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  clause_number TEXT,                       -- «1», «1.1», «1.1.2» (как в документе)
  body TEXT NOT NULL DEFAULT '',            -- текст пункта (наша актуальная редакция)
  order_index INT NOT NULL DEFAULT 0,       -- порядок следования
  level INT NOT NULL DEFAULT 1,             -- уровень вложенности для отступов
  is_heading BOOLEAN NOT NULL DEFAULT false,-- заголовок раздела (не обсуждается)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_clauses_contract_id ON contract_clauses(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_clauses_order ON contract_clauses(contract_id, order_index);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Спор по пункту(ам) = строка протокола разногласий: 3 редакции + статус.
CREATE TABLE IF NOT EXISTS contract_clause_disputes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  label TEXT,                               -- «п. 1.1–1.3» (для отображения)
  our_text TEXT NOT NULL DEFAULT '',        -- наша редакция (снимок на момент выноса)
  counterparty_text TEXT NOT NULL DEFAULT '', -- редакция контрагента
  final_text TEXT NOT NULL DEFAULT '',      -- итоговая согласованная редакция (правим мы)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_review', 'agreed', 'rejected')),
  created_by_side TEXT NOT NULL DEFAULT 'contractor'
    CHECK (created_by_side IN ('employee', 'contractor')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clause_disputes_contract_id ON contract_clause_disputes(contract_id);
CREATE INDEX IF NOT EXISTS idx_clause_disputes_counterparty_id ON contract_clause_disputes(counterparty_id);

-- Какие пункты охватывает спор (может быть несколько подряд).
CREATE TABLE IF NOT EXISTS contract_clause_dispute_clauses (
  dispute_id UUID NOT NULL REFERENCES contract_clause_disputes(id) ON DELETE CASCADE,
  clause_id UUID NOT NULL REFERENCES contract_clauses(id) ON DELETE CASCADE,
  PRIMARY KEY (dispute_id, clause_id)
);
CREATE INDEX IF NOT EXISTS idx_dispute_clauses_clause_id ON contract_clause_dispute_clauses(clause_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Обсуждение спора. Автор денормализован (как в аудит-логах).
CREATE TABLE IF NOT EXISTS contract_clause_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  dispute_id UUID NOT NULL REFERENCES contract_clause_disputes(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  author_side TEXT NOT NULL CHECK (author_side IN ('employee', 'contractor')),
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clause_comments_dispute_id ON contract_clause_comments(dispute_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Триггеры updated_at.
CREATE OR REPLACE FUNCTION update_contract_clauses_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contract_clauses_updated_at ON contract_clauses;
CREATE TRIGGER trg_contract_clauses_updated_at BEFORE UPDATE ON contract_clauses
  FOR EACH ROW EXECUTE FUNCTION update_contract_clauses_updated_at();

CREATE OR REPLACE FUNCTION update_clause_disputes_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_clause_disputes_updated_at ON contract_clause_disputes;
CREATE TRIGGER trg_clause_disputes_updated_at BEFORE UPDATE ON contract_clause_disputes
  FOR EACH ROW EXECUTE FUNCTION update_clause_disputes_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 6) Защита колонок: контрагент может менять ТОЛЬКО свою редакцию (counterparty_text).
--    «Нашу»/итоговую редакцию, статус и связи он поменять не может, даже через API.
CREATE OR REPLACE FUNCTION protect_dispute_columns()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF public.current_counterparty_id() IS NOT NULL THEN
    NEW.our_text := OLD.our_text;
    NEW.final_text := OLD.final_text;
    NEW.status := OLD.status;
    NEW.contract_id := OLD.contract_id;
    NEW.counterparty_id := OLD.counterparty_id;
    NEW.created_by_side := OLD.created_by_side;
    NEW.label := OLD.label;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_protect_dispute_columns ON contract_clause_disputes;
CREATE TRIGGER trg_protect_dispute_columns BEFORE UPDATE ON contract_clause_disputes
  FOR EACH ROW EXECUTE FUNCTION protect_dispute_columns();

-- ────────────────────────────────────────────────────────────────────────────
-- 7) RLS. Сотрудник — полный доступ; контрагент — только «свои» договоры/споры.
ALTER TABLE contract_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clause_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clause_dispute_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clause_comments ENABLE ROW LEVEL SECURITY;

-- DROP перед CREATE — миграция идемпотентна (можно применять повторно после сбоя).
DROP POLICY IF EXISTS clauses_employee_all ON contract_clauses;
DROP POLICY IF EXISTS clauses_contractor_read ON contract_clauses;
DROP POLICY IF EXISTS disputes_employee_all ON contract_clause_disputes;
DROP POLICY IF EXISTS disputes_contractor_select ON contract_clause_disputes;
DROP POLICY IF EXISTS disputes_contractor_insert ON contract_clause_disputes;
DROP POLICY IF EXISTS disputes_contractor_update ON contract_clause_disputes;
DROP POLICY IF EXISTS dispute_clauses_employee_all ON contract_clause_dispute_clauses;
DROP POLICY IF EXISTS dispute_clauses_contractor ON contract_clause_dispute_clauses;
DROP POLICY IF EXISTS comments_employee_all ON contract_clause_comments;
DROP POLICY IF EXISTS comments_contractor_select ON contract_clause_comments;
DROP POLICY IF EXISTS comments_contractor_insert ON contract_clause_comments;

-- Пункты договора: сотрудник — всё; контрагент — только читает пункты своих договоров.
CREATE POLICY clauses_employee_all ON contract_clauses
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY clauses_contractor_read ON contract_clauses
  FOR SELECT TO authenticated
  USING (public.is_my_contract(contract_id));

-- Споры: сотрудник — всё; контрагент — CRUD только своих (по counterparty_id),
-- вставлять может лишь спор по своему договору. Колонки защищены триггером выше.
CREATE POLICY disputes_employee_all ON contract_clause_disputes
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY disputes_contractor_select ON contract_clause_disputes
  FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());
CREATE POLICY disputes_contractor_insert ON contract_clause_disputes
  FOR INSERT TO authenticated
  WITH CHECK (counterparty_id = public.current_counterparty_id() AND public.is_my_contract(contract_id));
CREATE POLICY disputes_contractor_update ON contract_clause_disputes
  FOR UPDATE TO authenticated
  USING (counterparty_id = public.current_counterparty_id())
  WITH CHECK (counterparty_id = public.current_counterparty_id());

-- Связь спор↔пункты: сотрудник — всё; контрагент — по своим спорам.
CREATE POLICY dispute_clauses_employee_all ON contract_clause_dispute_clauses
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY dispute_clauses_contractor ON contract_clause_dispute_clauses
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM contract_clause_disputes d
                 WHERE d.id = dispute_id AND d.counterparty_id = public.current_counterparty_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM contract_clause_disputes d
                 WHERE d.id = dispute_id AND d.counterparty_id = public.current_counterparty_id()));

-- Комментарии: сотрудник — всё; контрагент — читает/пишет по своим спорам,
-- author_side обязан быть 'contractor' и организация — своя.
CREATE POLICY comments_employee_all ON contract_clause_comments
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY comments_contractor_select ON contract_clause_comments
  FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());
CREATE POLICY comments_contractor_insert ON contract_clause_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    counterparty_id = public.current_counterparty_id()
    AND author_side = 'contractor'
    AND EXISTS (SELECT 1 FROM contract_clause_disputes d
                WHERE d.id = dispute_id AND d.counterparty_id = public.current_counterparty_id())
  );
