-- Заявки на ДС: промежуточный этап «Проверка по договору» перед «В работе».
--
-- Раньше заявка сразу попадала в работу. По факту сначала её сверяют с
-- договором (есть ли основание, что именно меняется), и только потом берут в
-- работу — этого этапа в системе не было, и заявки на проверке visually не
-- отличались от тех, что уже в работе.
--
-- Новый статус становится НАЧАЛЬНЫМ: цепочка contract_check → in_work → completed.
-- Существующие заявки не трогаем — они уже прошли этот этап де-факто, перевод их
-- в проверку означал бы откат работы назад.
--
-- Миграция идемпотентна.

-- Порядок важен: сначала расширяем CHECK, потом меняем DEFAULT. Иначе между
-- двумя операциями появилось бы окно, в котором вставка с новым значением
-- по умолчанию нарушала бы старое ограничение.
ALTER TABLE dc_requests DROP CONSTRAINT IF EXISTS dc_requests_status_check;
ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_status_check
  CHECK (status IN ('contract_check', 'in_work', 'completed'));

ALTER TABLE dc_requests ALTER COLUMN status SET DEFAULT 'contract_check';

COMMENT ON COLUMN dc_requests.status IS
  'Этап заявки: contract_check (проверка по договору) → in_work (в работе) → completed (завершено)';
