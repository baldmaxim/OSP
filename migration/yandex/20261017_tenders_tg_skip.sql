-- Третье состояние отметки «ТГ» в реестре тендеров — «Не публиковать». Тело
-- supabase/migrations/20261017_tenders_tg_skip.sql: колонки той же таблицы tenders, правила строк
-- и список шлюза не меняются. Данные не меняются: у всех тендеров tg_skip = false. Повтор безопасен.
ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS tg_skip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tg_skip_at timestamptz,
  ADD COLUMN IF NOT EXISTS tg_skip_by text;

ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_tg_state_check;
ALTER TABLE public.tenders
  ADD CONSTRAINT tenders_tg_state_check CHECK (NOT (tg_published AND tg_skip));

COMMENT ON COLUMN public.tenders.tg_skip IS 'Тендер не публикуется в Telegram-канале (решение сотрудника)';
COMMENT ON COLUMN public.tenders.tg_skip_at IS 'Когда отмечено «не публиковать в ТГ»';
COMMENT ON COLUMN public.tenders.tg_skip_by IS 'Кто отметил «не публиковать в ТГ» (ФИО/e-mail)';
