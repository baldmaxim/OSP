-- АВАРИЙНЫЙ ОТКАТ 20270302_bid_supply_docs (только база Яндекса): кабинет подрядчика без счетов снабжения у взятых цен и с прежним
-- постраничным чтением своих цен для подсказки «ваша цена в тендере № …» (страница без функций так и работает). Данных миграция не
-- меняла — убираются только функции. Строка миграции в osp_meta.schema_migrations остаётся (как у других откатов). Одной
-- транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.bid_supply_doc_file(uuid, uuid);
DROP FUNCTION IF EXISTS public.bid_supply_docs(uuid, uuid);
DROP FUNCTION IF EXISTS public.bid_rate_history(uuid, text[]);
DROP FUNCTION IF EXISTS osp_private.bid_supply_docs_cp(uuid, uuid);
DROP FUNCTION IF EXISTS osp_private.bid_supply_doc_rows(uuid, uuid);

COMMIT;
