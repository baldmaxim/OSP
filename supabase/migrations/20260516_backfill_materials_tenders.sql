-- Backfill: для каждого существующего основного тендера (tender_type = 'main')
-- на объектах основного строительства, у которого ещё нет связанного тендера на материалы,
-- создаём дочерний тендер на материалы с теми же object_id, work_description, датами.
-- В гарантийном отделе тендеры на материалы не нужны — там backfill не выполняется.
-- Повторное применение миграции безопасно: NOT EXISTS исключает дубли.

INSERT INTO tenders (
    object_id,
    work_description,
    status,
    start_date,
    end_date,
    tender_type,
    parent_tender_id
)
SELECT
    main.object_id,
    main.work_description,
    'Не начат',
    main.start_date,
    main.end_date,
    'materials',
    main.id
FROM tenders AS main
JOIN objects AS obj ON obj.id = main.object_id
WHERE main.tender_type = 'main'
  AND main.deleted_at IS NULL
  AND obj.status = 'main_construction'
  AND NOT EXISTS (
      SELECT 1
      FROM tenders AS child
      WHERE child.parent_tender_id = main.id
        AND child.tender_type = 'materials'
  );
