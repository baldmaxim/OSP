-- task 348: разрешаем хранение нескольких ВОРов в одном тендере.
-- Старый констрейнт UNIQUE(tender_id, row_number) делал row_number уникальным
-- в рамках всего тендера — это не работает, когда у тендера несколько
-- документов (Электрика, ОВ, ВК…) и в каждом своя нумерация 1, 2, 3…
-- Переносим уникальность на (tender_id, estimate_name, row_number) —
-- внутри одного документа номера остаются уникальными.

ALTER TABLE tender_estimate_items
  DROP CONSTRAINT IF EXISTS tender_estimate_items_tender_id_row_number_key;

ALTER TABLE tender_estimate_items
  ADD CONSTRAINT tender_estimate_items_tender_id_estimate_row_key
  UNIQUE (tender_id, estimate_name, row_number);
