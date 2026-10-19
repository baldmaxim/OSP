-- Позиции ВОР для расценки снабжением — заранее, на сервере: состояние разбора по тендеру (служба osp-api,
-- server/osp-api/src/lib/supplyImport.js). Раньше позиции разбирал только браузер при открытии расценки, и в
-- реестре «Тендеры на материалы» у неоткрытых тендеров вместо «Расценка: N из M» стояло «открыть».
--
--  • tender_supply_import_state — строка на основной тендер: status ok (позиции есть) | no_vor (ни файл ВОР, ни
--    вкладка «ВОР» материалов не дали) | issues (файлы не разобрались — причины в issues) | locked (тендер на
--    материалы завершён, позиций нет) | pending (не успели за проход); подписи файлов и вкладки «ВОР» и версия
--    разбора — по ним служба не разбирает заново то, что не менялось; issues — [{ doc_id, file_name, version,
--    parser, kind, message, sheetNames, sheetName, codeTried }]. Страница по ним не скачивает файл, который
--    служба уже не смогла разобрать.
--  • Читает сотрудник (реестр и страница расценки), пишет только служба (служебный ключ / osp:internal):
--    у вошедших прав записи нет.
--
-- Только добавление, повтор безопасен. Данные выводятся заново службой — откат просто удаляет таблицу. База
-- нового портала — migration/yandex/20261024_supply_import_state.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tender_supply_import_state (
  tender_id uuid PRIMARY KEY REFERENCES public.tenders(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ok', 'no_vor', 'issues', 'locked', 'pending')),
  files_sig text,
  tab_sig text,
  parser_version integer NOT NULL DEFAULT 0,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array'),
  positions_count integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.tender_supply_import_state IS
  'Разбор позиций ВОР для расценки снабжением службой osp-api: итог по основному тендеру (статус для реестра тендеров на материалы и причины отказов)';

ALTER TABLE public.tender_supply_import_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_import_state_read ON public.tender_supply_import_state;
CREATE POLICY supply_import_state_read ON public.tender_supply_import_state FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));

REVOKE ALL ON TABLE public.tender_supply_import_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tender_supply_import_state TO authenticated;
GRANT ALL ON TABLE public.tender_supply_import_state TO service_role;

COMMIT;
