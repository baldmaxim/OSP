-- Вкладка «ВОРы и РД» в тендере: рабочая документация (PDF) с привязкой к шифрам
-- РД и ведомости объёмов работ.
--
-- Файлы — в той же таблице s3_documents (owner_type='tender'), различаются
-- категорией, новых таблиц под сами файлы не нужно:
--   'rd'            — рабочая документация, PDF;
--   'vor_statement' — ведомость объёмов работ;
--   'vor'           — прежняя общая категория «ВОРы и РД». Её файлы остаются как
--                     есть и показываются отдельным блоком «Загружены ранее».
--
-- Шифры РД — существующая таблица tender_rd_codes (миграция 20260901), она НЕ
-- меняется. Связь «документ ↔ шифр» — многие-ко-многим: один PDF бывает сразу
-- на несколько разделов, а по одному шифру — несколько файлов (тома, изменения).
--
-- Удаление файла или шифра убирает только связь (ON DELETE CASCADE); сами шифры
-- и документы друг друга не удаляют.
--
-- Миграция идемпотентна. Требует 20260901_tender_rd_codes.

CREATE TABLE IF NOT EXISTS tender_rd_document_codes (
  document_id UUID NOT NULL REFERENCES s3_documents(id) ON DELETE CASCADE,
  rd_code_id  UUID NOT NULL REFERENCES tender_rd_codes(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by_name TEXT,
  PRIMARY KEY (document_id, rd_code_id)
);

-- Обратный поиск «какие файлы у шифра» (PK покрывает только document_id первым).
CREATE INDEX IF NOT EXISTS idx_tender_rd_document_codes_code
  ON tender_rd_document_codes (rd_code_id);

COMMENT ON TABLE tender_rd_document_codes IS
  'Связь PDF рабочей документации тендера (s3_documents, doc_category=rd) с шифрами РД (tender_rd_codes)';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Чтение: связь видна тому, кому виден сам файл. Подзапрос к s3_documents
-- выполняется с RLS вызывающего, поэтому подрядчик увидит шифры только у тех
-- файлов, которые ему и так открыты.
-- Запись: только сотрудники. Роль подрядчика определяем по user_roles напрямую —
-- без зависимости от вспомогательных функций поздних миграций.
ALTER TABLE tender_rd_document_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rd_doc_codes_select ON tender_rd_document_codes;
CREATE POLICY rd_doc_codes_select ON tender_rd_document_codes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM s3_documents d WHERE d.id = document_id));

DROP POLICY IF EXISTS rd_doc_codes_write ON tender_rd_document_codes;
CREATE POLICY rd_doc_codes_write ON tender_rd_document_codes
  FOR ALL TO authenticated
  USING (
    NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.role = 'contractor')
  )
  WITH CHECK (
    NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.role = 'contractor')
    -- Шифр и файл должны принадлежать одному тендеру: иначе через связь можно
    -- было бы «приклеить» чужой шифр.
    AND EXISTS (
      SELECT 1
      FROM s3_documents d
      JOIN tender_rd_codes c ON c.tender_id = d.owner_id
      WHERE d.id = document_id
        AND c.id = rd_code_id
        AND d.owner_type = 'tender'
    )
  );

-- ── Кабинет подрядчика ──────────────────────────────────────────────────────
-- Если миграция 20260914 уже применена, её политика открывает подрядчику только
-- категории 'tender_package' и 'vor'. Новые РД и ВОР — то же содержание, что
-- раньше лежало в 'vor', поэтому расширяем список. Без 20260914 политики нет,
-- и трогать нечего.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 's3_documents' AND policyname = 'portal_contractor_select'
  ) THEN
    DROP POLICY portal_contractor_select ON public.s3_documents;
    CREATE POLICY portal_contractor_select ON public.s3_documents
      FOR SELECT TO authenticated
      USING (
        (owner_type = 'tender'
          AND doc_category IN ('tender_package', 'vor', 'rd', 'vor_statement')
          AND public.is_my_tender(owner_id))
        OR (owner_type = 'contract' AND public.is_my_contract(owner_id))
      );
  END IF;
END $$;
