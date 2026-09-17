-- Тендеры на материалы: начало срока предоставления КП.
--
-- Срок был одной датой — materials_proposal_deadline («по какое число»); она
-- остаётся как есть (просрочка, сортировка, отчёты считают по ней). Добавляем
-- дату «с какого числа», чтобы показывать период «с … по …».
-- Миграция идемпотентна.

ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS materials_proposal_start_date DATE;

COMMENT ON COLUMN public.tenders.materials_proposal_start_date IS
  'Начало срока предоставления КП на материалы (окончание — materials_proposal_deadline)';
