-- Нормализация статусов тендеров на материалы:
-- они используют отдельный набор статусов: «Не начат», «В работе», «Завершён».
-- Существующие записи могли быть созданы со статусами основного тендера (например, «Заявка на тендер»).

UPDATE tenders
SET status = 'Не начат'
WHERE tender_type = 'materials'
  AND status IN (
      'Заявка на тендер',
      'Подготовка ВОР',
      'Приостановка тендера'
  );

UPDATE tenders
SET status = 'В работе'
WHERE tender_type = 'materials'
  AND status = 'Идет тендерная процедура';

UPDATE tenders
SET status = 'Завершён'
WHERE tender_type = 'materials'
  AND status = 'Завершен';
