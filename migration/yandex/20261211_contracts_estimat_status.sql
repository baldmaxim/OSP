-- «Договоры и ДС»: отметка «Загружено в Estimat» у договора и ДС. Тело supabase/migrations/20261211_contracts_estimat_status.sql:
-- колонки той же таблицы contracts, правила строк и список шлюза не меняются. Данные не меняются: у всех документов
-- estimat_status = 'none'. Повтор безопасен.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS estimat_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS estimat_status_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimat_status_by text;

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_estimat_status_check;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_estimat_status_check
  CHECK (estimat_status IN ('none', 'uploaded', 'skip'));

COMMENT ON COLUMN public.contracts.estimat_status IS 'Загрузка документа в Estimat: none — не загружен, uploaded — загружен, skip — не загружать';
COMMENT ON COLUMN public.contracts.estimat_status_at IS 'Когда выставлена отметка Estimat';
COMMENT ON COLUMN public.contracts.estimat_status_by IS 'Кто выставил отметку Estimat (ФИО/e-mail)';
