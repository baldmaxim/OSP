-- Заявки на ДС: новый набор типов ДС.
--
-- Было (миграция 20260824): rd_change (изменение РД), extra_in_contract,
-- extra_out_contract. Стало:
--   psdc_change        — Изменение ПСДЦ (заменяет «Изменение РД»: изменение РД
--                        оформляется изменением ПСДЦ);
--   extra_in_contract  — Доп. работы по текущему договору;
--   extra_out_contract — Доп. работы вне договора;
--   tender_ds          — ДС по тендеру.
--
-- Уже проставленные «Изменение РД» переводятся в «Изменение ПСДЦ».
-- Колонка создаётся, если миграция 20260824 не применялась.
-- Миграция идемпотентна.

ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS ds_type TEXT;

ALTER TABLE dc_requests DROP CONSTRAINT IF EXISTS dc_requests_ds_type_check;

UPDATE dc_requests SET ds_type = 'psdc_change' WHERE ds_type = 'rd_change';

ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_ds_type_check
  CHECK (ds_type IS NULL OR ds_type IN ('psdc_change', 'extra_in_contract', 'extra_out_contract', 'tender_ds'));

COMMENT ON COLUMN dc_requests.ds_type IS
  'Тип ДС: psdc_change (изменение ПСДЦ) | extra_in_contract (доп. работы по текущему договору) | extra_out_contract (доп. работы вне договора) | tender_ds (ДС по тендеру)';
