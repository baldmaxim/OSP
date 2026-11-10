-- Нумерация договоров подряда по объектам: КОД ОБЪЕКТА-ДП-ГГ-НОМЕР (АЛИЯ-ДП-26-001). Тело
-- supabase/migrations/20270110_contract_number_scheme.sql: те же функции ключей, колонка objects.contract_code с
-- начальными кодами 17 объектов ОС, счётчик contract_number_counters, триггеры и уникальность номера по схеме
-- (тексты совпадают — сторожит tests/tender/contract-numbering-db.test.mjs), иначе — только права под одну учётку:
--  • счётчик: правила по строкам включены и действуют на владельца; читает сотрудник (osp_is_employee), пишет только
--    триггер contracts_number_counter (служебная функция, пропуск);
--  • код объекта меняет только администратор — триггер objects_contract_code_guard (правила objects не меняются).
-- Повтор безопасен. Номера по схеме, уже повторяющиеся у договоров, останавливают миграцию с перечнем.

-- ── Ключи (IMMUTABLE: на них индексы) ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contract_code_norm(p_text text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN s ~ '^[0-9A-Za-zА-Яа-яЁё.-]+$'
              THEN translate(upper(translate(s, 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')),
                             'ABCEHKMOPTXY', 'АВСЕНКМОРТХУ') END
  FROM (SELECT btrim(p_text, E' \t\r\n' || chr(160)) AS s) t
$$;

CREATE OR REPLACE FUNCTION public.contract_code_key(p_code text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN k ~ '^[0-9A-ZА-ЯЁ]([0-9A-ZА-ЯЁ.-]*[0-9A-ZА-ЯЁ])?$' AND char_length(k) <= 20 THEN k END
  FROM (SELECT public.contract_code_norm(p_code) AS k) t
$$;

CREATE OR REPLACE FUNCTION public.contract_number_key(p_number text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.contract_code_key(m[1]) || '|' || (2000 + m[2]::int)::text || '|' || (m[3]::int)::text
  FROM (SELECT regexp_match(public.contract_code_norm(p_number), '^([0-9A-ZА-ЯЁ.-]+)-ДП-([0-9]{2})-([0-9]{1,6})$') AS m) t
  WHERE m IS NOT NULL AND m[3]::int >= 1
$$;

COMMENT ON FUNCTION public.contract_code_key(text) IS 'Ключ кода объекта для номеров договоров: заглавные, латиница-двойник — кириллицей; NULL — код недопустим';
COMMENT ON FUNCTION public.contract_number_key(text) IS 'Ключ номера договора по схеме КОД-ДП-ГГ-NNN: «КОД|ГГГГ|N»; NULL — номер не по схеме';

-- ── Код объекта ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.objects ADD COLUMN IF NOT EXISTS contract_code text;
ALTER TABLE public.objects DROP CONSTRAINT IF EXISTS objects_contract_code_check;
ALTER TABLE public.objects ADD CONSTRAINT objects_contract_code_check
  CHECK (contract_code IS NULL OR public.contract_code_key(contract_code) IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS objects_contract_code_uniq ON public.objects (public.contract_code_key(contract_code))
  WHERE contract_code IS NOT NULL;
COMMENT ON COLUMN public.objects.contract_code IS 'Код объекта в номере договора подряда (КОД-ДП-ГГ-NNN); задаёт администратор';

CREATE OR REPLACE FUNCTION public.objects_contract_code_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_old text;
BEGIN
  NEW.contract_code := NULLIF(btrim(NEW.contract_code, E' \t\r\n' || chr(160)), '');
  IF TG_OP = 'UPDATE' THEN v_old := OLD.contract_code; END IF;
  IF NEW.contract_code IS DISTINCT FROM v_old AND auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Код объекта для номеров договоров задаёт администратор' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS objects_contract_code_guard ON public.objects;
CREATE TRIGGER objects_contract_code_guard
  BEFORE INSERT OR UPDATE OF contract_code ON public.objects
  FOR EACH ROW EXECUTE FUNCTION public.objects_contract_code_guard();

-- Начальные коды (файл «Нумерация_договоров_по_объектам.xlsx», лист «Коды объектов»): только где кода ещё нет.
UPDATE public.objects o SET contract_code = c.code
FROM (VALUES
  ('1fb5f7cf-f2ab-4dff-9dd1-f78a127cf071'::uuid, 'ЗИЛ33'),        -- ЖК ЗИЛ 33
  ('22e50284-66f8-45bf-ab1f-99a46fbbd365'::uuid, 'СБ2'),          -- ЖК CITY BAY (2-й этап)
  ('092f3657-ebb4-43dd-a0b5-7e762b78a017'::uuid, 'ИНДЖОЙ'),       -- ЖК INJOY
  ('1fd91c8f-7380-4f61-8e30-c79564bea922'::uuid, 'КИНГ'),         -- ЖК King & Sons
  ('c7588858-2d53-4c75-8326-3fdb33f03191'::uuid, 'ПРИМ13'),       -- ЖК Primavera к13
  ('7d9e4296-0f8f-4e61-b217-deaf9ab6b3c0'::uuid, 'ПРИМ14'),       -- ЖК Primavera к14
  ('c378019f-fa26-408e-b923-a3827c3f5b9a'::uuid, 'СТОР'),         -- ЖК STORIES
  ('3255853d-e091-459c-a8a0-9fd7e1774082'::uuid, 'ВЕЙВ1'),        -- ЖК Wave 1
  ('c129b9df-390c-40c7-b87e-949861414ffa'::uuid, 'ВЕЙВ2'),        -- ЖК Wave 2
  ('cb878fd0-9069-4f6b-99bf-ce5179b82656'::uuid, 'АЛИЯ'),         -- ЖК Алия
  ('c47b4d0a-57f4-4e78-9bdf-82e2b66327da'::uuid, 'ДОМ56'),        -- ЖК Дом 56
  ('b47b7f7c-31a8-4b09-9266-35f7f351cf0f'::uuid, 'ЗИЛ18-19-27'),  -- ЖК ЗИЛ 18; 19; 27
  ('81d0d58c-f41c-4e82-97c9-20dee23080a4'::uuid, 'ЗИЛ31'),        -- ЖК ЗИЛ 31
  ('d2b3dbb4-724e-43ff-8296-46e783b70ea5'::uuid, 'ДОМ56Рен'),     -- ЖК Реновация («ЖК Дом 56 Реновация» в файле)
  ('cfc76783-8c54-4be3-90c7-87e599e828e2'::uuid, 'САД69'),        -- ЖК Садовническая 69
  ('a5e5c0f6-0711-459f-987d-bd4b4b1d7b1a'::uuid, 'СОБ6.1'),       -- Событие 6.1
  ('b36691aa-3be5-4be1-9d95-51b66da602e1'::uuid, 'СОБ6.2')        -- Событие 6.2
) AS c(id, code)
WHERE o.id = c.id AND o.contract_code IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.objects x
                  WHERE x.id <> o.id AND public.contract_code_key(x.contract_code) = public.contract_code_key(c.code));

-- ── Счётчик номеров ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_number_counters (
  code_key text NOT NULL CHECK (code_key = public.contract_code_key(code_key)),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2099),
  last_number integer NOT NULL CHECK (last_number >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code_key, year)
);
COMMENT ON TABLE public.contract_number_counters IS
  'Счётчик номеров договоров подряда по схеме КОД-ДП-ГГ-NNN: последний выданный номер на код объекта и год; только растёт, пишет триггер';

ALTER TABLE public.contract_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_number_counters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.contract_number_counters;
CREATE POLICY osp_internal ON public.contract_number_counters FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и сотрудник (как TO authenticated USING (osp_is_employee()) на проде).
DROP POLICY IF EXISTS contract_number_counters_read ON public.contract_number_counters;
CREATE POLICY contract_number_counters_read ON public.contract_number_counters FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'contract_number_counters', 'contract_number_counters_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table contract_number_counters authenticated=select

CREATE OR REPLACE FUNCTION public.contracts_number_counter() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  k text;
BEGIN
  IF NEW.record_type IS DISTINCT FROM 'dp' THEN RETURN NULL; END IF;
  k := public.contract_number_key(NEW.contract_number);
  IF k IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.contract_number_counters AS c (code_key, year, last_number)
  VALUES (split_part(k, '|', 1), split_part(k, '|', 2)::int, split_part(k, '|', 3)::int)
  ON CONFLICT (code_key, year) DO UPDATE
    SET last_number = EXCLUDED.last_number, updated_at = now()
    WHERE c.last_number < EXCLUDED.last_number;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS contracts_number_counter ON public.contracts;
CREATE TRIGGER contracts_number_counter
  AFTER INSERT OR UPDATE OF contract_number, record_type ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.contracts_number_counter();

-- ── Уникальность номера по схеме ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dups text;
BEGIN
  SELECT string_agg(k || ' (ID ' || ids || ')', '; ') INTO dups
  FROM (SELECT public.contract_number_key(contract_number) AS k, string_agg(display_id::text, ', ' ORDER BY display_id) AS ids
        FROM public.contracts
        WHERE record_type = 'dp' AND public.contract_number_key(contract_number) IS NOT NULL
        GROUP BY 1 HAVING count(*) > 1) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'Номера по схеме КОД-ДП-ГГ-NNN уже повторяются у договоров: %. Исправьте номера и примените миграцию снова', dups;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS contracts_scheme_number_uniq ON public.contracts (public.contract_number_key(contract_number))
  WHERE record_type = 'dp' AND public.contract_number_key(contract_number) IS NOT NULL;

-- Счётчики по уже введённым номерам по схеме (на копии 02.11 их нет).
INSERT INTO public.contract_number_counters AS c (code_key, year, last_number)
SELECT split_part(k, '|', 1), split_part(k, '|', 2)::int, max(split_part(k, '|', 3)::int)
FROM (SELECT public.contract_number_key(contract_number) AS k FROM public.contracts WHERE record_type = 'dp') s
WHERE k IS NOT NULL
GROUP BY 1, 2
ON CONFLICT (code_key, year) DO UPDATE
  SET last_number = EXCLUDED.last_number, updated_at = now()
  WHERE c.last_number < EXCLUDED.last_number;
