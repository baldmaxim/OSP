-- Направления тендеров: к двум существующим добавляются «Совместные» и «Прочее».
--
-- Проблема. До сих пор принадлежность тендера отделу нигде не хранилась —
-- она ВЫЧИСЛЯЛАСЬ из статуса связанного объекта: objects.status='main_construction'
-- → основное строительство, 'warranty_service' → гарантийный отдел. Новые
-- направления в эту модель не укладываются: «совместный» — свойство самого
-- тендера, а не стройплощадки, а тендер «прочее» может вообще не иметь объекта.
--
-- Решение: явная колонка tenders.department.
--   construction | warranty | joint (совместные) | other (прочее)
--
-- Совместимость. Колонка заполняется бэкфиллом из статуса объекта, поэтому
-- сразу после миграции разделы «Основное строительство» и «Гарантийный отдел»
-- показывают ровно то же, что и раньше. Триггер ниже сохраняет и прежнее
-- поведение «объект передали в гарантию → его тендеры уехали в ГО».
--
-- Миграция идемпотентна.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Колонка.
ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT 'construction';

COMMENT ON COLUMN tenders.department IS
  'Направление: construction (основное строительство) | warranty (гарантийный отдел) | joint (совместные) | other (прочее)';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Бэкфилл из статуса объекта — ДО добавления CHECK, чтобы не было окна,
--    в котором существующие строки нарушают ограничение.
UPDATE tenders t
SET department = 'warranty'
FROM objects o
WHERE t.object_id = o.id
  AND o.status = 'warranty_service'
  AND t.department = 'construction';

ALTER TABLE tenders DROP CONSTRAINT IF EXISTS valid_tender_department;
ALTER TABLE tenders ADD CONSTRAINT valid_tender_department
  CHECK (department IN ('construction', 'warranty', 'joint', 'other'));

CREATE INDEX IF NOT EXISTS idx_tenders_department ON tenders(department);
-- Списки страницы всегда фильтруют по направлению и типу одновременно.
CREATE INDEX IF NOT EXISTS idx_tenders_department_type ON tenders(department, tender_type);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Синхронизация при смене статуса объекта.
--
-- Раньше тендеры «переезжали» между основным строительством и гарантией сами
-- собой — просто потому, что фильтр смотрел на статус объекта. Сохраняем это
-- поведение: при передаче объекта в гарантийное обслуживание его тендеры
-- уходят в ГО и наоборот.
--
-- Направления joint и other НЕ трогаем: они выбраны человеком осознанно и от
-- статуса объекта не зависят.
CREATE OR REPLACE FUNCTION public.sync_tenders_department_from_object()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE tenders
    SET department = CASE NEW.status
                       WHEN 'warranty_service' THEN 'warranty'
                       ELSE 'construction'
                     END
    WHERE object_id = NEW.id
      AND department IN ('construction', 'warranty');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_tenders_department ON objects;
CREATE TRIGGER trg_sync_tenders_department
  AFTER UPDATE OF status ON objects
  FOR EACH ROW EXECUTE FUNCTION public.sync_tenders_department_from_object();
