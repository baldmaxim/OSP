-- Добавляем поля для детализации объектов основного строительства

-- Планируемое начало работ
DO $$ BEGIN
  ALTER TABLE objects ADD COLUMN planned_start_date DATE;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Планируемое окончание работ
DO $$ BEGIN
  ALTER TABLE objects ADD COLUMN planned_end_date DATE;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Общая площадь объекта (м²)
DO $$ BEGIN
  ALTER TABLE objects ADD COLUMN total_area DECIMAL(12, 2);
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Бюджет (руб.)
DO $$ BEGIN
  ALTER TABLE objects ADD COLUMN budget DECIMAL(15, 2);
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Комментарии
COMMENT ON COLUMN objects.planned_start_date IS 'Планируемая дата начала работ';
COMMENT ON COLUMN objects.planned_end_date IS 'Планируемая дата окончания работ';
COMMENT ON COLUMN objects.total_area IS 'Общая площадь объекта в м²';
COMMENT ON COLUMN objects.budget IS 'Бюджет объекта в рублях';
