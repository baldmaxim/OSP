-- Публичный (анонимный) доступ к открытым тендерам.
-- Гостям без авторизации виден ограниченный набор данных:
--   * только тендеры со статусом «Идет тендерная процедура»
--   * только основные тендеры (tender_type = 'main' или NULL для legacy)
--   * не удалённые (deleted_at IS NULL)
--   * только базовые поля объекта (имя, адрес, ссылка на карты)
-- Все остальные поля и таблицы (контрагенты, КП, контакты и т.д.) остаются закрытыми.

-- Политика SELECT для роли anon на tenders
DROP POLICY IF EXISTS "Anon public tender list" ON tenders;
CREATE POLICY "Anon public tender list" ON tenders
  FOR SELECT TO anon
  USING (
    status = 'Идет тендерная процедура'
    AND deleted_at IS NULL
    AND (tender_type IS NULL OR tender_type = 'main')
  );

-- Политика SELECT для роли anon на objects: только объекты, у которых есть открытый тендер
DROP POLICY IF EXISTS "Anon public objects via open tenders" ON objects;
CREATE POLICY "Anon public objects via open tenders" ON objects
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM tenders t
      WHERE t.object_id = objects.id
        AND t.status = 'Идет тендерная процедура'
        AND t.deleted_at IS NULL
        AND (t.tender_type IS NULL OR t.tender_type = 'main')
    )
  );
