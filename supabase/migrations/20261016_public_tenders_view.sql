-- Публичный список тендеров: гостю — только поля публичной страницы, а не строки таблиц целиком.
--
-- ПРОБЛЕМА. Страница /public/tenders открыта без входа. Для неё миграция 20260520 дала роли anon
-- политики чтения на tenders («Anon public tender list») и objects («Anon public objects via open
-- tenders»). Политика ограничивает СТРОКИ, но не колонки: с публичным ключом сайта (он лежит в скрипте
-- страницы — так у Supabase задумано) гость одним запросом к API читал открытые тендеры со ВСЕМИ
-- полями — ссылки на план затрат, сводную таблицу КП и ВОР, примечания, путь к папке, ответственных —
-- и объекты с открытыми тендерами со всеми полями (почта, застройщик, проектировщик, бюджет).
-- Проверено на проде 13.10.2026 запросом без входа: 41 тендер и 14 объектов; остальные 85 таблиц
-- и представлений гостю строк не отдают.
--
-- РЕШЕНИЕ. Представление public_open_tenders с теми же условиями отбора, что были в политиках и на
-- странице, и только с полями, которые страница показывает: номер, описание работ, сроки, ссылка на
-- тендерный пакет, название / адрес / ссылка на карту объекта. Политики anon с таблиц снимаются:
-- гость больше не читает ни tenders, ни objects. Представление работает с правами владельца (иначе
-- гость не увидел бы строк) и только на чтение; security_barrier не даёт условию запроса заглянуть в
-- строки, не прошедшие отбор.
--
-- Сотрудники и подрядчики читают таблицы по своим политикам (TO authenticated) — их миграция не
-- касается. Данные не меняются. Повтор безопасен.
-- Интерфейс: PublicTendersPage читает представление; пока его нет в базе — прежним запросом к tenders,
-- поэтому сайт можно выложить и до, и после миграции. Прежний сайт после миграции покажет гостю пустой
-- список (не ошибку), пока вкладка не обновится.
-- Откат — migration/rollback/20261016_public_tenders_rollback.sql (возвращает политики, то есть и дыру).
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
    o.map_link AS object_map_link
   FROM public.tenders t
     JOIN public.objects o ON o.id = t.object_id
  WHERE t.status::text = 'Идет тендерная процедура'
    AND t.deleted_at IS NULL
    AND (t.tender_type IS NULL OR t.tender_type = 'main')
    AND o.status IN ('main_construction', 'warranty_service');

COMMENT ON VIEW public.public_open_tenders IS
  'Открытые тендеры для страницы без входа (/public/tenders): только публичные поля. Единственное, что читает гость (anon); из таблиц tenders и objects он не читает ничего. Новую колонку добавлять сюда — значит публиковать её в интернете';

-- В Supabase новое представление по умолчанию получает ALL для anon и authenticated.
REVOKE ALL ON TABLE public.public_open_tenders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_open_tenders TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Anon public tender list" ON public.tenders;
DROP POLICY IF EXISTS "Anon public objects via open tenders" ON public.objects;

COMMIT;

-- Слой API перечитывает схему: без этого он какое-то время «не видит» новое представление.
NOTIFY pgrst, 'reload schema';
