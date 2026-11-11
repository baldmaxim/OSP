-- Кабинет подрядчика: анкета участника и «Моя компания» — одни сведения (просьба пользователя 11.11.2026: «должно автоматом
-- состыковываться информация из „Моей компании“ и то, что заполняется под тендером; в дальнейшем будут создаваться или убираться
-- поля и там и там»), только база Яндекса. Нужна 20261102.
--
-- Поле анкеты бывает двух видов:
--  • о компании (scope = 'company') — ответ один на компанию: заполняется один раз (в анкете любого тендера или в «Моей компании»),
--    подставляется в анкету каждого тендера и виден в «Моей компании»: СРО, дата регистрации, оборот…;
--  • по тендеру (scope = 'tender', как раньше) — свой ответ в каждом тендере: посещение объекта, авансирование, примечание к ТКП.
-- Поле о компании может быть связано со сведением карточки компании (source): название, ИНН, адрес, ставка НДС, сайт, руководитель,
-- контактное лицо. Тогда ответ — из карточки (её ведёт отдел), а пусто в карточке — подрядчик отвечает сам, и ответ хранится как у
-- поля о компании. Перечень сведений карточки и как из них собирается ответ — на странице (src/utils/bidFormLinks.js): новое сведение
-- карточки — строка там, база хранит только ключ. Связь и вид поля выбирает администратор в «Полях анкеты».
--
--  • bid_form_fields.scope, bid_form_fields.source — вид поля и ключ сведения карточки (одно сведение — одному полю).
--    Поля по умолчанию получают связь и вид по подписи (только где связи ещё нет).
--  • bid_company_answers — ответы организации на поля о компании (строка на организацию). Читают организация и администратор,
--    пишет только bid_company_save.
--  • bid_company_save(p_answers) — записать ответы о компании и в анкеты идущих тендеров организации, где она может менять анкету
--    (bid_can_edit): анкета тендера — то, что видит отдел, и она не должна расходиться с «Моей компанией». Анкеты закрытых тендеров
--    остаются как были поданы.
-- Ответы подрядчиков не меняются (на 11.11 в базе их нет). Повтор безопасен.

-- ── 1. Поля анкеты: вид и связь с карточкой ──────────────────────────────────────────────────────────
ALTER TABLE public.bid_form_fields ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'tender';
ALTER TABLE public.bid_form_fields ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.bid_form_fields DROP CONSTRAINT IF EXISTS bid_form_fields_scope_check;
ALTER TABLE public.bid_form_fields ADD CONSTRAINT bid_form_fields_scope_check CHECK (scope IN ('tender', 'company'));
ALTER TABLE public.bid_form_fields DROP CONSTRAINT IF EXISTS bid_form_fields_source_check;
ALTER TABLE public.bid_form_fields ADD CONSTRAINT bid_form_fields_source_check
  CHECK (source IS NULL OR (source ~ '^[a-z_]{1,40}$' AND scope = 'company'));
CREATE UNIQUE INDEX IF NOT EXISTS bid_form_fields_source_key ON public.bid_form_fields (source) WHERE source IS NOT NULL;
COMMENT ON COLUMN public.bid_form_fields.scope IS
  'company — ответ один на компанию (подставляется в каждый тендер, виден в «Моей компании»); tender — свой ответ в каждом тендере';
COMMENT ON COLUMN public.bid_form_fields.source IS
  'Сведение карточки компании, из которого берётся ответ (ключ перечня страницы: name, inn, address, vat, website, director, contact…)';

-- Связи полей по умолчанию (анкета 20261102) — по подписи; первое подходящее поле, если сведение ещё никому не отдано.
UPDATE public.bid_form_fields f SET scope = 'company', source = v.source
FROM (VALUES
  ('name', '^\s*наименование\s+(контрагента|организации|компании|участника)'),
  ('inn', '^\s*инн(\s|$|,|\.)'),
  ('address', '^\s*адрес'),
  ('vat', NULL),
  ('website', 'сайт'),
  ('director', '^\s*(генеральн[а-я]*\s+)?директор|^\s*руководител'),
  ('contact', '^\s*контактное\s+лицо')
) AS v(source, pattern)
WHERE f.id = (
    SELECT x.id FROM public.bid_form_fields x
    WHERE x.source IS NULL
      AND (CASE WHEN v.source = 'vat' THEN x.code = 'vat' ELSE lower(x.label) ~ v.pattern END)
    ORDER BY x.sort_order, x.created_at, x.id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM public.bid_form_fields y WHERE y.source = v.source);

-- Поля о компании без связи с карточкой: СРО, дата регистрации, оборот, численность работающих всего не по тендеру.
UPDATE public.bid_form_fields SET scope = 'company'
WHERE source IS NULL AND scope = 'tender'
  AND (lower(label) ~ '^\s*наличие\s+сро' OR lower(label) ~ '^\s*дата\s+регистрации' OR lower(label) ~ '^\s*оборот');

-- ── 2. Ответы о компании ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bid_company_answers (
  counterparty_id uuid PRIMARY KEY REFERENCES public.counterparties(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object' AND char_length(answers::text) <= 200000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
COMMENT ON TABLE public.bid_company_answers IS
  'Анкета подрядчика: ответы организации на поля о компании { id поля: { label, value } } (кабинет, «Моя компания»); пишет только bid_company_save';

-- Записать ответы о компании: только поля о компании (scope = company или связанные с карточкой), у списка — только вариант из списка,
-- пусто — убрать ответ. Те же ответы — в анкеты идущих тендеров, где организация может менять анкету. → ответы организации.
CREATE OR REPLACE FUNCTION public.bid_company_save(p_answers jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_doc jsonb;
  v_set jsonb := '{}'::jsonb;
  v_del text[] := '{}'::text[];
  a record;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Сведения о компании заполняет подрядчик' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_answers)) > 200 THEN
    RAISE EXCEPTION 'Неверная анкета' USING ERRCODE = '22023';
  END IF;
  v_doc := coalesce((SELECT c.answers FROM public.bid_company_answers c WHERE c.counterparty_id = v_cp), '{}'::jsonb);
  FOR a IN
    SELECT f.id::text AS key, f.label, f.kind, f.options, left(btrim(e.value), 2000) AS value
    FROM jsonb_each_text(p_answers) e JOIN public.bid_form_fields f ON f.id::text = e.key
    WHERE f.scope = 'company' OR f.source IS NOT NULL
  LOOP
    IF a.kind = 'select' AND coalesce(a.value, '') <> '' AND NOT coalesce(a.options ? a.value, false) THEN
      RAISE EXCEPTION 'Значение «%» не из списка поля «%»', a.value, a.label USING ERRCODE = '22023';
    END IF;
    IF coalesce(a.value, '') = '' THEN
      v_doc := v_doc - a.key;
      v_del := v_del || a.key;
    ELSE
      v_doc := v_doc || jsonb_build_object(a.key, jsonb_build_object('label', a.label, 'value', a.value));
      v_set := v_set || jsonb_build_object(a.key, jsonb_build_object('label', a.label, 'value', a.value));
    END IF;
  END LOOP;
  INSERT INTO public.bid_company_answers AS b (counterparty_id, answers, updated_by)
  VALUES (v_cp, v_doc, auth.uid())
  ON CONFLICT (counterparty_id) DO UPDATE SET answers = excluded.answers, updated_at = now(), updated_by = excluded.updated_by;
  IF v_set <> '{}'::jsonb OR cardinality(v_del) > 0 THEN
    UPDATE public.tender_bid_forms f
       SET answers = (f.answers - v_del) || v_set, updated_at = now(), updated_by = auth.uid()
     WHERE f.counterparty_id = v_cp AND public.bid_can_edit(f.tender_id)
       AND f.answers IS DISTINCT FROM ((f.answers - v_del) || v_set);
  END IF;
  RETURN v_doc;
END
$$;
COMMENT ON FUNCTION public.bid_company_save(jsonb) IS
  'Кабинет подрядчика: ответы о компании (один раз на организацию) и они же — в анкетах её идущих тендеров.';
-- osp:allow rpc bid_company_save authenticated

-- ── 3. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.bid_company_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bid_company_answers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.bid_company_answers;
CREATE POLICY osp_internal ON public.bid_company_answers FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие: своя организация или администратор (как анкета тендера).
DROP POLICY IF EXISTS bid_company_answers_read ON public.bid_company_answers;
CREATE POLICY bid_company_answers_read ON public.bid_company_answers FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.is_admin()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'bid_company_answers', 'bid_company_answers_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table bid_company_answers authenticated=select
