-- Нумерация договоров подряда по объектам: КОД ОБЪЕКТА-ДП-ГГ-НОМЕР (АЛИЯ-ДП-26-001). Миграция 20270110_contract_number_scheme.
-- Справочный файл: источник истины — миграция (там же коды 17 объектов и права).

-- Ключи: заглавные, латиница-двойник — кириллицей; NULL — не по правилам. Совпадают с src/utils/contractNumbering.js.
--   contract_code_norm(text)   — приведённая строка или NULL (недопустимые знаки);
--   contract_code_key(text)    — ключ кода объекта (до 20 знаков, с буквы/цифры, ими же заканчивается);
--   contract_number_key(text)  — «КОД|ГГГГ|N» для номера по схеме, иначе NULL.

-- Код объекта в номере договора; задаёт администратор (триггер objects_contract_code_guard), у двух объектов один код быть не может.
ALTER TABLE objects ADD COLUMN IF NOT EXISTS contract_code TEXT
  CONSTRAINT objects_contract_code_check CHECK (contract_code IS NULL OR contract_code_key(contract_code) IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS objects_contract_code_uniq ON objects (contract_code_key(contract_code)) WHERE contract_code IS NOT NULL;

-- Счётчик: последний выданный номер на код и год. Только растёт; пишет триггер contracts_number_counter
-- (AFTER INSERT OR UPDATE OF contract_number, record_type ON contracts, только record_type = 'dp'). Читает сотрудник.
CREATE TABLE IF NOT EXISTS contract_number_counters (
  code_key TEXT NOT NULL CHECK (code_key = contract_code_key(code_key)),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2099),
  last_number INTEGER NOT NULL CHECK (last_number >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code_key, year)
);
ALTER TABLE contract_number_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_number_counters_read ON contract_number_counters FOR SELECT TO authenticated
  USING ((SELECT osp_is_employee()));

-- Номер по схеме у договоров (в том числе удалённых) не повторяется; прочие номера — по-прежнему не уникальны.
CREATE UNIQUE INDEX IF NOT EXISTS contracts_scheme_number_uniq ON contracts (contract_number_key(contract_number))
  WHERE record_type = 'dp' AND contract_number_key(contract_number) IS NOT NULL;
