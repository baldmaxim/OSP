-- Отметка времени у участников тендера. Открытый реестр «Тендеры» сверяет таблицу раз в 20 с (src/api/tablePolling.js);
-- без отметки каждая вкладка читает все 4 тыс. строк пятью запросами со сдвигом, с ней — только изменившиеся.
-- Только база нового портала: у прежнего (Supabase) вместо опроса Realtime.
--
-- Значение по умолчанию now() не переписывает таблицу (PostgreSQL 11+): всем прежним строкам достаётся время
-- миграции, блокировка — на долю секунды. Отметку ставит триггер, значение от клиента не принимается: на ней держится
-- сверка. Функция триггера — та же, что у tenders (поднимать права ей не нужно).
-- Без этой миграции страница работает как раньше: читает таблицу целиком. Откат —
-- migration/rollback/20261220_tender_counterparties_updated_at_rollback.sql.
ALTER TABLE public.tender_counterparties ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trigger_update_tender_counterparties_updated_at ON public.tender_counterparties;
CREATE TRIGGER trigger_update_tender_counterparties_updated_at
  BEFORE INSERT OR UPDATE ON public.tender_counterparties
  FOR EACH ROW EXECUTE FUNCTION public.update_tenders_updated_at();

COMMENT ON COLUMN public.tender_counterparties.updated_at IS 'Когда строка менялась в последний раз: ставит триггер, по ней сверяется открытый реестр тендеров.';
