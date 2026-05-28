-- task 348: при импорте ВОР со столбцом А в виде заголовка раздела
-- (например, «10.03Б.02.01.07.01.01. Подготовительные работы») значение
-- original_row_number может быть длинным текстом, а не «1.2» / «5». Расширяем
-- тип до TEXT — VARCHAR(20) переполнялся и блокировал сохранение.

ALTER TABLE tender_estimate_items
  ALTER COLUMN original_row_number TYPE TEXT;

COMMENT ON COLUMN tender_estimate_items.original_row_number IS
  'Оригинальный номер строки из Excel; для разделов может содержать иерархический код-заголовок';
