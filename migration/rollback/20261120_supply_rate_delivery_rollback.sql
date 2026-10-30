-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261120_supply_rate_delivery.sql (Supabase): доставка больше не складывается с
-- ценой — расчёт и журнал цен прежние (20261023 / 20261020), страница без колонок доставки работает как раньше.
-- Данные НЕ удаляются: колонки доставки остаются (страница их не увидит, только если удалить колонки вручную), цены,
-- уже посчитанные с доставкой, остаются как есть — до следующей правки цены на сайте (тогда — без доставки).
-- Базе нового портала — тот же текст без BEGIN / COMMIT (функция журнала — с отметкой osp:internal, как в
-- migration/yandex/20261020_supply_pricing.sql). Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.tender_vor_supply_rates_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_page boolean;
  v_priced boolean;
  v_src record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
    v_page := NEW.price_input IN ('unit', 'total');
  ELSE
    NEW.row_version := OLD.row_version + 1;
    v_page := NEW.price_input IN ('unit', 'total')
      AND (NEW.price_input IS DISTINCT FROM OLD.price_input
           OR NEW.input_value IS DISTINCT FROM OLD.input_value
           OR NEW.volume_at_input IS DISTINCT FROM OLD.volume_at_input);
  END IF;
  NEW.updated_by := auth.uid();

  IF v_page THEN
    IF NEW.input_value IS NULL OR NEW.input_value <= 0 THEN
      RAISE EXCEPTION 'Цена и сумма должны быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    IF NEW.price_input = 'unit' THEN
      NEW.supply_price := round(NEW.input_value, 2);
      NEW.supply_price_exact := NULL;
      NEW.supply_total := CASE WHEN NEW.volume_at_input > 0 THEN round(NEW.supply_price * NEW.volume_at_input, 2) END;
    ELSE
      IF NEW.volume_at_input IS NULL OR NEW.volume_at_input <= 0 THEN
        RAISE EXCEPTION 'Сумму можно ввести только у позиции с объёмом' USING ERRCODE = '23514', HINT = 'supply_volume';
      END IF;
      NEW.supply_total := round(NEW.input_value, 2);
      NEW.supply_price_exact := NEW.supply_total / NEW.volume_at_input;
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
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit THEN
    RETURN NULL;
  END IF;
  SELECT nullif(btrim(ur.full_name), '') INTO v_name FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, material_name, unit,
      old_price, old_price_exact, old_total, old_input, changed_by, changed_by_name)
    VALUES (OLD.tender_id, OLD.id, 'delete', OLD.estimate_name, OLD.material_name, OLD.unit,
      OLD.supply_price, OLD.supply_price_exact, OLD.supply_total, OLD.price_input, auth.uid(), v_name);
  ELSE
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, old_estimate_name, material_name, unit,
      old_price, new_price, old_price_exact, new_price_exact, old_total, new_total, old_input, new_input,
      input_value, volume_at_input, changed_by, changed_by_name)
    VALUES (NEW.tender_id, NEW.id, lower(TG_OP), NEW.estimate_name,
      CASE WHEN TG_OP = 'UPDATE' AND OLD.estimate_name IS DISTINCT FROM NEW.estimate_name THEN OLD.estimate_name END,
      NEW.material_name, NEW.unit,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price END, NEW.supply_price,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price_exact END, NEW.supply_price_exact,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_total END, NEW.supply_total,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_input END, NEW.price_input,
      NEW.input_value, NEW.volume_at_input, auth.uid(), v_name);
  END IF;
  RETURN NULL;
END
$$;

COMMIT;
