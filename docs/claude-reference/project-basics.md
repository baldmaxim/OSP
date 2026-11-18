# Project Basics — проектный справочник

> **Справочник, а не инструкция постоянной загрузки.** Ниже сохранено исходное описание проекта, включая историю решений и возможные устаревшие варианты. При противоречии ориентироваться на текущий код, миграции, тесты, новую задачу и корневой `CLAUDE.md`.

## Коммит, пуш, выкатка — только с согласия всех сессий проекта

Перед каждым `git commit`, `git push` и выкаткой на сервер:

1. Сессии проекта — только из вывода `~/.claude/bin/project-peers` (запуск из папки проекта): он сверяет рабочие папки сессий, worktree — тот же проект. Писать только им (одноимённым — каждой, с `[ref]` из `ListAgents`); остальным сессиям, в т.ч. `claude-*`, не писать. Вывод пуст — опрос не нужен.
2. `SendMessage` каждой: какая операция, ветка, что входит (файлы или версия).
3. Дождаться ответа всех. Операция — только когда согласились все.
4. Отказ или молчание — не выполнять; сообщить пользователю, кто отказал или молчит и почему. Обойти — только по прямому слову пользователя.
5. Согласие действует на названную операцию. Состав изменился — спросить заново.

Получив такой запрос, ответить отправителю через `SendMessage` сразу, не дожидаясь конца своей задачи и своего опроса: «да» или «нет: причина» (своя незавершённая работа, которую операция заденет; идущая миграция или выкатка). Проект не свой — «да, не мой проект».

Опрос ведёт главная сессия до вызова исполнителя: субагенты его не проводят. Других сессий проекта нет — опрос не нужен.

## Project Overview

React application for managing contractor operations (ОСП - отдел сопровождения подрядчиков). Russian-language interface for tracking construction objects, contractors, tenders, contracts, and material rates.

**Tech Stack:** React 18.3 + Vite + Supabase + react-router-dom v7 + xlsx (SheetJS)

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start dev server (http://localhost:5173)
npm run build        # Production build to dist/
npm run preview      # Preview production build
npm run lint         # Run ESLint (--max-warnings 0)
npm run check:transport # доступ к серверу только через src/api/ (0 нарушений)
npm run test:psdc    # ПСДЦ: движок в БД, XLSX, UI (PostgreSQL + Chromium)
npm run test:tender  # карточка тендера: производительность UI, страница расценки снабжением, карточка контрагента, отчёты, проверка КП, кабинет подрядчика, заявки на проверку ДП/ДС (Chromium; база кабинета — Docker)
npm run test:supply  # расценка снабжением: база на слепке прода (Docker), лист «Материалы», normName = SQL
npm run test:contracts # договоры: путь к Larix.CPM, импорт из Excel, суммы «Заявки на ДС» со знаком (без базы и браузера)
npm run test:release # страховочный релиз: обновление, ошибки чанков, конфиг, распознавание скана в боевой сборке (Chromium)
npm run test:deploy  # deploy/publish.sh и rollback.sh на временных каталогах; портал в Docker (deploy/docker): связка из трёх контейнеров на копии прода, выкладка с возвратом (Docker)
npm run test:backup  # migration/backup: копия, проверка восстановлением, прогон миграций; migration/target: разведка базы (Docker)
npm run test:db      # слепок схемы прода + «отпечаток» прав на копии прода против tests/db/baseline; права под одну учётку и цепочка шлюза с настоящим PostgREST (Docker)
npm run test:api     # свой API server/osp-api (нужен npm ci --prefix server/osp-api; MinIO — если есть образ)
npm run hooks:install # один раз на машине: проверки перед git push (lint, check:transport, test:api)
```

**Новый портал (tender.su10.ru, сервер corp)** выкладывается на самом сервере, из клона `/opt/portals/osp/src`:
`bash scripts/deploy-server.sh migrate | backend | frontend | both | status | rollback | --check`
(сначала `migrate`, потом `both`). Сборка там — в своём сборщике с потолком памяти, соседние порталы не задеваются;
подробности — `deploy/docker/README.md`.

**Тесты** — встроенный `node --test`. Нужны PostgreSQL 17+ и Chromium:
- PostgreSQL: серверные бинарники (`initdb`/`pg_ctl` в PATH или `PG_BIN`), а если их нет — Docker
  (одноразовый контейнер `postgres:17-alpine`, `PG_TEST_MODE=docker|native` для явного выбора);
- Chromium: сборка Playwright, Chrome/Edge или путь в `PSDC_BROWSER` (на удалённой машине —
  `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`).

`test:db` берёт последнюю проверенную копию прода (`migration/dumps/*.dump` с `.verified`, вне git) и
сравнивает права классов пользователей с эталоном `tests/db/baseline/rights.json`; закрытие дыр (Р2)
оформляется строками `approved-fixes.json`, новый эталон после новой копии — `UPDATE_BASELINE=1`.

Без них соответствующие наборы пропускаются (skip), а не падают. Стенды UI подменяют клиент Supabase
(модуль `src/api/supabaseClient.js`) и `RoleContext` подделками (`tests/*/ui/fake-*.js*`); константы ролей
подделки берут из `src/contexts/roleConstants.js`.

## Environment Setup

Create `.env.local` with:
```
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_anon_key
```

## Key Patterns

### Page Components

Each page handles its own CRUD operations through the `src/api` adapters (`db`). Pattern:
1. `useState` for data, loading, editing state
2. `useEffect` to fetch on mount
3. Form handling with local state
4. `db.from(...)` / `db.rpc(...)` calls for mutations

**CSS Organization:** Pages with complex UI have dedicated CSS files (e.g., `BSMRatesPage.css`, `CounterpartiesPage.css`). Common styles in `GeneralInfo.css` are imported where needed. CSS files are in `src/components/` (shared) or `src/pages/` (page-specific).

### Set-Based Selection Pattern

Tables use `Set` for tracking expanded rows, multi-select, and toggle states. Used for `expandedRows` (CounterpartiesPage), `selectedEstimateItems` (TenderDetailPage), `selectedRates` (BSMRatesPage), `selectedParticipants` (TenderDetailPage). Toggle via copy-and-mutate: `new Set(prev)` then `.add(id)` / `.delete(id)`.

### Fullscreen Mode Pattern

Tables support fullscreen toggle with Escape key listener. See TenderDetailPage for implementation (`isComparisonFullscreen`, `isEstimateFullscreen`).

### Sidebar Navigation

Collapsible sections with expand state initialized from current route path.

**Свёрнутое меню** (29.10.2026, решение пользователя): на компьютере кнопка-шеврон без подписи в правом верхнем углу
шапки сворачивает меню до колонки иконок (52px вместо 200px — рабочая область шире). Иконки стоят на тех же местах,
название пункта — в подсказке, счётчик — кружком на иконке, «Выйти» — значком. Выбор — `localStorage` `sidebar:collapsed`.
На телефоне (≤ 768px) меню — выезжающая панель, кнопки нет и не сворачивается. Стили — «Свёрнутое меню» в
[Sidebar.css](src/components/Sidebar.css). **Ширина страницы меняется один раз, край меню едет сдвигом слоёв** (06.11.2026:
«долго закрывается» в «Заявках на ДС» — прежняя анимация ширины меню в раскладке на каждом кадре расширяла рабочую
область, и страница перерисовывалась целиком: 400 заявок — до 0,4 с на кадр, свернуть — 0,5–0,9 с): меню `fixed`, место в
раскладке держит `.sidebar-spacer` (ширина меняется сразу), меню тоже сразу нужной ширины; движется только `transform` —
при сворачивании из-под узкого меню уезжает «тень» `.sidebar-ghost`, при разворачивании меню выезжает (рамка влево,
содержимое на столько же вправо, `overflow: hidden`). Подписи, логотип и шеврон меняются сразу: любое изменение внутри
меню по ходу анимации — снова перерисовка всей страницы на каждом кадре; поэтому и в меню нет `transition: all`
(у переключателя темы он сам запускал переход). Меню — `z-index: 900` (окна страниц — от 900 и позже в документе,
меню выбора и подсказки — от 1300). Анимации — только после нажатия (`.is-anim`), при загрузке ничего не едет.
Меню общее для всех разделов сотрудника (`EmployeeLayout`). **Освободившееся место делят все столбцы** (30.10.2026:
«расширялась не только область слева, а пропорционально все области»): в реестрах «Тендеры» (ОС, «Прочее», на
материалы), «Планы затрат», «ВОРы и РД», «Заявка на ДС» у описания теперь своя ширина (то, что ему оставалось в самом
узком окне), и при `table-layout: fixed` браузер растягивает все столбцы пропорционально; `min-width` таблиц и окно,
с которого появляется прокрутка, — прежние. «Договоры», «Контрагенты», «Проверка КП», «Общие документы» и так в
процентах. Правило — «Ширина» в docs/UI_GUIDELINES.md.
Тест — `tests/tender/sidebar-collapse.test.mjs` (стенд `shell=1&sidebar=1`).

### Props-Based Filtering

`TendersPage` uses `department` prop ('construction' | 'warranty') for filtering by object status. The component maps this to `objectStatus`:
- `'construction'` → `'main_construction'`
- `'warranty'` → `'warranty_service'`

`ContractsPage` uses internal state selectors for department and status (pending/signed).

### Tab-Based Filtering

Pages with tab navigation filter fetched data in memory rather than re-fetching from Supabase. See TendersPage (`active`/`completed` tabs) for the pattern.

### Protected Routes

`EmployeeLayout` component in `App.jsx` wraps all employee routes. It checks `isLoggedIn` and `isEmployee` from RoleContext, redirecting unauthorized users to `/login` or `/contractor/proposals`.

### Multi-File Excel Accumulation (KpAnalysisDialog)

«Анализ ВОР/КП» ([KpAnalysisDialog](src/components/KpAnalysisDialog.jsx), до 09.11.2026 — BSMPage) supports loading multiple Excel files that accumulate into a single analysis. Each parsed row tracks its `sourceFile` for per-file removal. Removing a file filters rows and recalculates the pivot.

### BSM Item Type Detection

Materials vs works are distinguished by КОД column:
- `Р` or starts with `Р-` → work (uses `priceWorks`)
- `мат.` or default → material (uses `priceMaterials`)

### BSM Expected Excel Format

«Анализ ВОР/КП» по умолчанию читает колонки так (у каждого файла — своя раскладка в «Столбцах», последняя
запоминается в `localStorage` `analysis-kp-column-map`):
| Column | Content |
|--------|---------|
| A | № п/п |
| B | КОД — `Р` / `Р-…` / `раб…` (work) or `мат.` (material) |
| C | Наименование |
| D | Ед. изм. |
| E | Объём работ |
| F | Объём материалов |
| G | Цена материалов (с НДС) |
| H | Цена работ (с НДС) |
| L | Примечания |

### ObjectDetailPage Tabs

Five tabs: Информация (object fields like dates, area, budget), Документы (hierarchical documents), Гарантия (warranty periods), Гарантийные удержания (retention percentages), Смета («Смета КП / ПЗ», см. раздел с тем же названием; ниже — estimate with materials/works pricing and VAT support; блока ДГП с 13.11.2026 нет).

**Гарантия (task 353):** каждая строка — отдельный вид работ. Начало гарантии бывает двух типов:
- **По дате** (`start_type='date'`) — обычный datepicker.
- **По событию** (`start_type='event'`) — текстовое описание (`start_event_text`, например «с даты подписания Акта о практическом завершении Работ (Акт № 3)»), опциональная привязка к документу из `object_documents` (`start_document_id`, FK с `ON DELETE SET NULL`) и опциональная фактическая дата начала (заполняется когда событие наступит).

Срок хранится в месяцах (`warranty_months`). Дата окончания вычисляется по приоритетам: (1) `end_date_override` если задан, (2) `start_date + warranty_months`, (3) для события без даты — плейсхолдер «после события + N мес.», (4) прочерк. Поле `notes` — отдельная колонка «Примечание» в таблице. Хелперы расчёта — `getWarrantyEndDisplay()` / `getWarrantyStartDisplay()` в [ObjectDetailPage.jsx](src/pages/ObjectDetailPage.jsx).

### Hierarchical Documents (ObjectDetailPage)

`object_documents` supports parent-child relationships via `parent_document_id` self-reference. Documents are grouped by type (general contracts → additional agreements/attachments as children). The UI uses expandable rows to show nested documents.

**S3-файлы (task 282):** к каждому документу можно прикрепить два файла — подписанный и редактируемый (`signed_s3_document_id` / `editable_s3_document_id`, FK на `s3_documents` с `ON DELETE SET NULL`). Записи в `s3_documents` создаются с `owner_type='object'`, `owner_id=object_id` — файлы лежат в одной папке `objects/{object_id}/` независимо от того, к какому документу/приложению относятся. UI-слот — [src/components/ObjectDocumentFileSlot.jsx](src/components/ObjectDocumentFileSlot.jsx). При удалении документа (включая каскадно удаляемые приложения) код в [ObjectDetailPage.jsx](src/pages/ObjectDetailPage.jsx) рекурсивно собирает все привязанные `s3_documents` и удаляет их через `deleteDocument()` до DELETE — иначе остаются orphan-файлы в S3. Старые поля `signed_link` / `editable_link` (Google Drive) deprecated, в UI не используются.

**Файл .md документа** (03.11.2026, решение пользователя; миграция 20261202, обе базы): маленький столбец «.md» сразу справа от «Подписанный», у каждого документа (договор, ДС, приложения любого уровня). Крестик и «.md» — файла нет, зелёная галочка — есть; один файл на документ (`md_s3_document_id` → `s3_documents`, ON DELETE SET NULL; файл — `owner_type='object'`, `doc_category='object_doc_md'`). С правом правки «Объектов» крестик загружает файл (только `.md`, не пустой), галочка открывает меню «Скачать / Заменить / Удалить»; без права крестик — только отметка, галочка скачивает. Загрузка и привязка — сразу из ячейки, без формы документа и без перечитывания карточки; при замене прежний файл удаляется только после привязки нового, не привязалось (правка не задела строку) — загруженный убирается и видна ошибка. Удаление документа убирает и его `.md`. Колонки ещё нет (PGRST200 / 42703) — столбца нет, карточка как раньше (`fetchObjectDocuments` → `mdEnabled`). Просмотра в окне нет — только скачивание. Крестик красный (03.11). **«Скачать все»** (05.11, решение пользователя; миграции нет): кнопка в заголовке столбца, над подписью «.md», шириной с колонку, текст 11 px — одна на объект, над верхней из показанных таблиц (договор, а нет его или он скрыт поиском — ДС). Все файлы `.md` объекта одним ZIP «<объект> — файлы md.zip» без папок, поиск состав не сужает, имена исходные, совпадения — «(2)»; файлов нет — неактивна; права — как у скачивания одного файла; не скачавшиеся — в «Не скачано.txt» (сборка общая, `buildTenderArchive`). Кнопка — [ObjectDocMdZipButton](src/components/ObjectDocMdZipButton.jsx), состав и имя — [objectMdArchive.js](src/utils/objectMdArchive.js). Ячейка — [ObjectDocMdCell](src/components/ObjectDocMdCell.jsx), запросы — [services/objectDocMd.js](src/services/objectDocMd.js). База Яндекса — `migration/yandex/20261202_object_documents_md.sql`; проверка — `migration/backup/checks/20261202.sql`, откат — `migration/rollback/20261202_object_documents_md_rollback.sql`. Тесты — `tests/tender/object-doc-md.test.mjs` (стенд: `__navigate('/general/objects/<id>?tab=documents')`, `__fakeMissingEmbeds` — связи нет), `object-doc-md-db.test.mjs` (слепок с настоящим PostgREST и копия под одной учёткой).

**Документы на телефоне** (≤ 640 px, 12.11.2026, просьба пользователя: «на телефоне некорректно отображается информация»): вместо таблиц — карточки [ObjectDocCards](src/components/ObjectDocCards.jsx) (`useIsPhone`): название целиком, номер и дата, примечание, три файла с подписями («.md» — та же `ObjectDocMdCell`), «Редактировать» / «Удалить» в углу, приложения — вложенными карточками (общий `expandedDocs`), «Скачать все» — строкой над карточками. Перетаскивания на телефоне нет. Таблица шире места не сжимается: `min-width: 51rem` у `.doc-table` и прокрутка в своей рамке — у «№ / дата» и «Описание ДС» нет своей ширины, при 676 px им оставалось ≈ 50 px, и номер с датой шли по букве в строку. Тесты — «телефон» и «планшет» в `object-doc-md.test.mjs`.

### RLS Pattern (Supabase)

All tables use Row Level Security with permissive policy for authenticated users:
```sql
ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users" ON table_name
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
```

**Гость (anon) — только представление `public_open_tenders` (миграция 20261016).** Страница без входа
`/public/tenders` ([PublicTendersPage](src/pages/PublicTendersPage.jsx), помощники — [publicTenders.js](src/utils/publicTenders.js))
читает его: 11 публичных полей открытых основных тендеров (номер, работы, сроки, ссылка на тендерный пакет,
название / адрес / карта объекта) и с 20261101 — ответственный по тендеру, только ФИО и телефон (колонка
«Контакты»: ФИО, под ним одним блоком телефон и общий ящик `tender.osp@su10.ru`, письмо — с темой
«Объект … / Тендер № …»). Ссылками становятся только адреса http(s); нет колонок ответственного (сайт раньше
миграции) — список без них. База Яндекса — `migration/yandex/20261101_public_tenders_contact.sql` (там тело
представления — функция `osp_private.view_public_open_tenders()`, см. `load-single-owner.sql`, п. 9). Тест —
`tests/tender/public-tenders.test.mjs`. Политик `TO anon` на таблицах нет и быть не должно:
политика ограничивает строки, а не колонки — прежние политики на `tenders` и `objects` отдавали гостю
строки целиком (ссылки на план затрат, сводную КП, ВОР, примечания). Публичный ключ Supabase лежит в
скрипте сайта, поэтому всё, что разрешено anon, читается из интернета одним запросом. Новое поле в
представлении = публикация; проверка — `migration/backup/checks/20261016.sql`.

### Common PostgreSQL Error Handling

Handle unique constraint violations (common in BSM rates and counterparties):
```javascript
if (error.code === '23505') {
  alert('Запись с таким названием уже существует')  // Unique violation
}
```

### Multiple Estimates per Tender

TenderDetailPage supports multiple named estimates per tender. Items are grouped by the `estimate_name` field (default: `'Основная смета'`). See TenderDetailPage for grouping logic.

### Tender Documents (Google Drive Links)

Documents are stored as URL references (typically Google Drive links), not uploaded files. Types: `'attachment'` (general) and `'estimate_template'`.

### Excel Import with Conflict Resolution (BSMRatesPage pattern)

BSM rate pages use a two-step import: (1) parse Excel and detect conflicts with existing data (`importReport` with `newItems` and `conflicts`), (2) user decides per-conflict (`'replace'` or `'skip'`), then apply. See BSMRatesPage for implementation.
