-- АВАРИЙНЫЙ ОТКАТ 20270223_supply_removed_docs (обе базы: Supabase и Яндекса): расценка снабжения снова не помнит, какие цены
-- поставлены из удалённых файлов. Страница без таблицы работает как до миграции: цены файла можно снять только в момент его
-- удаления, строки «удалён … его цены стоят у N позиций» в окне «Счета и КП» нет. Цены, документы позиций и сами файлы не
-- затрагиваются. ТЕРЯЮТСЯ только следы уже удалённых файлов — цены, поставленные из них, остаются обычными ценами; перед
-- откатом их можно снять списком:
--   select t.public_tender_number, d.doc_name, r.estimate_name, r.material_name, d.price, d.removed_at
--   from public.tender_supply_removed_docs d join public.tender_vor_supply_rates r on r.id = d.rate_id
--   join public.tenders t on t.id = d.tender_id order by d.removed_at;
-- Вместе с откатом в шлюзе можно оставить строку allow.json / db-sections.json: запрос к таблице, которой нет, страница
-- понимает как «обновление базы не применено». Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS public.tender_supply_removed_docs;
DROP FUNCTION IF EXISTS public.tender_supply_removed_docs_touch();
-- База Яндекса: записи о ролях политик (в Supabase такой таблицы нет).
DO $$
BEGIN
  IF to_regclass('osp_meta.policy_roles') IS NOT NULL THEN
    DELETE FROM osp_meta.policy_roles WHERE schema_name = 'public' AND table_name = 'tender_supply_removed_docs';
  END IF;
END
$$;

COMMIT;
