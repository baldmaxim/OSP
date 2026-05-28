-- task 347: дата предоставления КП — обязательное поле при загрузке КП от
-- контрагента. Дублируется на каждой строке tender_counterparty_proposals
-- (все строки одного КП — одна дата). NULL для исторических записей.

ALTER TABLE tender_counterparty_proposals
  ADD COLUMN IF NOT EXISTS proposal_date DATE;

COMMENT ON COLUMN tender_counterparty_proposals.proposal_date IS
  'Дата предоставления КП контрагентом (task 347). Одна дата на весь файл КП.';

-- Индекс для быстрой выборки самых свежих КП.
CREATE INDEX IF NOT EXISTS idx_tcp_proposal_date
  ON tender_counterparty_proposals(tender_id, counterparty_id, proposal_date DESC);
