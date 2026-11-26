-- «Заявки на проверку ДП/ДС» → «Реестр по договорам» сразу при подаче (решение пользователя 24.11.2026). Подробно — в базе
-- нового портала: migration/yandex/20270228_doc_check_registry_docs.sql. Тело то же; здесь — права функций для ролей Supabase.
-- Нужны 20270225 и 20270226. Повтор безопасен. Проверка: migration/backup/checks/20270228.sql, откат —
-- migration/rollback/20270228_doc_check_registry_docs_rollback.sql. Применять в нерабочее время: пересоздание триггера ненадолго
-- блокирует доску ДП/ДС.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regprocedure('public.dp_conclusion_contract_create(uuid, text)') IS NULL
     OR to_regprocedure('public.osp_first_lawyer(uuid[])') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
                    AND column_name = 'responsible_user_id') THEN
    RAISE EXCEPTION 'Нет договоров из заявок и юристов реестра: сначала 20270225_dp_conclusion_registry_contract и 20270226_registry_osp_lawyers';
  END IF;
END
$$;

-- ── Номер документа из заявки ─────────────────────────────────────────────────────────────────────────
-- Как его видит человек: без невидимых знаков (их приносит копирование из почты и мессенджеров: «‌СУ2-…» с U+200C впереди),
-- неразрывные пробелы — обычные, пробелы сжаты. Пусто — NULL.
CREATE OR REPLACE FUNCTION public.doc_check_number_clean(p text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT nullif(btrim(regexp_replace(regexp_replace(translate(coalesce(p, ''), U&'\00A0\2007\202F', '   '),
                                                    U&'[\200B\200C\200D\2060\FEFF]', '', 'g'), '\s+', ' ', 'g')), '')
$$;

-- Номер для сравнения: заглавными, «Ё» = «Е», латиница-двойник — кириллицей («C» = «С»), «№» и кавычки — пробелом, пробелы сжаты.
CREATE OR REPLACE FUNCTION public.doc_check_number_spaced(p text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT nullif(btrim(regexp_replace(translate(upper(coalesce(public.doc_check_number_clean(p), '')), 'ЁABCEHKMOPTXY', 'ЕАВСЕНКМОРТХУ'),
                                     '[\s№"«»'']+', ' ', 'g')), '')
$$;

-- Ключ сравнения номеров — тот же номер без пробелов.
CREATE OR REPLACE FUNCTION public.doc_check_number_key(p text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT nullif(replace(coalesce(public.doc_check_number_spaced(p), ''), ' ', ''), '')
$$;

-- Номер договора стоит в номере ДС отдельно, а не частью другого номера: «15/26» не содержит «5/26», «Т-12» — «Т-1». Оба
-- аргумента — doc_check_number_spaced.
CREATE OR REPLACE FUNCTION public.doc_check_number_contains(p_hay text, p_needle text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_hay, '') <> '' AND coalesce(p_needle, '') <> '' AND strpos(p_hay, p_needle) > 0
    AND substr(p_hay, strpos(p_hay, p_needle) - 1, 1) !~ '[0-9A-ZА-Я]'
    AND substr(p_hay, strpos(p_hay, p_needle) + length(p_needle), 1) !~ '[0-9A-ZА-Я]'
$$;

-- Вид заявки словами — для «Истории» заявки и договора.
CREATE OR REPLACE FUNCTION public.doc_check_type_title(p text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT CASE p WHEN 'dp_conclusion' THEN 'Заключение ДП' WHEN 'dp' THEN 'Проверка ДП' WHEN 'ds' THEN 'Проверка ДС' ELSE coalesce(p, '—') END
$$;

-- Запись в «Историю» заявки от базы: автор — вошедший, у выкладки — «Автоматически».
CREATE OR REPLACE FUNCTION public.doc_check_registry_note(p_request uuid, p_event text, p_new jsonb, p_description text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_name text;
  v_role text;
BEGIN
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  INSERT INTO public.doc_check_request_audit_log
    (request_id, event_type, field_name, new_value, description, changed_at, changed_by_role, changed_by_name)
  VALUES (p_request, p_event, NULL, p_new, p_description, now(), v_role, coalesce(v_name, 'Автоматически'));
END
$$;

-- ── «Проверка ДП» / «Проверка ДС» → документ «Реестра по договорам» ──────────────────────────────────
-- «Проверка ДП» — договор подряда: объект, контрагент (+ contract_counterparties), тендер, номер и дата документа из заявки.
-- Дубль — живой договор того же объекта и контрагента с тем же номером (ключ doc_check_number_key); у заявки без номера —
-- договор, внесённый вручную не раньше дня подачи. Номер по схеме КОД-ДП-ГГ-NNN уже занят — договор без номера, номер заявки —
-- в примечании.
-- «Проверка ДС» — «ДС на дополнительные работы» (решение пользователя 24.11.2026: тип после создания не меняется, этот крепится
-- прямо к договору) к договору подрядчика на объекте: чей номер стоит в номере ДС; нет такого — единственный договор подрядчика
-- на объекте. Не нашёлся или их несколько — ДС не вносится (решение пользователя 24.11.2026), причина — в «Истории» заявки.
-- Номер ДС — только голое число из номера заявки без номера договора («ДС №1 СУ2-…» → «1»), иначе пусто; такое ДС у договора
-- уже есть — дубль.
-- Заявка в «Новых» — «Новая заявка» без даты «Принят в работу», иначе — «В работе» с сегодняшней датой по Москве. Юрист —
-- первый действующий юрист ОСП среди исполнителей. Ни одна ошибка заявку не роняет: отказ базы — запись в «Истории».
-- → id созданного документа или NULL.
CREATE OR REPLACE FUNCTION public.doc_check_registry_doc_create(p_request uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  r public.doc_check_requests%ROWTYPE;
  p public.contracts%ROWTYPE;
  v_title text;
  v_num text;
  v_number text;
  v_key text;
  v_spaced text;
  v_new boolean;
  v_today date := (now() AT TIME ZONE 'Europe/Moscow')::date;
  v_lawyer uuid;
  v_dup_id uuid;
  v_dup_display bigint;
  v_total integer;
  v_hits integer;
  v_single uuid;
  v_list text;
  v_rest text;
  v_ds_number text;
  v_notes text;
  v_id uuid;
  v_display bigint;
  v_name text;
  v_role text;
  v_word text;
BEGIN
  SELECT * INTO r FROM public.doc_check_requests WHERE id = p_request;
  IF NOT FOUND OR r.doc_type NOT IN ('dp', 'ds') OR r.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id) THEN RETURN NULL; END IF;

  v_title := public.doc_check_type_title(r.doc_type);
  v_num := coalesce(to_jsonb(r) ->> 'request_number', '—');
  v_number := left(public.doc_check_number_clean(r.doc_number), 100);
  v_key := public.doc_check_number_key(r.doc_number);
  v_spaced := public.doc_check_number_spaced(r.doc_number);
  v_new := r.status = 'new';
  v_lawyer := public.osp_first_lawyer(r.assignee_ids);
  v_notes := concat_ws(E'\n', 'Из заявки «' || v_title || '» ID ' || v_num, nullif(btrim(r.notes), ''));

  IF r.doc_type = 'dp' THEN
    v_word := 'Договор';
    IF r.object_id IS NOT NULL THEN
      SELECT c.id, c.display_id INTO v_dup_id, v_dup_display FROM public.contracts c
      WHERE c.record_type = 'dp' AND c.deleted_at IS NULL AND c.object_id = r.object_id
        AND (r.counterparty_id IS NULL OR c.counterparty_id = r.counterparty_id
             OR EXISTS (SELECT 1 FROM public.contract_counterparties cc WHERE cc.contract_id = c.id AND cc.counterparty_id = r.counterparty_id))
        AND CASE WHEN v_key IS NOT NULL THEN public.doc_check_number_key(c.contract_number) = v_key
                 ELSE c.doc_check_request_id IS NULL AND c.created_at >= date_trunc('day', r.created_at) END
      ORDER BY c.created_at DESC, c.id LIMIT 1;
      IF v_dup_id IS NOT NULL THEN
        PERFORM public.doc_check_registry_note(r.id, 'registry_skipped',
          jsonb_build_object('reason', 'duplicate', 'contract_id', v_dup_id, 'display_id', v_dup_display),
          'В «Реестр по договорам» не внесена: там уже есть договор ID ' || v_dup_display
            || CASE WHEN v_key IS NOT NULL THEN ' с тем же номером, объектом и контрагентом'
                    ELSE ' того же объекта и контрагента, внесённый после подачи заявки' END);
        RETURN NULL;
      END IF;
    END IF;

    BEGIN
      INSERT INTO public.contracts (record_type, status, object_id, counterparty_id, tender_id, contract_number, contract_date,
                                    accepted_date, notes, doc_check_request_id, responsible_user_id)
      VALUES ('dp', CASE WHEN v_new THEN 'new_request' ELSE 'in_work' END, r.object_id, r.counterparty_id,
              (to_jsonb(r) ->> 'tender_id')::uuid, v_number, r.doc_date, CASE WHEN v_new THEN NULL ELSE v_today END,
              v_notes, r.id, v_lawyer)
      ON CONFLICT (doc_check_request_id) WHERE doc_check_request_id IS NOT NULL DO NOTHING
      RETURNING id, display_id INTO v_id, v_display;
    EXCEPTION WHEN unique_violation THEN
      -- Номер по схеме КОД-ДП-ГГ-NNN уже у другого договора (contracts_scheme_number_uniq, считает и удалённые).
      INSERT INTO public.contracts (record_type, status, object_id, counterparty_id, tender_id, contract_number, contract_date,
                                    accepted_date, notes, doc_check_request_id, responsible_user_id)
      VALUES ('dp', CASE WHEN v_new THEN 'new_request' ELSE 'in_work' END, r.object_id, r.counterparty_id,
              (to_jsonb(r) ->> 'tender_id')::uuid, NULL, r.doc_date, CASE WHEN v_new THEN NULL ELSE v_today END,
              concat_ws(E'\n', v_notes, '№ в заявке: ' || v_number || ' — такой номер в реестре уже занят'), r.id, v_lawyer)
      ON CONFLICT (doc_check_request_id) WHERE doc_check_request_id IS NOT NULL DO NOTHING
      RETURNING id, display_id INTO v_id, v_display;
    END;
    IF v_id IS NULL THEN RETURN NULL; END IF;
    IF r.counterparty_id IS NOT NULL THEN
      INSERT INTO public.contract_counterparties (contract_id, counterparty_id, sort_order)
      VALUES (v_id, r.counterparty_id, 0)
      ON CONFLICT (contract_id, counterparty_id) DO NOTHING;
    END IF;
  ELSE
    v_word := 'ДС';
    IF r.object_id IS NULL OR r.counterparty_id IS NULL THEN
      PERFORM public.doc_check_registry_note(r.id, 'registry_skipped', jsonb_build_object('reason', 'no_contract'),
        'В «Реестр по договорам» не внесена: для ДС нужен договор, а в заявке не указан объект или контрагент');
      RETURN NULL;
    END IF;

    -- Договоры подрядчика на объекте; совпадение — номер договора стоит в номере ДС отдельным номером (doc_check_number_contains),
    -- из нескольких — самый длинный.
    WITH cand AS (
      SELECT c.id, c.display_id, public.doc_check_number_key(c.contract_number) AS k,
             public.doc_check_number_spaced(c.contract_number) AS sp FROM public.contracts c
      WHERE c.record_type = 'dp' AND c.deleted_at IS NULL AND c.object_id = r.object_id
        AND (c.counterparty_id = r.counterparty_id
             OR EXISTS (SELECT 1 FROM public.contract_counterparties cc WHERE cc.contract_id = c.id AND cc.counterparty_id = r.counterparty_id))
    ), hit AS (
      SELECT cand.id, length(cand.k) AS len FROM cand
      WHERE length(cand.k) >= 3 AND public.doc_check_number_contains(v_spaced, cand.sp)
    ), best AS (SELECT hit.id FROM hit WHERE hit.len = (SELECT max(h.len) FROM hit h))
    SELECT (SELECT count(*) FROM cand), (SELECT string_agg(cand.display_id::text, ', ' ORDER BY cand.display_id) FROM cand),
           (SELECT count(*) FROM best), (SELECT min(best.id::text)::uuid FROM best),
           (SELECT min(cand.id::text)::uuid FROM cand)
    INTO v_total, v_list, v_hits, v_dup_id, v_single;
    IF v_hits = 1 THEN
      SELECT * INTO p FROM public.contracts WHERE id = v_dup_id;
    ELSIF v_hits = 0 AND v_total = 1 THEN
      SELECT * INTO p FROM public.contracts WHERE id = v_single;
    ELSE
      PERFORM public.doc_check_registry_note(r.id, 'registry_skipped',
        jsonb_build_object('reason', 'no_contract', 'candidates', v_total),
        'В «Реестр по договорам» не внесена: ' || CASE WHEN v_total = 0 THEN 'договора с этим контрагентом на объекте в реестре нет'
          ELSE 'у контрагента на объекте несколько договоров (ID ' || v_list || '), номер договора в заявке не найден' END
          || ' — ДС внесёт юрист');
      RETURN NULL;
    END IF;

    -- Номер ДС: из номера заявки убираем номер договора, «ДС», «доп. соглашение», «к договору»; осталось голое число — оно.
    v_rest := coalesce(v_key, '');
    IF public.doc_check_number_key(p.contract_number) IS NOT NULL THEN
      v_rest := replace(v_rest, public.doc_check_number_key(p.contract_number), '');
    END IF;
    v_rest := regexp_replace(v_rest, 'ОТ[0-9]{1,2}[./][0-9]{1,2}[./][0-9]{2,4}(Г\.?)?$', '');
    v_rest := regexp_replace(v_rest, '^(ДОП\.?(ОЛНИТЕЛЬНОЕ)?\.?СОГЛАШЕНИЕ|ДС)', '');
    v_rest := regexp_replace(v_rest, '(К(ДОГОВОРУ|ДП)?|ДОГОВОРУ|ДП)$', '');
    v_rest := regexp_replace(v_rest, '^[-_.,:;/]+|[-_.,:;/]+$', '', 'g');
    v_ds_number := CASE WHEN v_rest ~ '^[0-9]{1,4}([./][0-9]{1,3})*$' THEN v_rest END;

    -- Дубль: такое ДС у договора уже есть; у заявки без номера ДС — ДС, внесённое вручную не раньше дня подачи.
    SELECT c.id, c.display_id INTO v_dup_id, v_dup_display FROM public.contracts c
    WHERE c.root_contract_id = p.id AND c.record_type <> 'dp' AND c.deleted_at IS NULL
      AND CASE WHEN v_ds_number IS NOT NULL THEN btrim(c.contract_number) = v_ds_number
               ELSE c.doc_check_request_id IS NULL AND c.created_at >= date_trunc('day', r.created_at) END
    ORDER BY c.created_at DESC, c.id LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
      PERFORM public.doc_check_registry_note(r.id, 'registry_skipped',
        jsonb_build_object('reason', 'duplicate', 'contract_id', v_dup_id, 'display_id', v_dup_display),
        'В «Реестр по договорам» не внесена: у договора ID ' || p.display_id || ' уже есть ДС ID ' || v_dup_display
          || CASE WHEN v_ds_number IS NOT NULL THEN ' № ' || v_ds_number ELSE ', внесённое после подачи заявки' END);
      RETURN NULL;
    END IF;

    INSERT INTO public.contracts (record_type, parent_contract_id, status, object_id, counterparty_id, contract_number, contract_date,
                                  accepted_date, notes, doc_check_request_id, responsible_user_id)
    VALUES ('ds_extra', p.id, CASE WHEN v_new THEN 'new_request' ELSE 'in_work' END, p.object_id, p.counterparty_id,
            v_ds_number, r.doc_date, CASE WHEN v_new THEN NULL ELSE v_today END,
            concat_ws(E'\n', 'Из заявки «' || v_title || '» ID ' || v_num
                               || CASE WHEN v_number IS DISTINCT FROM v_ds_number THEN ' (№ в заявке: ' || v_number || ')' ELSE '' END,
                      nullif(btrim(r.notes), '')),
            r.id, v_lawyer)
    ON CONFLICT (doc_check_request_id) WHERE doc_check_request_id IS NOT NULL DO NOTHING
    RETURNING id, display_id INTO v_id, v_display;
    IF v_id IS NULL THEN RETURN NULL; END IF;
    INSERT INTO public.contract_counterparties (contract_id, counterparty_id, sort_order)
    SELECT v_id, cc.counterparty_id, cc.sort_order FROM public.contract_counterparties cc WHERE cc.contract_id = p.id
    ON CONFLICT (contract_id, counterparty_id) DO NOTHING;
  END IF;

  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;

  INSERT INTO public.contract_audit_log (contract_id, event_type, new_value, description, changed_by_role, changed_by_name)
  VALUES (v_id, 'created',
          jsonb_build_object('doc_check_request_id', r.id, 'request_number', v_num, 'responsible_user_id', v_lawyer,
                             'parent_contract_id', p.id),
          CASE WHEN r.doc_type = 'dp' THEN 'Создан договор ' ELSE 'Создано ДС на дополнительные работы к договору ID ' || p.display_id || ' ' END
            || p_reason
            || coalesce('; ответственный юрист — ' || public.osp_user_display_name(v_lawyer) || ' (исполнитель заявки)', ''),
          v_role, v_name);

  PERFORM public.doc_check_registry_note(r.id, 'contract_created',
    jsonb_build_object('contract_id', v_id, 'display_id', v_display, 'record_type', CASE WHEN r.doc_type = 'dp' THEN 'dp' ELSE 'ds_extra' END),
    CASE WHEN r.doc_type = 'dp' THEN 'Договор создан' ELSE 'ДС создано' END || ' в «Реестре по договорам»: ID ' || v_display
      || CASE WHEN r.doc_type = 'ds' THEN ' (к договору ID ' || p.display_id || ')' ELSE '' END);
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  -- Отказ базы (проверки договоров, длина поля, сбой) заявку не роняет: она сохраняется, причина — в «Истории».
  PERFORM public.doc_check_registry_note(p_request, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
    'В «Реестр по договорам» не внесена: ' || SQLERRM);
  RETURN NULL;
END
$$;

-- ── Триггер доски: документ реестра для всех трёх видов заявки ────────────────────────────────────────
-- «Заключение ДП» — как в 20270226 (dp_conclusion_contract_create). «Проверка ДП/ДС» — doc_check_registry_doc_create: при подаче,
-- а пока заявка в «Новых» — и когда поправили вид, объект, контрагента или номер (документа ещё нет) или восстановили заявку.
-- Есть документ — то же, что в 20270226, для всех видов: ушла из «Новых» — «Новая заявка» → «В работе»; удалили, пока «Новая
-- заявка», — в «Удалённые», восстановили — обратно; юрист следует за исполнителями. Вид сменили между ДП и ДС, пока документ
-- «Новая заявка», — он в «Удалённые» и отвязан, вместо него — документ нового вида. Ни одна ошибка реестра заявку не роняет.
CREATE OR REPLACE FUNCTION public.doc_check_dp_conclusion_contract() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  k public.contracts%ROWTYPE;
  v_has boolean;
  v_title text := public.doc_check_type_title(NEW.doc_type);
  v_num text := coalesce(to_jsonb(NEW) ->> 'request_number', '—');
  v_what text;
  v_name text;
  v_role text;
  v_lawyer uuid;
  v_last record;
BEGIN
  SELECT * INTO k FROM public.contracts c WHERE c.doc_check_request_id = NEW.id;
  v_has := FOUND;

  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  v_name := coalesce(v_name, 'Автоматически');

  -- Вид сменили между ДП и ДС: документ другого вида, с которым ещё не работали, — в «Удалённые» и отвязан.
  IF v_has AND TG_OP = 'UPDATE' AND NEW.doc_type IS DISTINCT FROM OLD.doc_type
     AND (k.record_type = 'dp') <> (NEW.doc_type <> 'ds') AND k.status = 'new_request' THEN
    BEGIN
      UPDATE public.contracts SET deleted_at = coalesce(deleted_at, now()), doc_check_request_id = NULL WHERE id = k.id;
      INSERT INTO public.contract_audit_log (contract_id, event_type, new_value, description, changed_by_role, changed_by_name)
      VALUES (k.id, 'soft_deleted', jsonb_build_object('doc_check_request_retyped', NEW.id),
              CASE WHEN k.record_type = 'dp' THEN 'Договор перенесён' ELSE 'ДС перенесено' END || ' в «Удалённые»: заявка ID '
                || v_num || ' стала «' || v_title || '»', v_role, v_name);
      v_has := false;
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.doc_check_registry_note(NEW.id, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
        'Вид заявки сменён, а документ реестра ID ' || k.display_id || ' остался: ' || SQLERRM);
      RETURN NULL;
    END;
  END IF;

  IF NOT v_has THEN
    IF NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
    IF NEW.doc_type = 'dp_conclusion' THEN
      IF TG_OP = 'INSERT' OR NEW.doc_type IS DISTINCT FROM OLD.doc_type OR OLD.deleted_at IS NOT NULL THEN
        BEGIN
          PERFORM public.dp_conclusion_contract_create(NEW.id, 'автоматически: '
            || CASE WHEN TG_OP = 'INSERT' THEN 'подана' ELSE 'на доске' END || ' заявка «Заключение ДП» ID ' || v_num);
        EXCEPTION WHEN OTHERS THEN
          PERFORM public.doc_check_registry_note(NEW.id, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
            'В «Реестр по договорам» не внесена: ' || SQLERRM);
        END;
      END IF;
    ELSIF TG_OP = 'INSERT'
          OR (NEW.status = 'new' AND (NEW.doc_type IS DISTINCT FROM OLD.doc_type OR OLD.deleted_at IS NOT NULL
                                      OR NEW.object_id IS DISTINCT FROM OLD.object_id
                                      OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id
                                      OR NEW.doc_number IS DISTINCT FROM OLD.doc_number)) THEN
      PERFORM public.doc_check_registry_doc_create(NEW.id, 'автоматически: '
        || CASE WHEN TG_OP = 'INSERT' THEN 'подана' ELSE 'поправлена' END || ' заявка «' || v_title || '» ID ' || v_num);
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;

  v_what := CASE WHEN k.record_type = 'dp' THEN 'Договор' ELSE 'ДС' END;

  -- Заявку удалили: документ, с которым ещё не начинали работать («Новая заявка»), — в «Удалённые».
  IF NEW.deleted_at IS NOT NULL THEN
    IF OLD.deleted_at IS NULL AND k.deleted_at IS NULL AND k.status = 'new_request' THEN
      BEGIN
        UPDATE public.contracts SET deleted_at = now() WHERE id = k.id;
        INSERT INTO public.contract_audit_log (contract_id, event_type, new_value, description, changed_by_role, changed_by_name)
        VALUES (k.id, 'soft_deleted', jsonb_build_object('doc_check_request_deleted', NEW.id),
                v_what || ' перенесён' || CASE WHEN v_what = 'ДС' THEN 'о' ELSE '' END || ' в «Удалённые»: заявка «' || v_title
                  || '» ID ' || v_num || ' удалена на доске', v_role, v_name);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public.doc_check_registry_note(NEW.id, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
          'Заявка удалена, а документ реестра ID ' || k.display_id || ' остался: ' || SQLERRM);
      END;
    END IF;
    RETURN NULL;
  END IF;

  -- Заявку восстановили: документ возвращается, если в «Удалённые» его унесло удаление заявки и с тех пор его не трогали.
  IF OLD.deleted_at IS NOT NULL AND k.deleted_at IS NOT NULL THEN
    SELECT l.event_type, l.new_value INTO v_last FROM public.contract_audit_log l
    WHERE l.contract_id = k.id ORDER BY l.changed_at DESC, l.id DESC LIMIT 1;
    IF v_last.event_type = 'soft_deleted' AND v_last.new_value ? 'doc_check_request_deleted' THEN
      BEGIN
        UPDATE public.contracts SET deleted_at = NULL WHERE id = k.id;
        k.deleted_at := NULL;
        INSERT INTO public.contract_audit_log (contract_id, event_type, description, changed_by_role, changed_by_name)
        VALUES (k.id, 'restored', v_what || ' восстановлен' || CASE WHEN v_what = 'ДС' THEN 'о' ELSE '' END || ': заявка «' || v_title
                  || '» ID ' || v_num || ' восстановлена на доске', v_role, v_name);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public.doc_check_registry_note(NEW.id, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
          'Заявка восстановлена, а документ реестра ID ' || k.display_id || ' остался в «Удалённых»: ' || SQLERRM);
      END;
    END IF;
  END IF;
  IF k.deleted_at IS NOT NULL THEN RETURN NULL; END IF;

  -- Заявка ушла из «Новых»: «Новая заявка» → «В работе», «Принят в работу» — сегодня, если не стоит.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'new' AND k.status = 'new_request' THEN
    BEGIN
      UPDATE public.contracts SET status = 'in_work', accepted_date = coalesce(accepted_date, (now() AT TIME ZONE 'Europe/Moscow')::date)
      WHERE id = k.id;
      INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
      VALUES (k.id, 'status_changed', 'status', to_jsonb('new_request'::text), to_jsonb('in_work'::text),
              'Статус: «Новая заявка» → «В работе»: заявка «' || v_title || '» ID ' || v_num || ' взята в работу', v_role, v_name);
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.doc_check_registry_note(NEW.id, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
        'Статус документа реестра ID ' || k.display_id || ' не сменился: ' || SQLERRM);
    END;
  END IF;

  -- Исполнители заявки сменились: юрист документа — первый действующий юрист ОСП из них, пока юрист пуст или он из прежних
  -- исполнителей и снят с заявки. Поставленного в реестре вручную (не из исполнителей заявки) не трогаем.
  IF NEW.assignee_ids IS DISTINCT FROM OLD.assignee_ids
     AND (k.responsible_user_id IS NULL
          OR (k.responsible_user_id = ANY (coalesce(OLD.assignee_ids, '{}'::uuid[]))
              AND NOT k.responsible_user_id = ANY (coalesce(NEW.assignee_ids, '{}'::uuid[])))) THEN
    v_lawyer := public.osp_first_lawyer(NEW.assignee_ids);
    IF v_lawyer IS DISTINCT FROM k.responsible_user_id THEN
      BEGIN
        UPDATE public.contracts SET responsible_user_id = v_lawyer WHERE id = k.id;
        INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
        VALUES (k.id, 'field_updated', 'responsible_user_id',
                to_jsonb(public.osp_user_display_name(k.responsible_user_id)), to_jsonb(public.osp_user_display_name(v_lawyer)),
                'Ответственный юрист: ' || coalesce(public.osp_user_display_name(k.responsible_user_id), '—') || ' → '
                  || coalesce(public.osp_user_display_name(v_lawyer), '—') || ' (исполнители заявки «' || v_title || '» ID ' || v_num || ')',
                v_role, v_name);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public.doc_check_registry_note(NEW.id, 'registry_skipped', jsonb_build_object('reason', 'error', 'error', SQLERRM),
          'Юрист документа реестра ID ' || k.display_id || ' не сменился: ' || SQLERRM);
      END;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_dp_conclusion_contract ON public.doc_check_requests;
CREATE TRIGGER doc_check_dp_conclusion_contract
  AFTER INSERT OR UPDATE OF status, doc_type, deleted_at, assignee_ids, object_id, counterparty_id, doc_number ON public.doc_check_requests
  FOR EACH ROW WHEN (NEW.doc_type IN ('dp_conclusion', 'dp', 'ds'))
  EXECUTE FUNCTION public.doc_check_dp_conclusion_contract();

-- ── Заявки «Проверка ДП/ДС», которые уже в «Новых» ───────────────────────────────────────────────────
-- Решение пользователя 24.11.2026: «новые заявки, которые сейчас есть, создай, если нет их дубликатов». «Сейчас» — время просьбы:
-- заявки в «Новых» на момент выкладки и те, что ушли из «Новых» после просьбы (24.11, 15:50 по Москве; до выкладки их могли взять
-- в работу — документ тогда «В работе»). Сначала ДП, потом ДС
-- (ДС находит договор, только что созданный из заявки). Пара «Проверка ДП» + «Проверка ДС» в «Новых» с тем же объектом,
-- контрагентом и номером — одна заявка, поданная дважды (на проде — 954 и 955): верна та, у которой есть файлы, другой —
-- пометка в примечании («вероятно, ошибочное создание»), в реестр её не вносим. Повтор безопасен: пометка и запись «не
-- внесена» — один раз, документ на заявку — один.
DO $$
DECLARE
  q record;
  v_mark constant text := 'Вероятно, ошибочное создание';
  -- Время просьбы пользователя: заявки, ушедшие из «Новых» раньше (24.11 утром ушли семь), просьба не касалась.
  v_since constant timestamptz := timestamptz '2026-11-24 15:50:00+03';
  v_text text;
  v_made integer := 0;
  v_skipped integer := 0;
  v_marked integer := 0;
BEGIN
  FOR q IN
    WITH live AS (
      SELECT r.id, r.doc_type, r.object_id, r.counterparty_id, r.notes, coalesce(to_jsonb(r) ->> 'request_number', '—') AS num,
             public.doc_check_number_key(r.doc_number) AS k,
             EXISTS (SELECT 1 FROM public.s3_documents d WHERE d.owner_type = 'doc_check_request' AND d.owner_id = r.id) AS has_files
      FROM public.doc_check_requests r
      WHERE r.doc_type IN ('dp', 'ds') AND r.deleted_at IS NULL
        AND (r.status = 'new' OR EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l
                                         WHERE l.request_id = r.id AND l.event_type = 'status_changed'
                                           AND l.old_value = to_jsonb('new'::text) AND l.changed_at >= v_since))
        AND NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id)
    ), pair AS (
      SELECT CASE WHEN a.has_files THEN b.id ELSE a.id END AS id,
             CASE WHEN a.has_files THEN b.notes ELSE a.notes END AS notes,
             CASE WHEN a.has_files THEN a.num ELSE b.num END AS good_num,
             CASE WHEN a.has_files THEN a.doc_type ELSE b.doc_type END AS good_type
      FROM live a JOIN live b ON a.doc_type = 'dp' AND b.doc_type = 'ds' AND a.object_id = b.object_id
        AND a.counterparty_id = b.counterparty_id AND a.k = b.k AND a.has_files <> b.has_files
    )
    SELECT * FROM pair WHERE coalesce(pair.notes, '') NOT LIKE '%' || v_mark || '%' ORDER BY pair.id
  LOOP
    v_text := v_mark || ': та же заявка подана как «' || public.doc_check_type_title(q.good_type) || '» ID ' || q.good_num
      || ' (с файлами). В «Реестр по договорам» эта не внесена.';
    UPDATE public.doc_check_requests SET notes = concat_ws(E'\n', nullif(btrim(notes), ''), v_text)
    WHERE id = q.id AND coalesce(notes, '') NOT LIKE '%' || v_mark || '%';
    IF FOUND THEN
      INSERT INTO public.doc_check_request_audit_log
        (request_id, event_type, field_name, old_value, new_value, description, changed_at, changed_by_name)
      VALUES (q.id, 'field_updated', 'notes', to_jsonb(q.notes),
              to_jsonb(concat_ws(E'\n', nullif(btrim(q.notes), ''), v_text)), NULL, now(), 'Автоматически');
      v_marked := v_marked + 1;
    END IF;
  END LOOP;

  FOR q IN
    SELECT r.id, r.doc_type, coalesce(to_jsonb(r) ->> 'request_number', '—') AS num
    FROM public.doc_check_requests r
    WHERE r.doc_type IN ('dp', 'ds') AND r.deleted_at IS NULL
      AND (r.status = 'new' OR EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l
                                       WHERE l.request_id = r.id AND l.event_type = 'status_changed'
                                         AND l.old_value = to_jsonb('new'::text) AND l.changed_at >= v_since))
      AND coalesce(r.notes, '') NOT LIKE '%' || v_mark || '%'
      AND NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM public.doc_check_request_audit_log l WHERE l.request_id = r.id AND l.event_type = 'registry_skipped')
    ORDER BY r.doc_type = 'ds', r.created_at, r.id
  LOOP
    IF public.doc_check_registry_doc_create(q.id, 'при выкладке: заявка «' || public.doc_check_type_title(q.doc_type) || '» ID '
                                                  || q.num || ' уже была в «Новых»') IS NOT NULL THEN
      v_made := v_made + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Заявки «Проверка ДП/ДС» из «Новых»: документов создано %, не внесено %, помечено как вероятно ошибочные %',
    v_made, v_skipped, v_marked;
END
$$;

-- ── Права ─────────────────────────────────────────────────────────────────────────────────────────────
-- Служебные — страница их не вызывает; номер и вид словами — чистые функции, вызываются только из служебных.
REVOKE ALL ON FUNCTION public.doc_check_registry_note(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_registry_doc_create(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_dp_conclusion_contract() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_number_clean(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_number_spaced(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_number_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_number_contains(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_type_title(text) FROM PUBLIC, anon, authenticated;

COMMIT;
