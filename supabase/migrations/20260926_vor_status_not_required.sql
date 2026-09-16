-- ВОРы и РД: статус «Не требуется» (not_required).
--
-- Было (миграция 20260507): not_started | in_progress | completed.
-- Для части тендеров ВОР не готовится вовсе — они висели «Не начатыми» и
-- портили очередь. Добавляем отдельный статус.
--
-- Ограничение снимаем по определению, а не по имени: если в базе его когда-то
-- создали под другим именем, DROP ... IF EXISTS по имени промолчал бы.
-- Миграция идемпотентна.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.tenders'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%vor_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.tenders DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.tenders
  ADD CONSTRAINT valid_vor_status
  CHECK (vor_status IN ('not_started', 'in_progress', 'completed', 'not_required'));

COMMENT ON COLUMN public.tenders.vor_status IS
  'Статус ВОР: not_started | in_progress | completed | not_required (не требуется)';
