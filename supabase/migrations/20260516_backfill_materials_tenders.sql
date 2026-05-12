-- Backfill: для каждого существующего основного тендера (tender_type = 'main'),
-- у которого ещё нет связанного тендера на материалы (parent_tender_id),
-- создаём дочерний тендер на материалы с теми же object_id, work_description, датами.
-- Статус нового тендера на материалы — стартовый «Заявка на тендер».

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
    'Заявка на тендер',
    main.start_date,
    main.end_date,
    'materials',
    main.id
FROM tenders AS main
WHERE main.tender_type = 'main'
  AND main.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM tenders AS child
      WHERE child.parent_tender_id = main.id
        AND child.tender_type = 'materials'
  );
