-- ОТКАТ 20270122_contracts_reopen_with_live_ds: снова прежнее правило 20260906 — документ выходит из «Завершено», только
-- если у него нет ни одного живого ДС (в любом статусе). Годится для обеих баз (Supabase и Яндекса): ролей не касается.
-- Данные не меняются: документы, которые успели вернуть из «Завершено», остаются в своём статусе.
-- Одной транзакцией, повтор безопасен; триггер не пересоздаётся.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.contracts_hierarchy_guard()
RETURNS TRIGGER AS $$
DECLARE
  parent_row contracts%ROWTYPE;
  blocking_id BIGINT;
  blocking_list TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.record_type IS DISTINCT FROM OLD.record_type THEN
    RAISE EXCEPTION 'Тип документа изменить нельзя. Создайте новый документ нужного типа';
  END IF;

  IF NEW.record_type = 'dp' THEN
    IF NEW.parent_contract_id IS NOT NULL THEN
      RAISE EXCEPTION 'У основного договора не может быть изменяемого документа';
    END IF;
    NEW.root_contract_id := NEW.id;
  ELSE
    IF NEW.parent_contract_id IS NULL THEN
      RAISE EXCEPTION 'Для ДС нужно указать изменяемый документ';
    END IF;

    SELECT * INTO parent_row FROM contracts WHERE id = NEW.parent_contract_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Изменяемый документ не найден';
    END IF;
    IF parent_row.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Изменяемый документ ID % удалён', parent_row.display_id;
    END IF;

    IF NEW.record_type = 'ds_extra' AND parent_row.record_type <> 'dp' THEN
      RAISE EXCEPTION 'ДС на дополнительные работы создаётся только к основному договору (ID % — не договор)', parent_row.display_id;
    END IF;

    IF NEW.record_type = 'ds_vor' THEN
      SELECT display_id INTO blocking_id
      FROM contracts
      WHERE parent_contract_id = NEW.parent_contract_id
        AND record_type = 'ds_vor'
        AND deleted_at IS NULL
        AND id <> NEW.id
      LIMIT 1;
      IF blocking_id IS NOT NULL THEN
        RAISE EXCEPTION 'Документ ID % уже изменён соглашением ID %. Новое изменение создавайте к нему',
          parent_row.display_id, blocking_id;
      END IF;

      IF parent_row.record_type = 'ds_vor' AND parent_row.status <> 'completed' THEN
        RAISE EXCEPTION 'ДС ID % ещё не завершено. В одной ветке допускается только одно незавершённое изменение',
          parent_row.display_id;
      END IF;
    END IF;

    NEW.root_contract_id := COALESCE(parent_row.root_contract_id, parent_row.id);
  END IF;

  -- Завершённый документ не правим задним числом: иначе актуальные условия и
  -- суммы поменялись бы молча, без следа в истории.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status = 'completed'
     AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
    IF (NEW.contract_amount, NEW.gp_amount, NEW.currency, NEW.vat_rate, NEW.amount_includes_vat,
        NEW.bsm, NEW.work_start_date, NEW.work_end_date, NEW.warranty_retention_percent,
        NEW.warranty_retention_period, NEW.warranty_period, NEW.work_name,
        NEW.contract_number, NEW.contract_date, NEW.parent_contract_id, NEW.changed_fields)
       IS DISTINCT FROM
       (OLD.contract_amount, OLD.gp_amount, OLD.currency, OLD.vat_rate, OLD.amount_includes_vat,
        OLD.bsm, OLD.work_start_date, OLD.work_end_date, OLD.warranty_retention_percent,
        OLD.warranty_retention_period, OLD.warranty_period, OLD.work_name,
        OLD.contract_number, OLD.contract_date, OLD.parent_contract_id, OLD.changed_fields)
    THEN
      RAISE EXCEPTION 'Документ ID % завершён. Чтобы изменить условия, сначала верните его из статуса «Завершено»', OLD.display_id;
    END IF;
  END IF;

  -- Выход из «Завершено» — только снизу вверх: пока у документа есть живые
  -- потомки, их условия опираются на его актуальное состояние.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    SELECT string_agg(display_id::text, ', ' ORDER BY display_id) INTO blocking_list
    FROM contracts WHERE parent_contract_id = NEW.id AND deleted_at IS NULL;
    IF blocking_list IS NOT NULL THEN
      RAISE EXCEPTION 'Сначала верните на доработку зависимые документы: ID %', blocking_list;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
