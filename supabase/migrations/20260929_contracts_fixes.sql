-- «Договоры и ДС»: исправления.
--
-- 1) ПСДЦ можно вносить и в завершённый договор / ДС.
--    Раньше psdc_document_lock_reason (миграция 20260908) запрещала загрузку,
--    применение и удаление ПСДЦ у документа в статусе «Завершено» — требовалось
--    сначала вернуть его на доработку. Запрет снят; остаются проверки на
--    удалённый документ и права.
--
-- 2) «Could not find the 'larix_entered' column of 'contracts'».
--    Колонки Larix добавляла миграция 20260805_add_larix_tracking_to_contracts,
--    в базе её нет. Здесь те же колонки идемпотентно, плюс колонки, которые
--    теперь пишет импорт из Excel (путь к папке, путь к Signal, сумма ДГП,
--    «ведёт наш отдел») — чтобы импорт не падал на базе без тех миграций.
--
-- 3) Сброс кэша схемы PostgREST: без него API ещё какое-то время «не видит»
--    только что добавленные колонки.
--
-- Миграция идемпотентна.

-- ── 2) Колонки ────────────────────────────────────────────────────────────
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS larix_entered BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS larix_number TEXT,
  ADD COLUMN IF NOT EXISTS larix_entered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS larix_entered_by TEXT,
  ADD COLUMN IF NOT EXISTS folder_path TEXT,
  ADD COLUMN IF NOT EXISTS signal_link TEXT,
  ADD COLUMN IF NOT EXISTS gp_amount NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS handled_by_us BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.contracts.larix_entered IS 'Договор внесён в систему Larix';
COMMENT ON COLUMN public.contracts.larix_number IS 'Номер договора в системе Larix';
COMMENT ON COLUMN public.contracts.larix_entered_at IS 'Когда отмечено внесение в Larix';
COMMENT ON COLUMN public.contracts.larix_entered_by IS 'Кто отметил внесение в Larix (ФИО/e-mail)';
COMMENT ON COLUMN public.contracts.folder_path IS
  'Путь к папке с документами договора в файловом хранилище (UNC или локальный). Показывается для копирования: браузер не может открыть проводник по клику';
COMMENT ON COLUMN public.contracts.signal_link IS
  'Путь к Signal: ссылка (или путь) на документы договора в общем хранилище. http(s) открывается кликом, прочее — копируется';

-- ── 1) ПСДЦ у завершённых документов ──────────────────────────────────────
-- Функция зависит от объектов миграции 20260908 (psdc_can_edit_document). Если
-- ПСДЦ в базе ещё нет, пропускаем — 20260908 создаст функцию сама, а эта
-- миграция при повторном применении заменит её на версию без запрета.
DO $mig$
BEGIN
  IF to_regprocedure('public.psdc_can_edit_document(uuid)') IS NULL THEN
    RAISE NOTICE 'ПСДЦ (20260908) не применена — psdc_document_lock_reason не меняем';
    RETURN;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.psdc_document_lock_reason(p_doc public.contracts)
    RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
    AS $body$
    BEGIN
      IF p_doc.id IS NULL THEN
        RETURN 'Документ не найден';
      END IF;
      IF p_doc.deleted_at IS NOT NULL THEN
        RETURN format('Документ ID %s удалён', p_doc.display_id);
      END IF;
      IF NOT psdc_can_edit_document(p_doc.id) THEN
        RETURN 'Недостаточно прав для изменения документа';
      END IF;
      -- Статус документа ПСДЦ больше не блокирует: завершённый договор или ДС
      -- принимают новую ведомость без возврата на доработку.
      RETURN NULL;
    END;
    $body$
  $fn$;
END
$mig$;

-- ── 3) Кэш схемы API ──────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
