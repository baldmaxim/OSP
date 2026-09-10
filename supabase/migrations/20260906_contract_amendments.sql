-- Дополнительные соглашения (ДС) в модуле «Договоры и ДС».
--
-- Фундамент был заложен миграцией 20260814: договоры и ДС живут в ОДНОЙ таблице
-- contracts, у каждой записи есть глобально уникальный display_id из общей
-- последовательности, есть record_type и parent_contract_id. Поэтому отдельная
-- сущность и отдельный аллокатор ID не нужны: ID договора и ДС и так не
-- пересекаются, а существующие display_id не меняются.
--
-- Миграция добавляет:
--   1) третий тип документа (изменение ВОР / дополнительные работы);
--   2) служебные поля root_contract_id и changed_fields;
--   3) целостность иерархии — триггерами. Своего бэкенда в проекте нет, фронт
--      ходит в PostgREST напрямую, поэтому единственное место, где правила
--      нельзя обойти, — сама база. Проверки в JS остаются подсказками для UX.
--
-- Миграция additive и идемпотентна: колонки не удаляются, ID не меняются,
-- существующие договоры не пересоздаются.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Три типа документа.
--
-- Было ('dp','ds'). Записи прежнего типа 'ds' переводим в 'ds_vor': исторически
-- «ДС» означало именно изменяющее соглашение.
UPDATE contracts SET record_type = 'ds_vor' WHERE record_type = 'ds';

-- До этой миграции «ID основного договора» в форме был полем-заглушкой, а ДС не
-- создавались. Если у договора всё же остался родитель, это мусор: с ним триггер
-- ниже отказал бы в любом последующем сохранении такого договора.
UPDATE contracts SET parent_contract_id = NULL
WHERE record_type = 'dp' AND parent_contract_id IS NOT NULL;

-- Обратный случай — ДС без изменяемого документа. Данные не трогаем (это может
-- быть реальная запись), но предупреждаем: такие строки нужно связать вручную,
-- иначе их не сохранить.
DO $$
DECLARE orphan TEXT;
BEGIN
  SELECT string_agg(display_id::text, ', ' ORDER BY display_id) INTO orphan
  FROM contracts WHERE record_type <> 'dp' AND parent_contract_id IS NULL AND deleted_at IS NULL;
  IF orphan IS NOT NULL THEN
    RAISE NOTICE 'ДС без изменяемого документа (укажите его вручную): ID %', orphan;
  END IF;
END $$;

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_record_type_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_record_type_check
  CHECK (record_type IN ('dp', 'ds_vor', 'ds_extra'));

COMMENT ON COLUMN contracts.record_type IS
  'dp — основной договор; ds_vor — ДС на изменение ВОР (изменяет один документ своей ветки); ds_extra — ДС на дополнительные работы (новая ветка от договора)';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Корень дерева и список реально изменённых полей.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS root_contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS changed_fields TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN contracts.root_contract_id IS
  'Корневой договор дерева документа; у самого договора равен его id. Заполняется триггером — нужен, чтобы реестр и уникальность номера ДС не требовали рекурсии на каждую строку';
COMMENT ON COLUMN contracts.changed_fields IS
  'Какие коммерческие поля ДС реально меняет. Остальные наследуются от предыдущей актуальной версии ветки. Пустое значение поля НЕ означает изменение — иначе ДС молча возвращал бы старые условия';

-- Бэкофилл: у договоров корень — они сами; у ДС поднимаемся по цепочке.
WITH RECURSIVE chain AS (
  SELECT id, id AS root_id FROM contracts WHERE parent_contract_id IS NULL
  UNION ALL
  SELECT c.id, ch.root_id
  FROM contracts c
  JOIN chain ch ON c.parent_contract_id = ch.id
)
UPDATE contracts c SET root_contract_id = ch.root_id
FROM chain ch
WHERE c.id = ch.id AND c.root_contract_id IS DISTINCT FROM ch.root_id;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Индексы.
CREATE INDEX IF NOT EXISTS idx_contracts_root_contract_id ON contracts(root_contract_id);
CREATE INDEX IF NOT EXISTS idx_contracts_root_type ON contracts(root_contract_id, record_type);
CREATE INDEX IF NOT EXISTS idx_contracts_record_status ON contracts(record_type, status);

-- Номер ДС уникален в пределах дерева одного договора. Сравнение
-- консервативное — только btrim: «1», «01», «1/1», «1а», «№1» остаются разными.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contracts_amendment_number
  ON contracts (root_contract_id, btrim(contract_number))
  WHERE record_type <> 'dp'
    AND deleted_at IS NULL
    AND contract_number IS NOT NULL
    AND btrim(contract_number) <> '';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Целостность иерархии.
--
-- Правила сведены к проверкам, не требующим обхода всего дерева:
--   • договор не имеет родителя, ДС — обязан;
--   • ДС на дополнительные работы крепится только к договору (новая ветка);
--   • ДС на изменение крепится только к ВЕРШИНЕ ветки — у родителя не должно
--     быть живых детей-изменений. Это разом даёт линейность ветки и запрет
--     параллельных изменений;
--   • если родитель сам изменяющее ДС, он должен быть завершён. Вместе с
--     предыдущим правилом это и есть «максимум одно незавершённое изменение в
--     ветке»: незавершённой в линейной ветке может быть только её вершина;
--   • тип документа не меняется после создания;
--   • у завершённого документа нельзя тихо править условия.
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

DROP TRIGGER IF EXISTS trg_contracts_hierarchy_guard ON contracts;
CREATE TRIGGER trg_contracts_hierarchy_guard
  BEFORE INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_hierarchy_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Удаление: без каскада по иерархии.
CREATE OR REPLACE FUNCTION contracts_delete_guard()
RETURNS TRIGGER AS $$
DECLARE
  children TEXT;
BEGIN
  -- Реагируем и на soft delete (проставление deleted_at), и на физический DELETE.
  IF TG_OP = 'UPDATE' AND (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL) THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(display_id::text, ', ' ORDER BY display_id) INTO children
  FROM contracts
  WHERE parent_contract_id = COALESCE(NEW.id, OLD.id) AND deleted_at IS NULL;

  IF children IS NOT NULL THEN
    RAISE EXCEPTION 'Сначала удалите зависимые документы: ID %', children;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contracts_delete_guard ON contracts;
CREATE TRIGGER trg_contracts_delete_guard
  BEFORE UPDATE OR DELETE ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_delete_guard();
