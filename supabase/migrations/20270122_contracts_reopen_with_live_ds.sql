-- «Договоры и ДС»: завершённый договор можно вернуть из «Завершено», пока его ДС ещё в работе.
--
-- Было (20260906): выйти из «Завершено» документ мог, только если у него нет ни одного живого документа
-- к нему (ДС), в каком бы статусе тот ни был. Подсказка при этом просила «вернуть ДС на доработку», но ДС
-- «В работе» всё равно мешало — договор можно было изменить, только удалив ДС (11.11.2026, договор
-- № 518-ЭВТД/25 с ДС № 1 «Новая заявка»).
--
-- Стало — мешает только то, что действительно опирается на нынешние условия документа:
--   • завершённые ДС к нему: их изменения посчитаны от его условий — сначала их возвращают из «Завершено»;
--     незавершённое ДС на действующие условия не влияет (effectiveValues останавливается на нём) и не мешает;
--   • у ДС на изменение ВОР — следующее изменение той же ветки в любом статусе: незавершённым в ветке бывает
--     только последнее изменение (иначе правка следующего упёрлась бы в «ДС … ещё не завершено»).
-- Остальные правила триггера не меняются: тип документа, ветки, заморозка условий завершённого документа.
-- То же правило на странице — reopenBlocker в src/utils/contractAmendments.js (тексты совпадают, сторожит
-- tests/psdc/contract-reopen.test.mjs). База Яндекса — migration/yandex/ с тем же именем.
-- Повтор безопасен (CREATE OR REPLACE), триггер не пересоздаётся.

CREATE OR REPLACE FUNCTION contracts_hierarchy_guard()
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

  -- Выход из «Завершено» (20270122). Мешают только документы, которые опираются на нынешние условия этого:
  -- следующее изменение ветки (у ДС на изменение ВОР — в любом статусе) и завершённые ДС к нему.
  -- ДС в работе не мешает: на действующие условия оно ещё не влияет.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    IF NEW.record_type = 'ds_vor' THEN
      SELECT display_id INTO blocking_id
      FROM contracts
      WHERE parent_contract_id = NEW.id AND record_type = 'ds_vor' AND deleted_at IS NULL
      ORDER BY display_id
      LIMIT 1;
      IF blocking_id IS NOT NULL THEN
        RAISE EXCEPTION 'ДС ID % уже изменено соглашением ID %: в ветке правится только последнее изменение. Правьте ДС ID % или удалите его',
          NEW.display_id, blocking_id, blocking_id;
      END IF;
    END IF;

    SELECT string_agg(display_id::text, ', ' ORDER BY display_id) INTO blocking_list
    FROM contracts
    WHERE parent_contract_id = NEW.id AND deleted_at IS NULL AND status = 'completed';
    IF blocking_list IS NOT NULL THEN
      RAISE EXCEPTION 'Сначала верните из «Завершено» ДС к документу ID %: ID %', NEW.display_id, blocking_list;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
