-- Ускорение вкладок «ВОР» и «Сравнение КП» в карточке тендера.
--
-- 1) КП тендера грузятся страницами по 1000 строк с ORDER BY id. С индексом
--    только по tender_id база на КАЖДУЮ страницу собирала все КП тендера и
--    сортировала их заново; составной индекс отдаёт страницу упорядоченным
--    просмотром.
-- 2) Подпись «КП загружено …» у участников без файла КП: по запросу на участника
--    «последняя строка КП по created_at». Без индекса каждый такой запрос
--    сортировал все КП тендера, и при открытии карточки их шло столько, сколько
--    участников, — одновременно с загрузкой ВОР.
-- 3) Позиции ВОР: сортировка row_number + id (row_number уникален только внутри
--    одного ВОРа), расценки снабжения — по id.
--
-- Только индексы, данные не меняются. Идемпотентно.

CREATE INDEX IF NOT EXISTS idx_tcp_tender_id_id
  ON tender_counterparty_proposals (tender_id, id);

CREATE INDEX IF NOT EXISTS idx_tcp_tender_cp_created
  ON tender_counterparty_proposals (tender_id, counterparty_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tei_tender_row_id
  ON tender_estimate_items (tender_id, row_number, id);

CREATE INDEX IF NOT EXISTS idx_tvsr_tender_id_id
  ON tender_vor_supply_rates (tender_id, id);

ANALYZE tender_counterparty_proposals;
ANALYZE tender_estimate_items;
ANALYZE tender_vor_supply_rates;
