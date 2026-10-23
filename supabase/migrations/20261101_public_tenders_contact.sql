-- Публичный список тендеров (/public/tenders): ответственный по тендеру — ФИО и телефон.
--
-- Подрядчик со страницы без входа видит, кому звонить по тендеру: в строке тендера — ФИО ответственного
-- (tenders.responsible_contact_id → contacts), под ним одним блоком его телефон и общий ящик отдела
-- tender.osp@su10.ru (ящик — константа страницы, в базе его нет). Тот же телефон уже уходит подрядчикам
-- в письме-приглашении.
--
-- Представление public_open_tenders (20261016) получает две колонки в конце: responsible_name и
-- responsible_phone. Только они — ни почты, ни должности, ни примечаний, ни объекта контакта: новая
-- колонка здесь = публикация в интернете. Отбор строк, права владельца, security_barrier и выдача
-- (гостю и вошедшему — только чтение) прежние. Нет ответственного — обе колонки NULL, тендер в списке
-- остаётся (LEFT JOIN). Таблицы и данные не меняются. Повтор безопасен.
-- Интерфейс: PublicTendersPage читает новые колонки; пока их нет — список без них (в контактах только
-- общая почта), поэтому порядок «сайт / миграция» любой.
-- База нового портала — migration/yandex/20261101_public_tenders_contact.sql. Проверка —
-- migration/backup/checks/20261101.sql, откат — migration/rollback/20261101_public_tenders_contact_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE VIEW public.public_open_tenders
WITH (security_barrier = true, security_invoker = false) AS
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
    AND o.status IN ('main_construction', 'warranty_service');

COMMENT ON VIEW public.public_open_tenders IS
  'Открытые тендеры для страницы без входа (/public/tenders): только публичные поля, ответственный — ФИО и телефон. Единственное, что читает гость (anon); из таблиц tenders, objects и contacts он не читает ничего. Новую колонку добавлять сюда — значит публиковать её в интернете';

REVOKE ALL ON TABLE public.public_open_tenders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_open_tenders TO anon, authenticated, service_role;

COMMIT;

-- Слой API перечитывает схему: без этого он какое-то время «не видит» новые колонки.
NOTIFY pgrst, 'reload schema';
