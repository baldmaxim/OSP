-- Добавление поля is_section для маркировки строк-разделов в смете
-- Разделы - это заголовки секций (например: "1. Электромонтажные работы")
-- которые помогают структурировать смету и понять, к какому разделу относятся работы

ALTER TABLE tender_estimate_items
ADD COLUMN IF NOT EXISTS is_section BOOLEAN DEFAULT FALSE;

-- Добавляем поле original_row_number для хранения оригинального номера строки из Excel
-- Это позволяет сохранить исходную нумерацию при импорте
ALTER TABLE tender_estimate_items
ADD COLUMN IF NOT EXISTS original_row_number VARCHAR(20);

COMMENT ON COLUMN tender_estimate_items.is_section IS 'Признак того, что строка является заголовком раздела (секции)';
COMMENT ON COLUMN tender_estimate_items.original_row_number IS 'Оригинальный номер строки из импортированного Excel файла';
