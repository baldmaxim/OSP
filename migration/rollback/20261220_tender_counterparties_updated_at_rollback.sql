-- Откат 20261220_tender_counterparties_updated_at: только база нового портала. Данные участников не затрагиваются;
-- открытые вкладки перейдут на чтение таблицы целиком сами, при следующем открытии страницы (src/api/tablePolling.js).
-- Повтор безопасен.
DROP TRIGGER IF EXISTS trigger_update_tender_counterparties_updated_at ON public.tender_counterparties;
ALTER TABLE public.tender_counterparties DROP COLUMN IF EXISTS updated_at;
