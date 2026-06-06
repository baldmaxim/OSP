-- task 401: ручная пометка «учтено в другой позиции» для нерасценённых позиций КП.
-- Позволяет сотруднику закрыть жёлтую/оранжевую позицию без отдельной цены —
-- стоимость остаётся «—», но в расчётах покрытия строка считается закрытой.
ALTER TABLE tender_counterparty_proposals
  ADD COLUMN IF NOT EXISTS covered_elsewhere BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coverage_note TEXT;

COMMENT ON COLUMN tender_counterparty_proposals.covered_elsewhere IS
  'task 401: позиция учтена в другой позиции КП — закрыта без отдельной цены';
COMMENT ON COLUMN tender_counterparty_proposals.coverage_note IS
  'task 401: примечание «учтено в …» (свободный текст)';
