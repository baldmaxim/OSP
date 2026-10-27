-- Заявки на ДС ↔ договоры (27.10.2026): номер договора и номер ДС раздельно, подразделение заявки; шаблон ДГП.
--
--  • dc_requests.contract_id — договор (ДП) реестра «Договоры и ДС», к которому подаётся заявка. «№ ДС»
--    (ds_number) остаётся номером самого ДС. Удалили договор — ссылка обнуляется, заявка остаётся.
--  • dc_requests.amendment_id — ДС реестра «Договоры и ДС», в которое заявка занесена («занесена в допник»).
--    Карточка контрагента показывает заявки по его договорам: какие отработаны, какие занесены в ДС.
--  • dc_requests.division — подразделение (те же коды, что подразделение ВОР у тендеров) — фильтр реестра заявок.
--  • Прежние заявки: договор подставляется, только если он однозначен — номер договора контрагента заявки
--    встречается в её «№ ДС» (и такой договор один) или у контрагента по этому объекту ровно один договор.
--    Остальным договор выбирают в реестре. Текст «№ ДС» не меняется.
--  • section_templates: «Шаблон ДГП» (contracts_dgp) — файл в «Документах» реестра договоров (прикрепляет
--    администратор, как остальные шаблоны). Нужна 20261107_section_templates; без неё строка не заводится.
--
-- Права не меняются: колонки той же таблицы dc_requests, строка той же таблицы шаблонов.
-- База нового портала (Яндекс) — migration/yandex/20261109_contracts_dc_requests.sql.
-- Проверка: migration/backup/checks/20261109.sql; откат — migration/rollback/20261109_contracts_dc_requests_rollback.sql.
-- Только добавление, повтор безопасен (уже заполненные договоры не трогаются).
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL;
ALTER TABLE public.dc_requests ADD COLUMN IF NOT EXISTS amendment_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL;
ALTER TABLE public.dc_requests ADD COLUMN IF NOT EXISTS division text;

ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_division_check;
ALTER TABLE public.dc_requests ADD CONSTRAINT dc_requests_division_check
  CHECK (division IS NULL OR division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));

CREATE INDEX IF NOT EXISTS idx_dc_requests_contract ON public.dc_requests (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dc_requests_amendment ON public.dc_requests (amendment_id) WHERE amendment_id IS NOT NULL;

COMMENT ON COLUMN public.dc_requests.contract_id IS
  'Договор (ДП) реестра «Договоры и ДС», к которому подаётся заявка на ДС; номер ДС — ds_number';
COMMENT ON COLUMN public.dc_requests.amendment_id IS
  'ДС реестра «Договоры и ДС», в которое заявка занесена («занесена в допник»)';
COMMENT ON COLUMN public.dc_requests.division IS
  'Подразделение заявки — коды подразделений ВОР: monolith | nvf_spk | general | hvac_water | electrical | finishing';

-- ── Договор прежних заявок — только однозначный ────────────────────────────────────────────────────
-- Номера сравниваются без регистра, пробелов, дефисов, точек и косых (как normalizeDocNumber в
-- src/utils/dcRequestContracts.js); номер короче 4 знаков в тексте не ищется — «5» нашёлся бы где угодно.
WITH dp AS (
  SELECT id, counterparty_id, object_id,
         regexp_replace(lower(coalesce(contract_number, '')), '[[:space:]_./\\–—-]', '', 'g') AS num
  FROM public.contracts
  WHERE record_type = 'dp' AND deleted_at IS NULL AND counterparty_id IS NOT NULL
),
req AS (
  SELECT id, counterparty_id, object_id,
         regexp_replace(lower(coalesce(ds_number, '')), '[[:space:]_./\\–—-]', '', 'g') AS txt
  FROM public.dc_requests
  WHERE contract_id IS NULL AND counterparty_id IS NOT NULL
),
by_number AS (
  SELECT r.id, (array_agg(d.id))[1] AS contract_id
  FROM req r JOIN dp d ON d.counterparty_id = r.counterparty_id AND length(d.num) >= 4 AND strpos(r.txt, d.num) > 0
  GROUP BY r.id
  HAVING count(*) = 1
),
by_object AS (
  SELECT r.id, (array_agg(d.id))[1] AS contract_id
  FROM req r JOIN dp d ON d.counterparty_id = r.counterparty_id AND d.object_id = r.object_id
  WHERE NOT EXISTS (SELECT 1 FROM by_number b WHERE b.id = r.id)
  GROUP BY r.id
  HAVING count(*) = 1
)
UPDATE public.dc_requests t SET contract_id = m.contract_id
FROM (SELECT id, contract_id FROM by_number UNION ALL SELECT id, contract_id FROM by_object) m
WHERE t.id = m.id AND t.contract_id IS NULL;

-- ── Шаблон ДГП ───────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.section_templates') IS NOT NULL THEN
    INSERT INTO public.section_templates (code, title) VALUES ('contracts_dgp', 'Шаблон ДГП')
    ON CONFLICT (code) DO NOTHING;
  END IF;
END
$$;

COMMIT;
