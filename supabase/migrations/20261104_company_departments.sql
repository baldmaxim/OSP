-- «Общая информация» → «Отделы»: какие отделы есть в компании, за что отвечают, руководители и их телефоны.
--
--  • company_departments — строка = отдел: блок («Тендеры», «Финансы»…), название, основные функции,
--    примечание («Руководитель отсутствует») и contacts — руководители и контакты [{name, position, phone}].
--    Порядок — sort_order; номер отдела на странице — место в этом порядке.
--  • Триггер чистит пробелы и список контактов (только name / position / phone, пустые строки убираются),
--    ставит, кто и когда изменил.
--  • Права: читает сотрудник (osp_is_employee), правит только администратор (is_admin()). Гостю и
--    подрядчику — ничего: в контактах личные телефоны.
--  • Начальный список — 26 отделов из «Функции отделов и их руководители» (23.10.2026): блок, название,
--    функции. ФИО и телефоны в миграцию не входят (репозиторий открыт) — администратор вносит их на
--    странице («Руководители списком» или в карточке отдела). Список заводится, только если таблица пуста.
--
-- Только добавление, повтор безопасен. Пока миграции нет, страница «Отделы» говорит, что раздел появится
-- после обновления базы. Новая таблица, блокировок существующих нет — но применять в нерабочее время.
-- База нового портала — migration/yandex/20261104_company_departments.sql. Проверка:
-- migration/backup/checks/20261104.sql, откат — migration/rollback/20261104_company_departments_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.company_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sort_order integer NOT NULL DEFAULT 0,
  block text NOT NULL DEFAULT '' CHECK (length(block) <= 200),
  name text NOT NULL CHECK (name <> '' AND length(name) <= 300),
  duties text NOT NULL DEFAULT '' CHECK (length(duties) <= 4000),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) <= 20),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_departments_sort_idx ON public.company_departments (sort_order);
COMMENT ON TABLE public.company_departments IS
  'Отделы компании («Общая информация» → «Отделы»): блок, название, основные функции, руководители и контакты';
COMMENT ON COLUMN public.company_departments.contacts IS
  'Руководители и контакты: [{"name": ФИО, "position": должность или за что отвечает, "phone": телефон}]';
COMMENT ON COLUMN public.company_departments.note IS 'Примечание к руководителю, например «Руководитель отсутствует»';

-- Пробелы по краям не храним; контакты — только три поля, строка без ФИО и телефона убирается.
CREATE OR REPLACE FUNCTION public.company_departments_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  c jsonb;
  cleaned jsonb := '[]'::jsonb;
  v_name text;
  v_position text;
  v_phone text;
BEGIN
  NEW.block := btrim(coalesce(NEW.block, ''));
  NEW.name := btrim(coalesce(NEW.name, ''));
  NEW.duties := btrim(coalesce(NEW.duties, ''));
  NEW.note := nullif(btrim(NEW.note), '');
  IF jsonb_typeof(NEW.contacts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'contacts — список' USING ERRCODE = '22023';
  END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(NEW.contacts) LOOP
    IF jsonb_typeof(c) <> 'object' THEN
      RAISE EXCEPTION 'контакт — объект {name, position, phone}' USING ERRCODE = '22023';
    END IF;
    v_name := btrim(coalesce(c->>'name', ''));
    v_position := btrim(coalesce(c->>'position', ''));
    v_phone := btrim(coalesce(c->>'phone', ''));
    IF length(v_name) > 200 OR length(v_position) > 300 OR length(v_phone) > 100 THEN
      RAISE EXCEPTION 'слишком длинное поле контакта' USING ERRCODE = '22001';
    END IF;
    IF v_name <> '' OR v_phone <> '' THEN
      cleaned := cleaned || jsonb_build_array(jsonb_build_object('name', v_name, 'position', v_position, 'phone', v_phone));
    END IF;
  END LOOP;
  NEW.contacts := cleaned;
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS company_departments_touch ON public.company_departments;
CREATE TRIGGER company_departments_touch
  BEFORE INSERT OR UPDATE ON public.company_departments
  FOR EACH ROW EXECUTE FUNCTION public.company_departments_touch();

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.company_departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_departments_read ON public.company_departments;
CREATE POLICY company_departments_read ON public.company_departments FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS company_departments_insert ON public.company_departments;
CREATE POLICY company_departments_insert ON public.company_departments FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS company_departments_update ON public.company_departments;
CREATE POLICY company_departments_update ON public.company_departments FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS company_departments_delete ON public.company_departments;
CREATE POLICY company_departments_delete ON public.company_departments FOR DELETE TO authenticated
  USING ((SELECT public.is_admin()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.company_departments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_departments TO authenticated;
GRANT ALL ON TABLE public.company_departments TO service_role;
REVOKE ALL ON FUNCTION public.company_departments_touch() FROM PUBLIC, anon;

-- ── Начальный список (только если таблица пуста) ────────────────────────────────────────────────────
INSERT INTO public.company_departments (sort_order, block, name, duties, note)
SELECT v.sort_order, v.block, v.name, v.duties, v.note
FROM (VALUES
  (10, 'Обеспечение деятельности компании', 'Юридический отдел',
   'Правовая экспертиза документов, сопровождение договоров, судебная защита, претензионная работа, работа с дебиторской задолженностью.', NULL),
  (20, 'Обеспечение деятельности компании', 'Департамент внутренней безопасности',
   'Обеспечение комплексной безопасности компании, проведение внутренних расследований, контроль пропускного и внутриобъектового режима.', NULL),
  (30, 'Обеспечение деятельности компании', 'Департамент управления персоналом',
   'Оформление приёма и увольнения сотрудников компании, подбор персонала, ведение табелей.', NULL),
  (40, 'Обеспечение деятельности компании', 'Отдел «Секретариат»',
   'Организация документооборота (регистрация писем, приказов), контроль исполнения, курьеры.', NULL),
  (50, 'Обеспечение деятельности компании', 'Административно-хозяйственный отдел',
   'Хозяйственное обслуживание офисных помещений; канцтовары, хозтовары, мебель, бытовая техника для сотрудников ИТР; корпоративная мобильная связь; обеспечение офисов и штабов питьевой водой (кулеры, пурифайеры); работа копировальных центров; заказ полиграфической продукции.',
   'Руководитель отсутствует'),
  (60, 'Тендеры', 'Тендерный отдел (генподряд)',
   'Подготовка КП для участия в генподрядных тендерах на строительство ЖК.', NULL),
  (70, 'Тендеры', 'Отдел по сопровождению подрядчиков',
   'Проведение тендеров и заключение договоров с подрядчиками при строительстве объекта.', NULL),
  (80, 'Материалы', 'Бухгалтерия — материальный отдел',
   'Учёт материалов, реализация материалов подрядчикам, списание материалов.', NULL),
  (90, 'Материалы', 'ООО «Закупка.Про»',
   'Обеспечение закупки и поставки материалов, оформление распределительных писем на поставку материалов.', NULL),
  (100, 'Материалы', 'Диспетчерская служба',
   'Обработка первичного документооборота, внесение данных в систему учёта, оформление перемещения материалов и ОС.', NULL),
  (110, 'ИТ-служба', 'Департамент информационных технологий',
   'Информационно-технический отдел: информационно-техническое обеспечение, заказ компьютерного оборудования, работа интернета и электронной почты, доставка расходных материалов. Служба внутреннего контроля: видеонаблюдение, СКУД, пожарная сигнализация.', NULL),
  (120, 'ИТ-служба', 'Отдел цифровой трансформации',
   'Автоматизация бизнес-процессов компании: разработка и развитие внутренних ИТ-решений и порталов, сопровождение конфигураций 1С.', NULL),
  (130, 'Документация при строительстве объекта', 'Отдел по подготовке проектов производства работ',
   'Разработка и согласование проектов производства работ, технологических карт и технологических регламентов.', NULL),
  (140, 'Документация при строительстве объекта', 'Отдел исполнительной документации',
   'Исполнительная документация.', NULL),
  (150, 'Документация при строительстве объекта', 'Отдел проектирования и согласования',
   'Управление проектированием рабочей документации, архив РД.', NULL),
  (160, 'Работы при строительстве', 'Геодезическая служба',
   'Геодезическое сопровождение объектов строительства.', NULL),
  (170, 'Работы при строительстве', 'Отдел по охране труда и технике безопасности',
   'Обеспечение выполнения требований охраны труда и контроль безопасности работ.', NULL),
  (180, 'Работы при строительстве', 'Отдел управления объективного контроля',
   'Контроль и подтверждение выполненных объёмов работ собственных сил и подрядчиков, фотофиксация, списание материалов, формирование заявок на материалы.', NULL),
  (190, 'Работы при строительстве', 'Управление фасадов',
   'Организация и управление разработкой РД по фасадам, организация и управление производством работ по устройству фасадов.', NULL),
  (200, 'Технико-экономическое сопровождение', 'Сметно-технический отдел',
   'Подсчёт объёмов работ по рабочей документации, определение потребности в материалах с учётом норм расхода, составление локальных смет по видам работ, формирование заявок на материалы для объектов строительства. Пересчёт РД, формирование ведомостей объёмов работ, расчёты дополнительных работ.', NULL),
  (210, 'Технико-экономическое сопровождение', 'Отдел по контрактному сопровождению',
   'Подсчёт дополнительных работ и удорожаний, работа с заказчиком по отработке замечаний по дополнительным работам.', NULL),
  (220, 'Сдача объектов, заселение и гарантийное обслуживание', 'Отдел по работе с заказчиком',
   'Получение ЗОС и разрешительной документации перед началом производства работ, ордер на производство работ, СРО, отходы; заключение и расторжение договоров с Мосводоканалом и Мосводостоком; получение актов допуска к электроэнергии и теплоснабжению. Взаимодействие с государственными структурами по строительным объектам, Комитетом государственного строительного надзора города Москвы, ОАТИ.', NULL),
  (230, 'Сдача объектов, заселение и гарантийное обслуживание', 'Гарантийный отдел',
   'Исполнение гарантийных обязательств в гарантийный период, заселение жилых комплексов.', NULL),
  (240, 'Финансы', 'Бухгалтерия',
   'Субподряд, поступление оплат от заказчиков, оплата подрядчикам, налоги, распределительные письма.', NULL),
  (250, 'Финансы', 'Финансовый отдел',
   'Работа экономистов в 1С, затраты по объектам строительства; начисление заработной платы.', NULL),
  (260, 'Финансы', 'Отдел оплаты труда и заработной платы (ОТИЗ)',
   'Утверждение ФОТ собственных сил (расценки, стоимость СМР, удорожания), сопровождение субподряда по дополнительным работам.', NULL)
) AS v(sort_order, block, name, duties, note)
WHERE NOT EXISTS (SELECT 1 FROM public.company_departments);

COMMIT;
