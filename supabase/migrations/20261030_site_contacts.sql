-- «Тендеры — Основное строительство» → «Документы раздела» → «Контакт площадки»: кто встречает подрядчика
-- на объекте, если потребуется выезд. Контакт — по объекту и подразделению ВОР; его ФИО, телефон и Telegram
-- подставляются в письмо подрядчикам по объекту и подразделению тендера, и без контакта письмо не формируется.
--
--  • Подразделение «Отделка» (finishing) — шестое: в CHECK тендеров (tenders.vor_division) и заявок на ВОР
--    (vor_requests.vor_division), как остальные коды справочника src/utils/vorDivisions.js.
--  • object_site_contacts — строка = объект + подразделение (одна на пару): ФИО, телефон, Telegram; удаление
--    объекта удаляет и его контакты. Кто и когда изменил — триггером.
--  • Права: читает сотрудник (письмо формирует любой, кто видит реестр), назначает только администратор (is_admin()).
--
-- Только добавление (CHECK — шире прежнего, данные не меняются), повтор безопасен. Пока миграции нет, вкладка
-- показывает, что контакты появятся после обновления базы, а письмо формируется как раньше, без строки о выезде.
-- Смена CHECK держит короткую блокировку tenders и vor_requests (сотни строк) — применять в нерабочее время.
-- База нового портала — migration/yandex/20261030_site_contacts.sql. Проверка: migration/backup/checks/20261030.sql,
-- откат — migration/rollback/20261030_site_contacts_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Подразделение «Отделка» ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS valid_vor_division;
ALTER TABLE public.tenders ADD CONSTRAINT valid_vor_division
  CHECK (vor_division IS NULL OR vor_division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));
COMMENT ON COLUMN public.tenders.vor_division IS
  'Подразделение ВОР: monolith (Монолит) | nvf_spk (НВФ, СПК) | general (Общестроительные работы) | hvac_water (ОВ, ВК) | electrical (ЭОМ, СС) | finishing (Отделка)';

ALTER TABLE public.vor_requests DROP CONSTRAINT IF EXISTS vor_requests_division_check;
ALTER TABLE public.vor_requests ADD CONSTRAINT vor_requests_division_check
  CHECK (vor_division IS NULL OR vor_division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));

-- ── 2. Контакты площадки ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.object_site_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  division text NOT NULL
    CHECK (division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing')),
  full_name text NOT NULL CHECK (full_name <> '' AND length(full_name) <= 200),
  phone text NOT NULL CHECK (phone <> '' AND length(phone) <= 100),
  telegram text CHECK (telegram IS NULL OR length(telegram) <= 200),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT object_site_contacts_object_division_key UNIQUE (object_id, division)
);
COMMENT ON TABLE public.object_site_contacts IS
  'Контакт площадки по объекту и подразделению ВОР («Документы раздела» тендеров): ФИО, телефон, Telegram — в письме подрядчикам';
COMMENT ON COLUMN public.object_site_contacts.division IS 'Подразделение ВОР — те же коды, что tenders.vor_division';
COMMENT ON COLUMN public.object_site_contacts.telegram IS 'Telegram: @имя, ссылка t.me или номер — как ввёл администратор';

-- Пробелы по краям не храним, пустой Telegram — NULL; кто и когда изменил.
CREATE OR REPLACE FUNCTION public.object_site_contacts_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.full_name := btrim(coalesce(NEW.full_name, ''));
  NEW.phone := btrim(coalesce(NEW.phone, ''));
  NEW.telegram := nullif(btrim(NEW.telegram), '');
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS object_site_contacts_touch ON public.object_site_contacts;
CREATE TRIGGER object_site_contacts_touch
  BEFORE INSERT OR UPDATE ON public.object_site_contacts
  FOR EACH ROW EXECUTE FUNCTION public.object_site_contacts_touch();

-- ── 3. Права ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.object_site_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS object_site_contacts_read ON public.object_site_contacts;
CREATE POLICY object_site_contacts_read ON public.object_site_contacts FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS object_site_contacts_insert ON public.object_site_contacts;
CREATE POLICY object_site_contacts_insert ON public.object_site_contacts FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS object_site_contacts_update ON public.object_site_contacts;
CREATE POLICY object_site_contacts_update ON public.object_site_contacts FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS object_site_contacts_delete ON public.object_site_contacts;
CREATE POLICY object_site_contacts_delete ON public.object_site_contacts FOR DELETE TO authenticated
  USING ((SELECT public.is_admin()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.object_site_contacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.object_site_contacts TO authenticated;
GRANT ALL ON TABLE public.object_site_contacts TO service_role;
REVOKE ALL ON FUNCTION public.object_site_contacts_touch() FROM PUBLIC, anon;

COMMIT;
