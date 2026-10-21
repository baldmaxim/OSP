-- Карточка контрагента (/general/counterparties) → «Общая информация» → «Договоры и ДС»: договор, прикреплённый
-- к контрагенту вручную. Раздел показывает договоры, где контрагент — сторона (contracts.counterparty_id или
-- contract_counterparties); прикреплённый вручную договор показывается там же, со всеми своими ДС, а
-- администратору — с пометкой «добавлен вручную» (кто и когда прикрепил).
--
--  • counterparty_contract_links — строка = контрагент + договор (одна на пару). Стороны договора НЕ меняются:
--    реестр «Договоры и ДС» и кабинет подрядчика (is_my_contract) привязку не видят, доступа к договору и его
--    файлам она никому не даёт. Удаление контрагента или договора удаляет и привязку.
--  • Кто и когда прикрепил — триггером (не со страницы): created_by = auth.uid(), created_at = now().
--  • Права: читает сотрудник, прикрепляет и открепляет право правки «Контрагентов» (osp_can('counterparties',
--    'edit') = canEdit('counterparties') на странице). Изменять строку нельзя — только прикрепить или открепить.
--
-- Только добавление, повтор безопасен. Пока миграции нет, раздел показывает договоры как раньше, без кнопки
-- «Прикрепить договор». База нового портала — migration/yandex/20261031_counterparty_contract_links.sql.
-- Проверка: migration/backup/checks/20261031.sql, откат — migration/rollback/20261031_counterparty_contract_links_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

-- Удаление договора ищет его привязки — без индекса по contract_id это перебор таблицы.
CREATE INDEX IF NOT EXISTS counterparty_contract_links_contract_idx
  ON public.counterparty_contract_links (contract_id);

-- Кто и когда прикрепил — всегда вошедший и текущее время, а не значения со страницы.
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

-- ── 2. Права ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.counterparty_contract_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS counterparty_contract_links_read ON public.counterparty_contract_links;
CREATE POLICY counterparty_contract_links_read ON public.counterparty_contract_links FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS counterparty_contract_links_insert ON public.counterparty_contract_links;
CREATE POLICY counterparty_contract_links_insert ON public.counterparty_contract_links FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('counterparties', 'edit')));
DROP POLICY IF EXISTS counterparty_contract_links_delete ON public.counterparty_contract_links;
CREATE POLICY counterparty_contract_links_delete ON public.counterparty_contract_links FOR DELETE TO authenticated
  USING ((SELECT public.osp_can('counterparties', 'edit')));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно. UPDATE не выдаётся.
REVOKE ALL ON TABLE public.counterparty_contract_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.counterparty_contract_links TO authenticated;
GRANT ALL ON TABLE public.counterparty_contract_links TO service_role;
REVOKE ALL ON FUNCTION public.counterparty_contract_links_stamp() FROM PUBLIC, anon;

COMMIT;
