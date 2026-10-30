-- Доставка в расценке снабжением (решение пользователя 30.10.2026): необязательная колонка «Доставка» в таблице
-- расценки — за единицу или суммой на позицию; заполнена — цена позиции за единицу = цена + доставка за единицу.
--  • tender_vor_supply_rates.delivery_input / delivery_value — доставка позиции как её ввели: за единицу (unit) или
--    суммой на объём позиции (total); пусто — доставки нет или она уже в цене (как раньше). Цена (price_input /
--    input_value) — по-прежнему цена материала, как её ввели.
--  • Расчёт (триггер tender_vor_supply_rates_compute): supply_price — цена за единицу С ДОСТАВКОЙ, supply_total — итог
--    с доставкой, supply_price_exact — точная цена, если цену или доставку ввели суммой. Поэтому карточка, «Сравнение
--    КП», выгрузка ВОР, реестр СУ-10, API и подбор цен из других тендеров видят цену с доставкой без правок.
--  • Цена, записанная напрямую (импорт Excel карточки, прежняя вкладка), — вся цена позиции: доставка снимается.
--  • Журнал цен (tender_supply_rate_log) пишет и доставку: правка одной доставки — тоже запись.
-- Существующие цены не пересчитываются и не меняются: у них доставки нет, расчёт без доставки — прежний.
-- Только добавление, повтор безопасен.
-- Требует 20261020_supply_pricing и 20261023_supply_rate_reuse. База нового портала —
-- migration/yandex/20261120_supply_rate_delivery.sql (те же колонки и функции).
BEGIN;

-- ── 1. Колонки ───────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_vor_supply_rates ADD COLUMN IF NOT EXISTS delivery_input text;
ALTER TABLE public.tender_vor_supply_rates ADD COLUMN IF NOT EXISTS delivery_value numeric;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tender_vor_supply_rates_delivery_check'
                 AND conrelid = 'public.tender_vor_supply_rates'::regclass) THEN
    ALTER TABLE public.tender_vor_supply_rates ADD CONSTRAINT tender_vor_supply_rates_delivery_check
      CHECK ((delivery_input IS NULL AND delivery_value IS NULL)
             OR (delivery_input IN ('unit', 'total') AND delivery_value > 0));
  END IF;
END
$$;
COMMENT ON COLUMN public.tender_vor_supply_rates.delivery_input IS
  'Доставка позиции (20261120): unit — за единицу, total — суммой на объём позиции; пусто — доставки нет (или она в цене)';
COMMENT ON COLUMN public.tender_vor_supply_rates.delivery_value IS
  'Доставка как ввели: за единицу или сумма (delivery_input). supply_price / supply_total — уже с доставкой';

ALTER TABLE public.tender_supply_rate_log ADD COLUMN IF NOT EXISTS delivery_input text;
ALTER TABLE public.tender_supply_rate_log ADD COLUMN IF NOT EXISTS delivery_value numeric;

-- ── 2. Расчёт: цена + доставка ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tender_vor_supply_rates_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_page boolean;
  v_priced boolean;
  v_src record;
  v_vol numeric;
  v_base numeric;
  v_base_total numeric;
  v_del numeric;
  v_del_total numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
    v_page := NEW.price_input IN ('unit', 'total');
  ELSE
    NEW.row_version := OLD.row_version + 1;
    v_page := NEW.price_input IN ('unit', 'total')
      AND (NEW.price_input IS DISTINCT FROM OLD.price_input
           OR NEW.input_value IS DISTINCT FROM OLD.input_value
           OR NEW.volume_at_input IS DISTINCT FROM OLD.volume_at_input
           OR NEW.delivery_input IS DISTINCT FROM OLD.delivery_input
           OR NEW.delivery_value IS DISTINCT FROM OLD.delivery_value);
  END IF;
  NEW.updated_by := auth.uid();

  IF v_page THEN
    IF NEW.input_value IS NULL OR NEW.input_value <= 0 THEN
      RAISE EXCEPTION 'Цена и сумма должны быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    IF (NEW.delivery_input IS NULL) <> (NEW.delivery_value IS NULL) OR NEW.delivery_value <= 0 THEN
      RAISE EXCEPTION 'Доставка должна быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_delivery';
    END IF;
    v_vol := CASE WHEN NEW.volume_at_input > 0 THEN NEW.volume_at_input END;
    IF v_vol IS NULL AND (NEW.price_input = 'total' OR NEW.delivery_input = 'total') THEN
      RAISE EXCEPTION 'Сумму можно ввести только у позиции с объёмом' USING ERRCODE = '23514', HINT = 'supply_volume';
    END IF;
    -- Цена материала и доставка: за единицу — до копейки, суммой — сумма до копейки. Цена позиции — их сумма
    -- (цена с доставкой); сумма доставки делится на объём, как сумма цены.
    IF NEW.price_input = 'unit' THEN
      v_base := round(NEW.input_value, 2);
      v_base_total := round(v_base * v_vol, 2);
    ELSE
      v_base_total := round(NEW.input_value, 2);
    END IF;
    IF NEW.delivery_input = 'unit' THEN
      v_del := round(NEW.delivery_value, 2);
      v_del_total := round(v_del * v_vol, 2);
    ELSIF NEW.delivery_input = 'total' THEN
      v_del_total := round(NEW.delivery_value, 2);
      v_del := v_del_total / v_vol;
    ELSE
      v_del := 0;
      v_del_total := 0;
    END IF;
    IF NEW.price_input = 'unit' AND coalesce(NEW.delivery_input, 'unit') = 'unit' THEN
      NEW.supply_price := v_base + v_del;
      NEW.supply_price_exact := NULL;
      NEW.supply_total := CASE WHEN v_vol IS NOT NULL THEN round(NEW.supply_price * v_vol, 2) END;
    ELSE
      NEW.supply_total := v_base_total + v_del_total;
      NEW.supply_price_exact := NEW.supply_total / v_vol;
      NEW.supply_price := round(NEW.supply_price_exact, 2);
    END IF;
    IF NEW.supply_price <= 0 THEN
      RAISE EXCEPTION 'Цена за единицу выходит меньше копейки' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.supply_price IS DISTINCT FROM OLD.supply_price THEN
    IF NEW.supply_price IS NULL OR NEW.supply_price <= 0 THEN
      RAISE EXCEPTION 'Цена должна быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    NEW.price_input := 'import';
    NEW.input_value := NEW.supply_price;
    NEW.volume_at_input := NULL;
    NEW.supply_price_exact := NULL;
    NEW.supply_total := NULL;
  END IF;
  -- Доставка — только у цены, введённой на сайте: цена из Excel (прямая запись цены) — вся цена позиции.
  IF NOT v_page AND NEW.price_input IS DISTINCT FROM 'unit' AND NEW.price_input IS DISTINCT FROM 'total' THEN
    NEW.delivery_input := NULL;
    NEW.delivery_value := NULL;
  END IF;

  -- Копия цены другого тендера: дата — исходной цены, источник — только своя (не скопированная) цена.
  -- Цена изменилась без нового источника — это уже своя цена: дата — сегодня (по Москве), отметка снимается.
  -- Иначе день расценки и отметка копии не меняются: прямой правкой колонки старую цену не «омолодить».
  v_priced := TG_OP = 'INSERT' OR NEW.supply_price IS DISTINCT FROM OLD.supply_price
              OR NEW.supply_price_exact IS DISTINCT FROM OLD.supply_price_exact;
  IF NEW.source_rate_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.source_rate_id IS DISTINCT FROM OLD.source_rate_id) THEN
    SELECT s.price_date, s.tender_id, s.source_rate_id AS copied INTO v_src
      FROM public.tender_vor_supply_rates s WHERE s.id = NEW.source_rate_id;
    IF NOT FOUND OR v_src.price_date IS NULL OR v_src.copied IS NOT NULL THEN
      RAISE EXCEPTION 'Исходная цена не найдена или сама скопирована из другого тендера' USING ERRCODE = '23514', HINT = 'supply_source';
    END IF;
    NEW.price_date := v_src.price_date;
    NEW.source_tender_id := v_src.tender_id;
    NEW.source_kind := coalesce(NEW.source_kind, 'pick');
    NEW.price_by := CASE WHEN NEW.source_kind = 'pick' THEN auth.uid() END;
  ELSIF v_priced OR OLD.price_date IS NULL THEN
    NEW.source_rate_id := NULL;
    NEW.source_tender_id := NULL;
    NEW.source_kind := NULL;
    NEW.price_date := (now() AT TIME ZONE 'Europe/Moscow')::date;
    NEW.price_by := auth.uid();
  ELSE
    NEW.price_date := OLD.price_date;
    NEW.price_by := OLD.price_by;
    NEW.source_rate_id := OLD.source_rate_id;
    NEW.source_tender_id := OLD.source_tender_id;
    NEW.source_kind := OLD.source_kind;
  END IF;
  RETURN NEW;
END
$$;

-- ── 3. Журнал цен: и доставка ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tender_supply_rate_log_write() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.supply_price IS NOT DISTINCT FROM OLD.supply_price
     AND NEW.supply_price_exact IS NOT DISTINCT FROM OLD.supply_price_exact
     AND NEW.supply_total IS NOT DISTINCT FROM OLD.supply_total
     AND NEW.price_input IS NOT DISTINCT FROM OLD.price_input
     AND NEW.estimate_name IS NOT DISTINCT FROM OLD.estimate_name
     AND NEW.material_name IS NOT DISTINCT FROM OLD.material_name
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit
     AND NEW.delivery_input IS NOT DISTINCT FROM OLD.delivery_input
     AND NEW.delivery_value IS NOT DISTINCT FROM OLD.delivery_value THEN
    RETURN NULL;
  END IF;
  SELECT nullif(btrim(ur.full_name), '') INTO v_name FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, material_name, unit,
      old_price, old_price_exact, old_total, old_input, delivery_input, delivery_value, changed_by, changed_by_name)
    VALUES (OLD.tender_id, OLD.id, 'delete', OLD.estimate_name, OLD.material_name, OLD.unit,
      OLD.supply_price, OLD.supply_price_exact, OLD.supply_total, OLD.price_input, OLD.delivery_input, OLD.delivery_value,
      auth.uid(), v_name);
  ELSE
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, old_estimate_name, material_name, unit,
      old_price, new_price, old_price_exact, new_price_exact, old_total, new_total, old_input, new_input,
      input_value, volume_at_input, delivery_input, delivery_value, changed_by, changed_by_name)
    VALUES (NEW.tender_id, NEW.id, lower(TG_OP), NEW.estimate_name,
      CASE WHEN TG_OP = 'UPDATE' AND OLD.estimate_name IS DISTINCT FROM NEW.estimate_name THEN OLD.estimate_name END,
      NEW.material_name, NEW.unit,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price END, NEW.supply_price,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price_exact END, NEW.supply_price_exact,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_total END, NEW.supply_total,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_input END, NEW.price_input,
      NEW.input_value, NEW.volume_at_input, NEW.delivery_input, NEW.delivery_value, auth.uid(), v_name);
  END IF;
  RETURN NULL;
END
$$;

COMMIT;
