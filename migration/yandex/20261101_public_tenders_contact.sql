-- Публичный список тендеров (/public/tenders): ответственный по тендеру — ФИО и телефон. Тело
-- supabase/migrations/20261101_public_tenders_contact.sql под одну учётку.
--
-- Здесь представление public_open_tenders устроено так, как его перенесла загрузка (load-single-owner.sql,
-- п. 9): тело — функция закрытой схемы osp_private.view_public_open_tenders() с пропуском (под одной учёткой
-- правила таблиц действуют и на владельца), само представление читает из неё и проверяет роль из токена —
-- гость и вошедший, как выдано на проде. У функции меняется набор колонок, поэтому представление и функция
-- пересоздаются; прежние 11 колонок — тех же типов и в том же порядке, в конце — responsible_name и
-- responsible_phone (contacts.full_name и phone ответственного; нет ответственного — NULL, тендер остаётся).
-- Ни почты, ни должности контакта: новая колонка здесь = публикация в интернете.
-- Список шлюза не меняется: представление уже открыто гостю и вошедшему только на чтение, колонки шлюз не
-- проверяет. Таблицы и данные не меняются. Повтор безопасен.
DROP VIEW IF EXISTS public.public_open_tenders;
DROP FUNCTION IF EXISTS osp_private.view_public_open_tenders();

CREATE FUNCTION osp_private.view_public_open_tenders()
  RETURNS TABLE (id uuid, public_tender_number integer, work_description text, start_date date, end_date date,
                 tender_start_date date, tender_end_date date, tender_package_link text, object_name character varying,
                 object_address text, object_map_link text, responsible_name text, responsible_phone text)
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
 SELECT t.id,
    t.public_tender_number,
    t.work_description,
    t.start_date,
    t.end_date,
    t.tender_start_date,
    t.tender_end_date,
    t.tender_package_link,
    o.name AS object_name,
    o.address AS object_address,
    o.map_link AS object_map_link,
    NULLIF(btrim(c.full_name::text), '') AS responsible_name,
    NULLIF(btrim(c.phone::text), '') AS responsible_phone
   FROM public.tenders t
     JOIN public.objects o ON o.id = t.object_id
     LEFT JOIN public.contacts c ON c.id = t.responsible_contact_id
  WHERE t.status::text = 'Идет тендерная процедура'
    AND t.deleted_at IS NULL
    AND (t.tender_type IS NULL OR t.tender_type = 'main')
    AND o.status IN ('main_construction', 'warranty_service')
$$;

CREATE VIEW public.public_open_tenders WITH (security_barrier = true, security_invoker = false) AS
 SELECT (f.id)::uuid AS id,
    (f.public_tender_number)::integer AS public_tender_number,
    (f.work_description)::text AS work_description,
    (f.start_date)::date AS start_date,
    (f.end_date)::date AS end_date,
    (f.tender_start_date)::date AS tender_start_date,
    (f.tender_end_date)::date AS tender_end_date,
    (f.tender_package_link)::text AS tender_package_link,
    (f.object_name)::character varying(255) AS object_name,
    (f.object_address)::text AS object_address,
    (f.object_map_link)::text AS object_map_link,
    (f.responsible_name)::text AS responsible_name,
    (f.responsible_phone)::text AS responsible_phone
   FROM osp_private.view_public_open_tenders() f
  WHERE (SELECT osp_private.bypass()) OR (SELECT osp_private.role_in('anon', 'authenticated'));

COMMENT ON VIEW public.public_open_tenders IS
  'Открытые тендеры для страницы без входа (/public/tenders): только публичные поля, ответственный — ФИО и телефон. Единственное, что читает гость (anon); из таблиц tenders, objects и contacts он не читает ничего. Новую колонку добавлять сюда — значит публиковать её в интернете';
