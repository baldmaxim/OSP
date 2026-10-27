# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run test:tender  # карточка тендера: производительность UI, страница расценки снабжением, карточка контрагента, отчёты, проверка КП, кабинет подрядчика (Chromium; база кабинета — Docker)
npm run test:supply  # расценка снабжением: база на слепке прода (Docker), лист «Материалы», normName = SQL
npm run test:contracts # договоры: путь к Larix.CPM, импорт из Excel, суммы «Заявки на ДС» со знаком (без базы и браузера)
npm run test:release # страховочный релиз: обновление, ошибки чанков, конфиг (Chromium)
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

## Architecture

### Application Structure

```
src/
├── App.jsx               # Routes, nested EmployeeLayout, providers
├── contexts/
│   ├── ThemeContext.jsx  # Light/dark theme (localStorage 'theme')
│   └── RoleContext.jsx   # User roles (localStorage 'userRole')
├── components/
│   ├── Sidebar.jsx       # Navigation with 3-level collapsible sections
│   └── *.css             # Component/page styles (e.g., TenderDetail.css)
├── pages/                # Self-contained CRUD pages (no shared state)
└── api/                  # ЕДИНСТВЕННЫЙ доступ к серверу (Р3 переезда, migration/PLAN.md)
    ├── index.js          # db, auth, objectPhotos, invokeFunction, subscribeTable
    ├── db.js             # таблицы и RPC: db.from(...), db.rpc(...) — построитель как у supabase-js
    ├── auth.js           # вход (фаза A — Supabase Auth): только RoleContext и сервисы
    ├── files.js          # обложки объектов: бакет Supabase или (ospDb) cloud.ru через osp-api, адрес /api/covers/<имя>
    ├── ospCovers.js      # загрузка обложки через osp-api: ссылка cover-upload → PUT в cloud.ru (тип файла подписан)
    ├── functions.js      # invokeFunction(name, options) — Edge Functions или osp-api (флаг ospApiAi); файлы — ospFiles (флаг ospApiFilesV2)
    ├── serverPath.js     # правило выбора пути файлов и ИИ: при данных в базе Яндекса (ospDb) файлы — только через osp-api, функция файлов Supabase не вызывается
    ├── ospFiles.js       # файлы через osp-api с ключом операции: upload → PUT → confirm, удаление — строка, затем объект
    ├── ospApi.js         # вызов своего API /api/fn/<имя> с ответом как у functions.invoke
    ├── realtime.js       # subscribeTable(...) — онлайн-обновления
    ├── supabaseClient.js # единственный createClient; импортируют только адаптеры
    └── clientErrors.js   # наблюдение за отказами для телеметрии

server/osp-api/           # свой API (Node, Fastify): маршруты вместо Edge Functions, README там же.
                          # Права — на маршруте (src/lib/access.js): без config.access маршрут не
                          # регистрируется; открытые адреса — только из src/open-routes.js; тело — по схеме
                          # zod. Эталоны прав — tests/osp-api/baseline (UPDATE_BASELINE=1 npm run test:api)
supabase/                 # Database schemas (NOT in src/)
├── schemas/              # Table definitions (preferred for reading)
└── migrations/           # Chronological schema changes
```

### Data Flow Pattern

No centralized state management. Each page:
1. Fetches data in `useEffect` on mount
2. Manages local state with `useState`
3. Calls the server through `src/api` adapters (`db.from`, `db.rpc`) for mutations
4. Re-fetches after mutations to sync UI

### Role-Based Access

Two roles stored in `localStorage('userRole')`: `employee` (full access) and `contractor` (proposals only). This is app-level role selection, not Supabase Auth.

```javascript
import { useRole } from './contexts/RoleContext'
const { isEmployee, isContractor, isLoggedIn, logout } = useRole()
```

Contractor login also stores `contractorInfo` (id, name) for proposal filtering.

### Routing (App.jsx)

- `/login` - Role selection
- `/contractor` - Кабинет подрядчика ([ContractorCabinetPage](src/pages/ContractorCabinetPage.jsx)): тендеры (открытые и свои, расценка ВОР на сайте, анкета) и договоры; прежние `/contractor/proposals` и `/contractor/negotiations` ведут сюда. См. «Кабинет подрядчика: расценка на сайте»
- `/contractor-bids` - прежний адрес сводки расценок подрядчиков: ведёт в реестр расценок, вкладка «Расценки подрядчиков (актуальные тендеры)» (`/rates-registry?tab=bids`)
- `/general` - General info hub (GeneralInfoPage): карточки разделов (в т.ч. «Отделы» — без отдельного права) и «Наши порталы» (FOT, Signal, Larix, Обработка РД, BillHub, Estimat, Payhub, Финансовый портал, АВТО, Garanthub — название-ссылка в новой вкладке, адрес не показывается; список — `PORTALS` в GeneralInfoPage.jsx, тест — `tests/tender/general-portals.test.mjs`)
- `/general/objects|contacts|counterparties` - General info subpages (employees)
- `/general/departments` - Отделы компании ([DepartmentsPage](src/pages/DepartmentsPage.jsx)): блоки, функции, руководители и телефоны (`company_departments`, миграция 20261104). Видит любой сотрудник; правит администратор — карточка отдела, порядок стрелками, «Руководители списком» (`№ | ФИО | должность | телефон`, разбор — [companyDepartments.js](src/utils/companyDepartments.js)). ФИО и телефоны в коде и миграциях не хранятся (репозиторий открыт) — только в базе. Короткий список отделов сотрудников (`departments`, вкладка «Отделы» в «Сотрудниках СУ-10») — отдельный, не путать. Тест — `tests/tender/company-departments.test.mjs`
- `/general/objects/:objectId` - Object detail (5 tabs: info, documents, warranty, warranty retentions, estimate). Во вкладке «Смета» сверху — ДГП ([ObjectDgpFiles](src/components/ObjectDgpFiles.jsx)): единый ПСДЦ договора генподряда, комплектный и полный, одна кнопка на один-два файла; вид — по шапке таблицы ([dgpWorkbook.js](src/utils/dgpWorkbook.js)), не определился — выбор в окне; файлы — `s3_documents` объекта, `doc_category` `dgp_compact` / `dgp_full`, заголовок и сумма из файла — JSON в `notes`; новый файл вида заменяет прежний. Тесты — `tests/tender/dgp-workbook.test.mjs`, `object-dgp.test.mjs` (стенд `/stand/dgp`)
- `/tenders/construction|warranty` - Tender lists by department
- `/tenders/:tenderId` - Tender detail with estimates, documents, and proposals
- `/contracts` - Contract registry (ContractsPage)
- `/analysis-kp` - КП analysis tool (BSMPage) - Excel import & pivot analysis
- `/bsm` - Material management hub (BSMSelectionPage)
- `/bsm/*` - Material management (БСМ):
  - `/bsm/comparison` - Compare rates across sources (BSMComparisonPage)
  - `/bsm/contract-rates` - Agreed contract rates (BSMContractRatesPage)
  - `/bsm/supply-rates` - Supply department rates (BSMRatesPage)
  - `/bsm/contractor-rates` - Contractor-specific rates (BSMContractorRatesPage)
- `/acceptance` - Acceptance page (placeholder)
- `/reports` - Отчёты (ReportsPage): три вкладки — «Тендеры» (подвкладки: обзор, коммерческие предложения, победители, материалы, планы затрат, ВОРы и РД, работа инженеров), «Договоры» и «Заявки на ДС» (право «Отчёты: все вкладки» и просмотр «Заявок на ДС»; [DcRequestStats](src/components/reports/DcRequestStats.jsx), расчёт — [dcRequestStats.js](src/utils/dcRequestStats.js): этапы, «Было подано» / «Утверждено», просрочка срока утверждения, итог проверки, задачи, за сегодня / неделю / месяц / всё время, динамика, разрезы по объектам, ответственным, типу ДС, материалу, контрагентам; дата завершения — из журнала смены статуса; справочники — [dcRequestOptions.js](src/utils/dcRequestOptions.js), общие с реестром; тесты — `tests/tender/dc-request-stats.test.mjs`, `reports-dc.test.mjs`). «Коммерческие предложения» ([KpStats](src/components/reports/KpStats.jsx), расчёт — [kpStats.js](src/utils/kpStats.js)): загрузка и проверка КП за сегодня / неделю / месяц / всё время, очередь «Проверки КП», динамика, кто загружает и проверяет

### Theming

```javascript
import { useTheme } from './contexts/ThemeContext'
const { theme, toggleTheme } = useTheme()
```

CSS variables defined for `[data-theme="light"]` and `[data-theme="dark"]` in `index.css`.

### Typography & tables (UI guidelines)

Правила типографики и таблиц — **[docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md)**. Читать перед правкой вёрстки.
Рабочий стиль (шрифт Inter с нашего сервера — `src/styles/fonts.css`, `public/fonts/inter/`) подключён к
«Планам затрат», «Тендерам — Основное строительство», «Тендерам на материалы», «Заявке на ДС» — общий слой
`src/styles/workUi.css` (класс `ui-work` на корне страницы + `useBodyClass('ui-work-portal')`), и к «ВОРам и РД»
(`VorsTypography.css`, те же токены). Кратко: шкала 20/28 · 16/24 · 14/20 · 13/18 · 12/16 в `rem` (токены `--ui-*`),
заголовки колонок без прописных, `tabular-nums` для чисел и дат, суммы вправо, даты/суммы/номера без многоточия,
описания — `ClampText` (3 строки + «Показать полностью»), ФИО — `PersonName`, иконки действий — SVG с `aria-label`,
ширины колонок в rem по замерам + `min-width` таблицы (узкое окно — прокрутка таблицы, не мельче шрифт),
контраст ≥ 4,5:1 (ссылки — `--ui-link`). `TendersPage` рендерит и ГО/совместные/прочие — у них рабочий стиль
выключен (`uiWork`), их вид не менять без отдельной задачи. Реестр «Основное строительство» — плотный вариант
(`tp-dense`: 13/18 в таблице, 12/16 заголовки и статусы, шапка в одну строку, вертикальные разделители) —
описан в UI_GUIDELINES, на другие разделы автоматически не переносить. У «Планов затрат» — плотный вариант `cp-dense` (конец `CostPlansPage.css`): вернулись сетка,
лёгкая зебра и зелёный маркер шапки, описание — ссылка. У «Тендеров на материалы» — плотный вариант `tp-dense-mat` (там же): ссылка-описание с подчёркиванием,
сроки 11rem (плашка не налезает на соседнюю колонку). У «Заявки на ДС» — свой плотный вариант
`dcr-dense` (конец `DcRequestsPage.css`, только на компьютере): широкие «Документы», кнопки файла в углу карточки,
сумма и подпись в строку. «Проверка КП» (`/kp-review`, [KpReviewPage](src/pages/KpReviewPage.jsx)) — на рабочем слое со
своей сеткой (`KpReviewPage.css`): сверху название и этапы (подписи веток — плашками), под ними поиск и направления;
КП сгруппированы по тендеру (строка тендера залипает под шапкой таблицы), в строке КП — контрагент полужирным, «КП» и
«Скачать» вместо имени файла, даты «дд.мм.гг», проверка — в одной ячейке («Проверить» / плашка вердикта с карандашом,
колонки «Действия» нет), флажки «В сводной» / «Подрядчику»; на телефоне — карточки. Тест — `tests/tender/kp-review.test.mjs` (стенд `route=/kp-review&kpReview=1`).

## Кабинет подрядчика: расценка на сайте (миграция 20261102)

Решения пользователя 23.10.2026: расценивает только вошедший подрядчик (учётку с организацией заводит
администратор); инженер видит подрядчика и его организацию и решает, сделать ли его участником; цены видны отделу
сразу, без отправки; поля анкеты ведёт администратор; сводка цен — пока только администратору. 23.10, позже: сводка —
не отдельный раздел, а вкладка реестра расценок «Расценки подрядчиков (актуальные тендеры)»; после завершения тендера
расценки по позициям падают в «Расценки от подрядчиков (КП)».

- **Тендеры кабинета** — `bid_contractor_tenders()`: открытые (тот же отбор, что `public_open_tenders`) и те, где
  организация участник (`tender_counterparties`) или подала заявку; номер, объект, сроки, ответственный (ФИО и телефон),
  доступ и сколько расценено. Нет функции (база не обновлена) или просмотр от имени роли — как раньше, только приглашения.
- **Заявка** — «Участвовать и расценить» → `bid_request` (`tender_bid_requests`, `pending`, не больше 30 за сутки на
  организацию). Сразу открываются файлы ВОР и тендерный пакет (правило `portal_contractor_select` на `s3_documents`:
  свои тендеры + заявка не отклонена) и расценка. Инженер в раскрытой строке реестра тендеров видит «Заявки с сайта»
  ([BidRequestsBlock](src/components/contractor/BidRequestsBlock.jsx)), в строке — «заявки: N»; «Сделать участником» —
  `bid_decide` (строка участника в конце списка, «КП предоставлено», если цены уже есть; право — правка «Тендеров»),
  «Отклонить» — расценка только для чтения, файлы закрыты, цены остаются.
- **Позиции** — из Excel-файлов ВОР тендера («ВОРы и РД», `vor_statement` / `vor`) в браузере подрядчика
  ([bidVor.js](src/utils/bidVor.js)): листы «Материалы» и «Работы» (шапка по словам, как у снабжения), «КП» — структура
  (разделы по номеру, «Р» / «Работа» — работа, «мат.» / «Обор.» — материал, конец таблицы — первое «Итого»); нет листа
  списка — позиции этого вида из «КП». Объём материала в «КП» — «Общий расход», а если он у материалов похож на
  коэффициент (ВОР прежнего вида: 1; 1,02) — «Объём». Вкладка «ВОР» карточки (`tender_estimate_items`) с июня 2026 не
  заполняется — прежний путь «шаблон КП / загрузить КП» остаётся только там, где она есть.
- **Цена** — одна на уникальную позицию тендера: вид + `normName` + `normUnit` (несколько файлов ВОР — одна строка,
  объёмы складываются). `tender_bid_rates`, пишет только `bid_rates_save` (тендер открыт, доступ есть, ≤ 2000 строк за
  вызов, ≤ 20 000 на тендер; итог = цена × объём считает база). Сохранение — само ([BidWorkspace](src/components/contractor/BidWorkspace.jsx)),
  «Мои прошлые цены» — свои цены тех же позиций из других тендеров. «Структура КП» — лист «КП» с ценами и суммами по
  разделам, только просмотр. «Скачать Excel» — материалы, работы и «КП» каждого ВОР ([bidExport.js](src/utils/bidExport.js)).
- **Цены из файла** ([BidImportDialog](src/components/contractor/BidImportDialog.jsx), [bidImport.js](src/utils/bidImport.js)):
  свой прайс, КП, счёт (Excel, CSV, PDF с текстом) или заполненный ВОР — разбор и похожесть как у «Цен из счёта / КП»
  снабжения; строки листов «Материалы» / «Работы» ищут только среди позиций своего вида; НДС — как в документе / с НДС /
  без НДС + ставка; своя цена заменяется только по отметке.
- **Сводка администратору** — реестр расценок (`/rates-registry?tab=bids`) → вкладка «Расценки подрядчиков (актуальные
  тендеры)» ([ContractorBidsSection](src/components/contractor/ContractorBidsSection.jsx), только `isAdmin`): подвкладки
  «Тендеры и подрядчики» (`bid_admin_overview` без завершённых тендеров: участие, суммы, НДС, анкета; подробности и
  выгрузка), «Позиции» (цены списком), «Поля анкеты».
- **После завершения тендера** (статус «Завершен») цены с сайта — в «Расценках от подрядчиков (КП)»: третья ветка
  `kp_rates_registry_mv` (миграция 20261103_kp_registry_site_bids, обе базы; в базе Яндекса представление в
  `osp_private`, фильтры по подрядчику и объекту — функции загрузчика, их не трогаем). Одна строка на тендер, подрядчика,
  вид, наименование и ед. изм.: КП из файла и цена с сайта — более свежая; дата — день правки по Москве. Появляются при
  пересчёте реестра (раз в 10 минут или «Обновить»). Пока тендер идёт, в реестре КП их нет. Проверка —
  `migration/backup/checks/20261103.sql`, откат — `migration/rollback/20261103_kp_registry_site_bids_rollback.sql`,
  тест — `tests/tender/kp-registry-site-bids-db.test.mjs`.
- **Анкета** — поля `bid_form_fields` (администратор: реестр расценок → «Расценки подрядчиков (актуальные тендеры)» →
  «Поля анкеты»; добавить, переименовать,
  скрыть, порядок; поле — текст или выбор из списка с вариантами), ответы `tender_bid_forms` (`bid_form_save`: подпись
  поля — слепком, у списка — только вариант из списка), «Подставить ответы из прошлой анкеты». По умолчанию — 14 полей
  «Главного листа» ВОР (снимок 23.10). **Ставка НДС** (`code = 'vat'`, как выпадающий список «Указать % НДС» в файле):
  22 / 7 / 5 / 0 % (как у контрагентов, [bidForm.js](src/utils/bidForm.js); 20 %, 10 % и «Без НДС» убраны 23.10 — прежний
  список меняет «вернуть ставки по умолчанию» в «Полях анкеты»); не указана — в итогах «не указана — выбрать», указана —
  «в т. ч. НДС», прежний ответ «Без НДС» — цены и итог без НДС; ставка по умолчанию в «Ценах из файла»,
  колонка «НДС» в сводке администратора. Поле НДС не удалить и не скрыть.
- **Особые условия** «Главного листа» файла ВОР (блок «Особые условия, которые…»: ГУ, гарантия, шаблон договора) —
  подрядчику над вкладками расценки (`readMainConditions`, строки под заголовком до пустой строки или анкеты).
- **Права** (обе базы): заявки читают сотрудник и организация; цены и анкету — `is_admin()` и организация; поля анкеты —
  сотрудник и подрядчик с организацией, правит администратор; прямой записи нет; гостю — ничего. Закрытый тендер — только
  чтение. База Яндекса — `migration/yandex/20261102_contractor_bids.sql`; проверка — `migration/backup/checks/20261102.sql`,
  откат — `migration/rollback/20261102_contractor_bids_rollback.sql`. Тесты: `tests/tender/contractor-bids.test.mjs`
  (разбор, суммы, сопоставление), `contractor-bids-db.test.mjs` (база на слепке), `contractor-cabinet.test.mjs` (стенд
  `tests/tender/ui/cabinet.html`: кабинет, импорт, анкета, реестр тендеров с заявкой, вкладка реестра расценок).

## Свой вход tender.su10.ru (AUTH_MODE)

Новый портал входит без Supabase Auth: учётки — `auth.users` базы Яндекса (те же id), пароли — закрытая схема
`osp_auth` (только отметка `osp:auth`, зашифрованы ключом `OSP_AUTH_KEYS`), сессии — `osp_session`, cookie
`__Host-osp_session` + CSRF `__Host-osp_csrf`. osp.root.sx остаётся на Supabase. Режим — `AUTH_MODE`
(`supabase` | `both` — пилот | `own`), фронт узнаёт его из `/api/auth/config` только при `authServer: true` в
`config.json`. Фронт: фасад `src/api/auth.js` (Supabase или `ownAuth.js`), `session.js` (CSRF, события сессии),
`authMode.js`; `RoleContext` (временный пароль, окно повторного входа), `ChangePasswordForm`, `ReloginModal`,
«Добавить пользователя» / «Сбросить пароль» в `AdminPage`. Сервер: `server/osp-api/src/lib/auth/*`,
`src/lib/principal.js`, `src/routes/auth.js`; миграция `migration/yandex/20261019_own_auth.sql`; перенос паролей —
`migration/accounts/`; порядок — `migration/CUTOVER.md` («Свой вход tender.su10.ru»). Самостоятельной регистрации
нет (писем нет): учётки и временные пароли выдаёт администратор. Тесты: `tests/osp-api/own-auth*.test.mjs`,
`client-auth.test.mjs`, `tests/backup/own-auth-accounts.test.mjs`.

## Supabase Integration

### Client Usage

Весь доступ к серверу — через адаптеры `src/api/`. Импорт `@supabase/*` и клиента вне `src/api/`
запрещён ESLint (`no-restricted-imports`) и `npm run check:transport`: при переезде (этап 3,
`migration/PLAN.md`) меняются адаптеры, а не страницы. `db` отдаёт тот же построитель и тот же ответ
`{ data, error, count }`, что supabase-js.

```javascript
// From pages/ directory:
import { db } from '../api'

// Fetch with joins
const { data } = await db
  .from('contracts')
  .select('*, objects(name), counterparties(name)')
  .order('created_at', { ascending: false })

// Nested relationships
.select('*, counterparties(id, name, counterparty_contacts(full_name, phone))')

// Named relationship for winner
.select('*, winner:counterparties!winner_counterparty_id(id, name)')
```

### Database Tables

| Table | Purpose | Key Foreign Keys |
|-------|---------|------------------|
| `objects` | Construction sites | - |
| `contacts` | Personnel linked to objects | `object_id` |
| `counterparties` | Contractor directory. Карточка (клик по строке) — вкладка «Общая информация» ([components/counterparty/](src/components/counterparty/)): реквизиты, НДС (`vat_rate` / `vat_exempt` — ставка или «без НДС», миграция 20261026; в выборе с 23.10 только 22 / 7 / 5 / 0 %, записанные 20 %, 10 % и «Без НДС» видны как есть, пока их не сменят; меняется и в колонке «НДС» реестра — тот же [CounterpartyVatSelect](src/components/counterparty/CounterpartyVatSelect.jsx) и та же запись `handleVatChange`, без колонок в базе колонки нет), примечание (колонки в реестре нет), аффилированные компании — группа `counterparty_relations` (кнопки и окна «Связи» в реестре нет с 21.10 — только здесь), договоры и ДС, где контрагент — сторона (`contracts.counterparty_id` или `contract_counterparties`) или договор прикреплён вручную (`counterparty_contract_links`) | - |
| `counterparty_contract_links` | Договор, прикреплённый к контрагенту вручную (миграция 20261031): «Общая информация» карточки → «Договоры и ДС» → «+ Прикрепить договор» (поиск по номеру, предмету, объекту и контрагенту договора), показывается со всеми ДС; администратору — пометка «добавлен вручную» (кто и когда — `created_by` ставит триггер), с правом правки «Контрагентов» — «открепить»; обе записи — в журнал «Изменения». Стороны договора НЕ меняет: реестр договоров и кабинет подрядчика (`is_my_contract`) привязку не видят. Читает сотрудник, прикрепляет и открепляет `osp_can('counterparties','edit')`, UPDATE не выдан. Таблицы ещё нет — раздел как раньше, без кнопки ([counterpartyContracts.js](src/services/counterpartyContracts.js)) | `counterparty_id`, `contract_id` (CASCADE), `UNIQUE(counterparty_id, contract_id)` |
| `counterparty_contacts` | Contact persons | `counterparty_id` (CASCADE) |
| `contracts` | Contract registry | `object_id`, `counterparty_id` |
| `tenders` | Tender management | `object_id`, `winner_counterparty_id`, `responsible_contact_id` |
| `tender_counterparties` | Tender participants | `tender_id`, `counterparty_id` (CASCADE) |
| `tender_estimate_items` | Estimate line items | `tender_id` (CASCADE) |
| `tender_counterparty_proposals` | Price proposals | `estimate_item_id`, `counterparty_id` |
| `tender_documents` | Tender attachments (Google Drive links) | `tender_id` (CASCADE) |
| `tender_proposal_files` | Uploaded Excel КП files from contractors | `tender_id`, `counterparty_id` (CASCADE) |
| `tender_vor_supply_rates` | Расценки от снабжения по материалам ВОР тендера (task 398). Привязка к документу-ВОР через `estimate_name`; сопоставление с позициями по `material_name` (`material_key`). Стоимость = `material_consumption × (supply_price_exact ?? supply_price)`. День расценки `price_date` (по Москве) и копии цен других тендеров (`source_rate_id`, `source_kind`) — 20261023. Ввод на сайте — см. «Расценка снабжением на сайте». | `tender_id` (CASCADE), `UNIQUE(tender_id, estimate_name, material_name)` |
| `tender_supply_sources` | Позиции ВОР для расценки снабжением: разобранный лист «Материалы» файла из «ВОРов и РД» или вкладка «ВОР» карточки; строка на основной тендер и ВОР (`positions jsonb`) | `tender_id` (CASCADE), `s3_document_id` (SET NULL), `UNIQUE(tender_id, estimate_name)` |
| `tender_supply_rate_log` | Журнал каждого изменения расценки снабжения (триггер): было / стало, кто, когда | без FK (не мешает удалению тендера) |
| `tender_supply_import_state` | Состояние разбора позиций ВОР службой osp-api (миграция 20261024): статус по основному тендеру для реестра тендеров на материалы и причины отказов файлов; пишет только служба | `tender_id` (PK, CASCADE) |
| `tender_supply_revisions` | Версии ВОР в расценке снабжением (миграция 20261029): что изменилось в позициях при замене файла / перезагрузке вкладки «ВОР» / удалении файла (`changes`) и снимок цен на тот момент (`prices`); пишет только триггер на `tender_supply_sources`, «просмотрено» — `supply_revisions_review`. См. «Расценка снабжением на сайте» | `tender_id` (CASCADE) |
| `tender_supply_links` | Документ (чек, счёт, КП поставщика) к позиции расценки снабжением — колонка «Документ» (миграция 20261022): одна на (тендер, ВОР, `material_key`), отдельно от цены; адрес http(s) или `\\сервер\папка` — либо файл `s3_document_id` (20261025, одно из двух) | `tender_id` (CASCADE), `s3_document_id` → `s3_documents` (CASCADE), `UNIQUE(tender_id, estimate_name, material_key)` |
| `bsm_contract_rates` | Agreed material rates | `object_id` (CASCADE) |
| `bsm_supply_rates` | Supply dept rates (has `applied_at` date) | `object_id` (CASCADE) |
| `bsm_contractor_rates` | Contractor-specific rates | `object_id`, `counterparty_id` (CASCADE) |
| `object_documents` | Object documents (contracts, agreements, attachments). Files via S3 (`signed_s3_document_id`, `editable_s3_document_id` → `s3_documents`, ON DELETE SET NULL). | `object_id`, `parent_document_id` (CASCADE), `signed_s3_document_id`, `editable_s3_document_id` (SET NULL) |
| `object_cost_plan` | Cost plan items per object | `object_id` (CASCADE) |
| `object_estimate_items` | Object estimate line items (imported from Excel) | `object_id` (CASCADE) |
| `object_warranties` | Warranty periods per object — поддерживает начало по дате ИЛИ по событию (`start_type`, `start_event_text`), привязку к документу-акту (`start_document_id`), фиксированную дату окончания `end_date_override` и `notes` | `object_id` (CASCADE), `start_document_id` (SET NULL) |
| `object_warranty_retentions` | Warranty retention terms (percentage + period) | `object_id` (CASCADE) |
| `psdc` | ПСДЦ / ВОР: одна загруженная ведомость (см. раздел «ПСДЦ / ВОР») | `document_id` → `contracts` (CASCADE), `batch_id`, `previous_psdc_id` |
| `psdc_rows` / `psdc_source_rows` / `psdc_issues` | Рассчитанные строки, сырые ячейки XLSX, ошибки/предупреждения проверки | `psdc_id` (CASCADE) |
| `psdc_batches` | Пакет массовой загрузки ПСДЦ | — |
| `osp_private.larix_rates` → вью `larix_rates_registry` | Договорные расценки из Larix.CPM (см. раздел «Договорные расценки (Larix)»): строка = позиция договора с ценой материалов и ценой работ, повторы схлопнуты. Пишет только загрузка osp-api; прежняя `larix_contract_rates` (строка × вид) с 20261021 не пишется | `osp_contract_id` (наш договор, без FK) |
| `larix_sync_runs` / `larix_sync_stage` | Журнал загрузок из Larix (статус, причина, списки фильтров) и порции текущей загрузки | `larix_sync_stage.run_id` (CASCADE) |
| `vor_rd_sets` | Комплекты РД в «ВОРах и РД» (миграция 20261027): список под строкой тендера или заявки, раскрывается нажатием по строке или стрелкой у номера ([VorRdSetsPanel](src/components/VorRdSetsPanel.jsx)). Комплект РД, ВОР готов (да / нет), срок выдачи ВОРа, ссылка (http(s) или `\\сервер\папка`), примечание; № п/п не хранится — порядок `sort_order`. Читает сотрудник, пишет правка «Тендеров» или «ВОРов и РД» (`vor_rd_can_edit()`). Ссылка комплекта открывает статус ВОР «Завершён», как ссылка и файлы раздела. Тест — `tests/tender/vor-rd-sets.test.mjs` | `tender_id` или `vor_request_id` — ровно одно (CASCADE) |
| `tender_bid_requests` / `tender_bid_rates` / `tender_bid_forms` / `bid_form_fields` | Кабинет подрядчика (миграция 20261102, см. «Кабинет подрядчика: расценка на сайте»): заявка на участие с сайта, цена подрядчика по уникальной позиции ВОР тендера (вид + наименование + ед. изм.), анкета организации по тендеру и поля анкеты. Пишут только функции `bid_*`; цены и анкету читают администратор и сама организация | `tender_id`, `counterparty_id` (CASCADE); `UNIQUE` на тендер и организацию (у цен — и на позицию) |
| `dc_requests` | Заявки на ДС (`/dc-requests`, [DcRequestsPage](src/pages/DcRequestsPage.jsx)). «№» — постоянный номер заявки `request_number` (миграция 20261106, обе базы: `GENERATED ALWAYS AS IDENTITY`, прежним — по дате создания, сначала не удалённые; не меняется и не переиспользуется), а не номер строки выборки: при смене вкладки и фильтров тот же; в поиске «12» / «№ 12» — эта заявка. Колонки ещё нет — номер считает `withRequestNumbers` ([dcRequestOptions.js](src/utils/dcRequestOptions.js)) тем же порядком. Тест — `tests/tender/dc-request-number.test.mjs` (стенд `route=/dc-requests&dcStats=1`, `dcNumbers=1`) | `object_id` (CASCADE), `counterparty_id` |
| `company_departments` | Отделы компании (миграция 20261104, обе базы): блок, название, основные функции, примечание («Руководитель отсутствует»), `contacts` — руководители и контакты `[{name, position, phone}]` (чистит триггер). Читает сотрудник (`osp_is_employee()`), правит только `is_admin()`. Начальный список — 26 отделов без ФИО и телефонов (только в пустую таблицу); людей вносит администратор на странице. Таблицы ещё нет — страница подсказывает про миграцию | — |
| `object_site_contacts` | Контакт площадки (миграция 20261030): «Тендеры — Основное строительство» → «Документы раздела» → вкладка «Контакт площадки» ([SiteContactsTab](src/components/SiteContactsTab.jsx)) — по выбранному объекту список подразделений ВОР (`VOR_DIVISIONS`, с той же миграции шестое — «Отделка», `finishing`, в CHECK `tenders` и `vor_requests`), у каждого ФИО, телефон, Telegram; одна строка на объект и подразделение. Читает сотрудник, назначает только администратор (`is_admin()`). Подразделение без контакта временно закрывает руководитель строительства объекта (`object_staff`, `construction_manager`) — плашка «Временно»; нет и его — красным «Требуется заполнение». Письмо подрядчикам формируется всегда: строка «Если потребуется выезд на объект…» (`{site_contact}`, только ФИО и телефон, [siteContacts.js](src/utils/siteContacts.js)) — после «…по какому тендеру и объекту обращаетесь.»; без своего контакта — руководитель строительства, нет и его — `[контакт площадки не указан]`, предупреждение в окне письма. Почта в письме — общий ящик `tender.osp@su10.ru`, перед ссылкой на документацию — пояснение к листам «Главный лист» / «Материалы» / «Работы» / «КП»; шаблон `letterTemplate:v4`, сохранённые v2 / v3 дополняет `upgradeLetterTemplate`. Тест — `tests/tender/site-contacts.test.mjs` | `object_id` (CASCADE), `UNIQUE(object_id, division)` |

**Key ENUMs:**
- `objects.status`: `'main_construction'` | `'warranty_service'`
- `counterparties.status`: `'active'` | `'blacklist'`
- `tender_counterparties.status`: `'request_sent'` | `'declined'` | `'proposal_provided'`
- `tender_documents.document_type`: `'attachment'` | `'estimate_template'`
- `tender_estimate_items.estimate_name`: Text field for grouping multiple estimates per tender (default: 'Основная смета')
- `tenders.status`: `'Не начат'` | `'Идет тендерная процедура'` | `'Завершен'`
- `object_documents.document_type` (ENUM `object_document_type`): `'general_contract'` | `'additional_agreement'` | `'attachment'`

### Schema Files

**Note:** Schema files provide reference definitions, but migrations are the source of truth for the current database state.

- `supabase/schemas/prod.sql` - Full production schema (large, includes all Supabase system tables)
- `supabase/schemas/*.sql` - Individual table schemas (reference for reading/editing)
- `supabase/migrations/` - Chronological migrations (authoritative for schema changes). Newer files use date prefix `YYYYMMDD_description.sql`; some early migrations use plain descriptive names (e.g., `add_status_to_objects.sql`). Check this directory for the latest schema state.

### Schema Change Workflow

1. Create migration file in `supabase/migrations/` with descriptive name (e.g., `add_field_to_table.sql`)
2. Update corresponding schema file in `supabase/schemas/`
3. Apply migration via Supabase dashboard SQL editor or CLI
4. База нового портала (Яндекс, одна учётка) — отдельная миграция в `migration/yandex/` по правилам
   `migration/yandex/README.md` (роли Supabase там не существуют). Применяет `scripts/deploy-server.sh migrate`:
   одна транзакция, проверка прав под одну учётку, при FAIL — откат. Проверка на копии прода — `npm run test:db`.

## S3 Document Storage (cloud.ru)

Task 277. Универсальное хранение файлов в S3-совместимом хранилище cloud.ru (bucket `osp`). Архитектура: браузер → Supabase Edge Function `s3-presign` → presigned URL → cloud.ru. Секреты живут только на стороне Edge Function, в браузер не попадают.

### Components

- Таблица `s3_documents` — единая для всех разделов. Привязка через `(owner_type, owner_id)`. Поддерживаемые типы: `'tender'`, `'contract'`, `'object'`, `'customer'`, `'general'` (расширяется в `FOLDER_BY_OWNER` в edge-функции).
- Edge Function `supabase/functions/s3-presign/index.ts` — операции `upload` / `download` / `delete`. Требует Authorization (Supabase JWT).
- **Переезд (заход Б):** с флагом `ospApiFilesV2` файлы идут через свой API — `/api/fn/s3-presign` в
  [server/osp-api](server/osp-api/README.md): ключ операции (UUIDv7 = `s3_documents.id`) делает повтор
  безопасным, удаление — сначала строка, затем объект, загрузка и удаление проверяют право раздела
  (`osp_can`). Фронт — [src/api/ospFiles.js](src/api/ospFiles.js); `services/s3.js` выбирает путь в начале
  операции, вызовы страниц не меняются.
- Frontend сервис [src/services/s3.js](src/services/s3.js): `uploadFile`, `fetchDocuments`, `requestDownloadUrl`, `deleteDocument`, `deleteS3Object`.
- Универсальный UI-компонент [src/components/S3DocumentList.jsx](src/components/S3DocumentList.jsx): список + загрузка + удаление + превью. Принимает props `{ownerType, ownerId, title, canEdit?}`. По умолчанию `canEdit = isEmployee`, подрядчики только смотрят.
- Модалка просмотра [src/components/S3DocumentPreview.jsx](src/components/S3DocumentPreview.jsx) — PDF через iframe, изображения через `<img>`, прочие типы — fallback с кнопкой скачать.

### Usage example

```jsx
import S3DocumentList from '../components/S3DocumentList'

<S3DocumentList ownerType="tender" ownerId={tenderId} title="Документы" />
```

S3-ключ объекта формируется автоматически: `{folder}/{owner_id}/{uuid}-{file_name}`.

### Environment variables (root `.env`)

Все переменные — и фронта (Vite), и Edge Function — лежат в одном файле `.env` в корне репо. Шаблон — [.env.example](.env.example). Файл `.env` игнорируется git'ом (паттерн `.env*` в `.gitignore`).

| Переменная | Назначение |
|------------|-----------|
| `VITE_SUPABASE_URL` | Endpoint Supabase, читается фронтом |
| `VITE_SUPABASE_ANON_KEY` | Публичный ключ Supabase, читается фронтом |
| `S3_ENDPOINT` | Endpoint S3 (`https://s3.cloud.ru` для cloud.ru) |
| `S3_REGION` | Регион бакета (`ru-central-1`) |
| `S3_BUCKET` | Имя бакета (`osp`) |
| `S3_ACCESS_KEY_ID` | Access Key ID для S3 |
| `S3_SECRET_ACCESS_KEY` | Secret Access Key для S3 |
| `ANTHROPIC_API_KEY` | Ключ Claude API для Edge Function `ai-assist` (см. раздел «ИИ-помощник») |

`SUPABASE_URL` и `SUPABASE_ANON_KEY` без префикса `VITE_` Supabase инжектирует в runtime функции автоматически — указывать не нужно.

### Edge Function deployment (one-time setup)

1. Установить Supabase CLI: `npm i -g supabase` (или `scoop install supabase`).
2. `supabase login` и `supabase link --project-ref <project-ref>` в корне репо.
3. Скопировать `.env.example` → `.env` в корне и заполнить (см. таблицу выше).
4. Локально (для разработки функции):
   ```bash
   supabase functions serve s3-presign --env-file .env
   ```
5. Деплой на прод:
   ```bash
   supabase secrets set --env-file .env
   supabase functions deploy s3-presign
   ```

`supabase secrets set --env-file .env` пушит **все** ключи из `.env` как секреты функции — `VITE_SUPABASE_*` тоже улетят, но не используются и вреда не приносят.

### CORS на бакете cloud.ru

В консоли cloud.ru: Object Storage → бакет `osp` → раздел «Разрешения» / «Настройки» → секция «CORS». Возможны два формата ввода: JSON-массив правил или форма с полями.

#### Готовый JSON

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "http://osp.root.sx",
      "https://osp.root.sx",
      "https://tender.su10.ru"
    ],
    "AllowedMethods": [
      "GET",
      "PUT",
      "HEAD"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

#### Поля по отдельности (если UI — форма)

| Поле | Значение | Зачем |
|------|----------|-------|
| **AllowedOrigins** | `http://localhost:5173`, `http://osp.root.sx`, `https://osp.root.sx`, `https://tender.su10.ru` | dev-сервер Vite, прежний портал (Supabase) в обеих схемах и новый портал с базой Яндекса (сервер corp, `migration/CUTOVER.md`). |
| **AllowedMethods** | `GET`, `PUT`, `HEAD` | `PUT` — загрузка по presigned URL; `GET` — скачивание / iframe-preview; `HEAD` — некоторые preflight'ы. `DELETE` напрямую с браузера не идёт — через Edge Function. |
| **AllowedHeaders** | `*` | Браузер при PUT шлёт `Content-Type`, `x-amz-*`. Если cloud.ru не принимает `*` — перечислить: `Content-Type`, `Authorization`, `x-amz-acl`, `x-amz-content-sha256`, `x-amz-date`, `x-amz-security-token`. |
| **ExposeHeaders** | `ETag` | `Content-Length` / `Content-Type` уже CORS-safelisted и доступны JS-у без явного экспонирования. |
| **MaxAgeSeconds** | `3600` (1 час) | Кэш preflight-ответа. |

#### Проверка после сохранения

```bash
curl -i -X OPTIONS https://s3.cloud.ru/osp \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: PUT"
```
Должен вернуться `200` с заголовками `Access-Control-Allow-Origin: http://localhost:5173` и `Access-Control-Allow-Methods: GET, PUT, HEAD`.

### Adding a new owner type

1. Добавить ключ в `FOLDER_BY_OWNER` в [supabase/functions/s3-presign/index.ts](supabase/functions/s3-presign/index.ts)
   и в osp-api ([server/osp-api/src/routes/s3Presign.js](server/osp-api/src/routes/s3Presign.js)): `FOLDER_BY_OWNER`,
   таблицу владельца в `OWNER_TABLES` и право в `WRITE_RULES` — как гейт загрузки в интерфейсе.
2. Передавать новый `ownerType` в `<S3DocumentList>` (или в `uploadFile`) и добавить место загрузки в
   `tests/osp-api/lib/upload-sites.mjs` — иначе `npm run test:api` упадёт.
3. Никаких миграций БД не нужно — `owner_type` это свободный TEXT.

## ИИ-помощник по протоколу разногласий (Edge Function `ai-assist`)

Подсказка юристу по конкретному пункту договора во вкладке «Согласование». Архитектура та же, что у S3: браузер → Edge Function → Claude API. Ключ Anthropic живёт только в секретах функции, в браузер не попадает.

- Edge Function [supabase/functions/ai-assist/index.ts](supabase/functions/ai-assist/index.ts) — `action='clause_suggest'`, модель `claude-opus-5`, требует Authorization (Supabase JWT), как `s3-presign`.
- Frontend сервис [src/services/aiAssist.js](src/services/aiAssist.js): `suggestClause({mode, clauseLabel, ourText, counterpartyText, finalText, counterpartyName, contract, comments})` + список режимов `AI_MODES`.
- UI — модалка `AiSuggestModal` внутри [src/components/ContractClausesTab.jsx](src/components/ContractClausesTab.jsx), кнопка «ИИ» на пункте видна только сотруднику (`isEmployee`).

Режимы (`mode`): `compromise` — компромиссная редакция пункта, `reply` — ответ подрядчику (позиция + текст), `risks` — разбор рисков редакции подрядчика. В модель уходит только этот пункт и переписка по нему. Результат — черновик: вставить в итоговую редакцию или отправить в обсуждение решает человек.

**Деплой** (после `supabase link`, разово):

```bash
supabase secrets set ANTHROPIC_API_KEY=<claude-api-key>
supabase functions deploy ai-assist
```

Без секрета функция отвечает 500 «ANTHROPIC_API_KEY не задан в секретах функции».

## API реестра расценок (Edge Function `rates-api`)

> **Переезд:** те же маршруты есть в своём API — `https://osp.root.sx/api/rates/{kp,supply,health}`
> ([server/osp-api](server/osp-api/README.md)). В функции без `limit` / `price_max` выдача шла по 1
> строке и только с ценой 0 (`Number(null)` = 0); в osp-api это исправлено. Правки логики делать в обоих
> местах, пока функция жива.

Выдача расценок смежному отделу (тендерный отдел, работающий с заказчиками) машинно, по ключу, **только на чтение**. Отдельная функция, а не прямой доступ к Supabase REST: ключ проекта открыл бы не реестр расценок, а всё, до чего дотягиваются политики, — здесь же наружу выставлены ровно два представления и одна операция.

- Edge Function [supabase/functions/rates-api/index.ts](supabase/functions/rates-api/index.ts).
- Ресурсы: `/kp` — расценки из КП подрядчиков (`kp_rates_registry`), `/supply` — расценки снабжения (`supply_rates_registry`), `/health` — проверка ключа.
- Колонки перечислены в коде явно: `*` вынес бы наружу всё, что когда-либо добавят в представление.

**Параметры** (все необязательные): `search`, `type` (material|work, только `/kp`), `object`, `tender`, `counterparty`, `date_from`, `date_to`, `price_min`, `price_max`, `limit` (1..1000, по умолчанию 500), `offset`, `format` (`json` | `csv`).

**Ответ:** `{ rows, limit, offset, count, has_more }`. `count` приходит `null`, если точный подсчёт по дедуп-вью не уложился в таймаут — постраничный обход при этом идёт по `has_more`.

**Ключ** — в заголовке `X-API-Key` либо в параметре `?key=` (второе ради Excel/Power Query, где заголовки задавать неудобно). Ключи лежат в секрете `RATES_API_KEYS`, несколько — через запятую, сравниваются в постоянном времени.

**Деплой** (разово). Функция вызывается без пользовательского JWT, поэтому проверку токена нужно отключить:

```bash
supabase secrets set RATES_API_KEYS=<ключ1>,<ключ2>
supabase functions deploy rates-api --no-verify-jwt
```

Пример запроса:

```bash
curl -H "X-API-Key: <ключ>" \
  "https://<project>.supabase.co/functions/v1/rates-api/kp?type=material&limit=200"
```

Для Excel/Power Query — ссылка с ключом и `format=csv`:
`https://<project>.supabase.co/functions/v1/rates-api/kp?key=<ключ>&format=csv`

Ключ в адресе попадает в историю браузера и логи прокси — выдавайте отдельный ключ на каждого потребителя, чтобы его можно было отозвать, не трогая остальных (для отзыва достаточно убрать его из `RATES_API_KEYS` и передеплоить секреты).

## Реестр расценок: материализация (миграция 20260902)

`kp_rates_registry` и `supply_rates_registry` были обычными представлениями с `DISTINCT ON` по функциям нормализации (`kp_norm_name` / `kp_norm_unit`). Индекса по таким выражениям нет, поэтому **каждый** запрос пересортировывал весь набор, а одно открытие страницы давало шесть таких прогонов: страница данных, два `count` подвкладок и три справочника фильтров (они читают то же вью и делают поверх ещё `DISTINCT`).

Теперь:

- `kp_rates_registry_mv` / `supply_rates_registry_mv` — `MATERIALIZED VIEW` с тем же SELECT;
- `kp_rates_registry` / `supply_rates_registry` — тонкие вью `select * from <mv>`, поэтому **имена для кода не изменились** (страница, экспорт, edge-функция `rates-api` работают как раньше);
- индексы на MV: `UNIQUE(id)` (обязателен для `REFRESH CONCURRENTLY`), под сортировку, фильтры и `GIN (item_name gin_trgm_ops)` для поиска;
- справочники фильтров переведены на чтение из MV.

**Права (миграция 20261013, Р2d).** У материализованного представления нет RLS и не работает `security_invoker` — оно читается напрямую, поэтому право чтения на оба MV есть **только у `service_role`**. Девять представлений реестра (`kp_rates_registry`, `supply_rates_registry`, их `*_filter_*` и `*_units`) отдают строки только при `osp_registry_reader()` — сотруднику и служебному ключу (им пользуется `rates-api`); остальным вошедшим — 0 строк. Владелец без пользователя (SQL Editor) в представлениях тоже видит 0 строк — смотреть MV. При правке этих объектов не возвращайте `grant ... to anon` / `to authenticated` на MV и не убирайте условие из представлений: это откроет цены подрядчиков. `refresh_rates_registry()` вызывает только сотрудник (или расписание без пользователя), не чаще раза в минуту.

**Обновление.** `refresh_rates_registry()` (security definer) делает `REFRESH MATERIALIZED VIEW CONCURRENTLY` обоих MV и пишет отметку в `app_settings('rates_registry_refreshed_at')`. Запускается расписанием pg_cron каждые 10 минут и кнопкой «Обновить» на странице (`db.rpc('refresh_rates_registry')`).

**Требуется включить pg_cron** в Supabase → Database → Extensions. Если расширение недоступно, миграция не падает — просто не создаётся расписание, и реестр обновляется только кнопкой.

Если менять SQL реестра — править нужно **тело MV** в миграции, а не вью-обёртку. После правки обязательно `REFRESH`.

## Расценка снабжением на сайте (миграция 20261020)

Снабжение и тендерный отдел вводят цены по позициям ВОР прямо на сайте. **Одна таблица в двух местах** —
[SupplyPricingPanel](src/components/supply/SupplyPricingPanel.jsx): вкладка «Расценки снабжения» карточки тендера (там же
«загрузить цены из Excel» по ВОР — прежний разбор файла карточки) и страница снабжения `/tenders/materials/:id/pricing`
([SupplyPricingPage](src/pages/SupplyPricingPage.jsx) — шапка + та же таблица; id — тендер на материалы или основной), вход —
«Расценка: N из M» под описанием в реестре тендеров на материалы. Карточка с участниками и КП снабжению закрыта.

- **Цены** — прежняя `tender_vor_supply_rates` **основного** тендера (`parent_tender_id`), поэтому сразу видны в карточке,
  «Сравнении КП», выгрузке ВОР и реестре СУ-10 (после пересчёта MV, до 10 минут). Отдельной «передачи» нет.
- **Позиции загружаются сами, без кнопки** ([supplyAutoImport.js](src/utils/supplyAutoImport.js), при открытии таблицы у
  того, у кого право правки): сначала лист «Материалы» Excel-файлов ВОР из «ВОРов и РД» основного тендера
  ([vorMaterialsSheet.js](src/utils/vorMaterialsSheet.js): шапка по словам, строка номеров колонок пропускается); листа
  «Материалы» нет — сам лист ВОР по колонке «КОД» (`readMaterialsByCodeBytes`, листы по одному, сначала с «ВОР» в имени,
  объём — «Общий расход», карта колонок `mode: 'code'`); если ни один файл не дал позиций — вкладка «ВОР» карточки
  ([vorMaterials.js](src/utils/vorMaterials.js)). **Материал — `isSupplyMaterial`:** код «мат…»; без кода — только с ед. изм.
  и расходом > 0; любой другой код (работа «Р», шапка «Предмет тендера:» / «КОД», номера колонок) и анкета претендента —
  не материал (раньше брали всё, что не «Р», и у тендера 445 в расценку попали шапка и анкета). Прежние списки из
  вкладки перечитываются сами (версия `vor2:`), отказы файлов в браузере — по `VOR_PARSER_VERSION`. Новый/заменённый файл и
  перезагруженная вкладка «ВОР» подхватываются так же; пустые устаревшие списки убираются, цены не трогаются никогда.
  Не загрузилось — жёлтая плашка с причиной (нет листа, шапка не распознана, нет позиций, файл не читается, не скачался) и
  «Указать лист и колонки» / «Повторить». Причина из-за самого файла запоминается в `localStorage` до замены файла —
  его не скачивают и не разбирают при каждом открытии. Из книги разбирается только лист «Материалы»
  (`readMaterialsWorkbookBytes`): соседние «КП» / «Работы» бывают огромными, полный разбор подвешивал страницу на секунды.
  Без права правки — подсказка «загрузится при открытии снабжением».
- **Все ВОР — в одной таблице**, у каждого строка-шапка (имя, файл, «расценено N из M», сумма), сворачивается.
  Имя ВОР — из имени файла; не совпало с ВОР карточки — пометка и «Привязать» (`supply_estimate_rename`).
- **Одинаковые позиции** (то же наименование по `normName` и те же ед. изм.) в других ВОР тендера получают введённую
  цену за единицу сами — только там, где цены ещё нет (решение пользователя 16.10), и там, куда цену подставили за этот
  сеанс и с тех пор не меняли (исправили цену — исправится и там); правленные вручную — свои.
- **Ссылка на документ** (чек, счёт, КП поставщика) — колонка «Документ» справа от «Итого» (`tender_supply_links`,
  миграция 20261022): к любой позиции, с ценой или без (решение пользователя 19.10), и остаётся, если цену очистили.
  Одной позиции — «+ документ» / карандаш в строке; нескольким — отметить строки (или весь ВОР в его шапке) и
  «Документ» в строке состояния ([SupplyLinkDialog](src/components/supply/SupplyLinkDialog.jsx), upsert по ключу
  позиции). Вид — как «Ссылка на КП» реестра тендеров на материалы: «Открыть» (http(s), новая вкладка) или «Скопировать»
  (сетевой путь) и карандаш, нет документа — «+ документ», домен не показывается; проверка адреса — и в базе. Права и
  закрытие — как у цен; перенос ВОР (`supply_estimate_rename`) переносит и ссылки. Таблицы ещё нет — колонки нет,
  остальное работает (`loadLinks` → null). Отметка строк — только на компьютере.
  **Документ — и файл** (миграция 20261025): в окне «Документ» вкладки «Ссылка / Файл» — загрузить с компьютера или
  выбрать уже загруженный к тендеру (`s3_documents`: `owner_type='tender'`, основной тендер, `doc_category='supply_doc'`
  — другие списки файлов тендера его не показывают, подрядчику закрыт), там же удалить файл (пропадает у всех позиций;
  у завершённого тендера — нельзя). В строке — скрепка и имя файла, открывается в `S3DocumentPreview`. Ровно одно из
  двух — адрес или файл (ограничение базы); записали одно — триггер снимает другое (так пишут и прежние вкладки).
  Колонки `s3_document_id` ещё нет — только ссылка (`linkFilesEnabled()` → false).
- **Цены из счёта / КП поставщика** (кнопка «Цены из счёта / КП» над таблицей, у кого право правки;
  [SupplyDocImportDialog](src/components/supply/SupplyDocImportDialog.jsx)): Excel (.xlsx, .xls, .csv — в UTF-8 или
  Windows-1251) или PDF с текстом. Разбор — [supplierDoc.js](src/utils/supplierDoc.js) (шапка: наименование + цена или
  сумма, в том числе двухъярусная, «с НДС» / «без НДС» по колонкам; строки до «Итого / Всего»; PDF — по словам pdf.js:
  зоны колонок от шапки, строка таблицы — по межстрочным промежуткам и колонке «№», так переносы и выравнивание по низу
  не ломают строки) и [supplierDocRead.js](src/utils/supplierDocRead.js) (xlsx и pdf.js — только по требованию; поток
  pdf.js собирает Vite `?worker` в .js — `.mjs` nginx портала отдал бы как octet-stream). Скан без текста — отказ с
  подсказкой (ИИ-распознавания нет). Сопоставление — [supplyDocMatch.js](src/utils/supplyDocMatch.js): позиции всех ВОР
  складываются в одинаковые (ключ + ед. изм.), строка документа — сначала точно по наименованию (с той же ед. изм.),
  иначе по похожести (порог 0,6 — проверяет человек), одна позиция — одной строке; в окне можно выбрать другую позицию
  (кандидаты, поиск) или снять. Цена в расценку — с НДС: колонка «с НДС» или сумма с НДС / количество; «без НДС» —
  плюс ставка (из строки, документа, иначе 22 %); человек может выбрать «с НДС — как есть» / «без НДС + НДС».
  Доставка в документе — к ценам пропорционально сумме (галочка). Своя другая цена позиции заменяется только по отметке
  («заменит …»), цена из другого тендера — сама. Запись — той же очередью, что ввод руками (`runSave`, по 4, `fill:
  false`), затем файл (если галочка) — документом всех расценённых позиций. Файл не загрузился — цены не пишутся.
- **Цены из других тендеров** (миграция 20261023, решения пользователя 19.10). Источник — свои (не скопированные) цены
  снабжения всех тендеров; день расценки `price_date` — только день, по Москве, ставит триггер расчёта при вводе или
  смене самой цены (перенос ВОР, ед. изм., прямая правка колонок его не меняют); прежним — день `updated_at` по Москве.
  Свежая — не старше 3 месяцев по дням (граница включительно); старшие остаются в реестре, но не подставляются и не
  предлагаются. **Одинаковые** (тот же `material_key` и `kp_norm_unit`) — сами: `supply_autofill` при открытии у того, у
  кого право правки, и при смене списков позиций; только где цены нет и в журнале нет записей по позиции (убранная
  вручную не вернётся), пишет `source_kind='auto'` — сразу видно в карточке и «Сравнении КП». **Похожие** (общее слово,
  доля общих слов и чисел ≥ 0,5 — `supply_name_similarity`; одни общие числа — не похожи) — «похожие цены: N» под
  наименованием: счётчики `supply_suggestion_counts` только для показанных строк, порциями ≤ 200; меню
  [SupplySuggestMenu](src/components/supply/SupplySuggestMenu.jsx) (`supply_rate_suggestions`: с 20261025 — то же наименование,
  затем самые похожие, затем новые; тендер № / объект / ВОР / день / тот же размер / документ — адрес или файл), «Взять» — `source_kind='pick'` + документ исходной позиции, если своего нет. Копия хранит
  `source_rate_id` / `source_tender_id` и **день исходной цены**, источником сама не служит (иначе старая цена
  «молодела» бы, переезжая из тендера в тендер); правка цены — уже своя (отметка снимается, день — сегодня). Подстановка
  внутри тендера переносит отметку копии и заменяет копии `auto` (своя цена тендера важнее чужой). Пометка в строке —
  `supply_rate_origins`. Реестр СУ-10 копии не показывает, его дата — день расценки. Функций/колонок нет — ничего этого
  нет, остальное работает (`reuseRpc` → null, `RATE_COLUMNS` без новых колонок). Стенд — `reuse=1`.
- **Дата цены и кто поставил** (20261023): колонка «Дата цены» (день расценки) и фильтр «Дата цены с … по …» в таблице
  (без цены — не попадает); администратору (`isAdmin` / `isSuperAdmin`) в той же колонке — кто поставил цену
  (`price_by`: свой ввод, импорт Excel, «Взять» — вошедший; сама подставленная — «автоматически», автор исходной — в
  подсказке; до 16.10.2026 журнала цен не было — «не записан»). `updated_by` — по-прежнему последний, кто менял строку
  (перенос ВОР тоже); прямой правкой колонок ни дату, ни автора не подменить (триггер держит прежние). Реестр СУ-10:
  дата — полночь по Москве, фильтр дат — по Москве (`moscowDayStart` / `moscowDayEnd` в `utils/ratesRegistry.js`).
- **Позиции ВОР — заранее, на сервере** (20261024, `OSP_SUPPLY_IMPORT=1`, [supplyImport.js](server/osp-api/src/lib/supplyImport.js)):
  раз в 10 минут служба osp-api делает то же, что автозагрузка страницы, для всех основных тендеров с тендером на
  материалы — одним кодом (`parseVorFileBytes` в `vorMaterialsSheet.js`, копии `src/utils` в `server/osp-api/src/shared`,
  `node scripts/sync-osp-api-shared.mjs`; расхождение роняет `tests/osp-api/shared-sync.test.mjs`). Итог —
  `tender_supply_import_state` (`ok` | `no_vor` | `issues` | `locked` | `pending` + причины): реестр тендеров на
  материалы показывает «Расценка: N из M» / «ВОР не загрузился» (причины — в подсказке) / «нет ВОР» / «загружается» без
  открытия расценки, а страница не скачивает файл, который служба не смогла разобрать (`serverFailure`), и без права
  правки показывает эти причины. Разбор — в отдельном процессе (192 МБ, низкий приоритет, таймаут 2 мин: у osp-api
  384 МБ / 0,45 CPU), за проход ≤ 40 файлов и 6 минут, файл > 25 МБ не скачивается (его разберёт страница); неразборный,
  тяжёлый, отсутствующий в хранилище файл и список > 20 000 позиций — не повторяются до новой версии файла или разбора;
  повторный проход без изменений ничего не пишет. Замер на копии прода 15.10: первый проход 2,8 с (347 тендеров, 144
  списка из вкладок «ВОР»), следующие — 0,4 с; книга 19 МБ разбирается за 0,5 с, лист ВОР на 40 тыс. строк — 3,5 с.
  Тест — `tests/supply/server-import.test.mjs`; стенд UI — `importStates=1`, `serverIssue=1`.
- **Ввод цены ИЛИ суммы; расчёт — в базе** (триггер `tender_vor_supply_rates_compute`): страница пишет `price_input`
  (`unit`|`total`), `input_value`, `volume_at_input`; база считает `supply_price` (копейки), `supply_price_exact` (сумма /
  объём) и `supply_total`. Запись только `supply_price` (импорт Excel, старая вкладка) → `price_input='import'`, точная
  цена сбрасывается. Во фронте цену для сумм брать через `rateUnitPrice(r)` ([supplyRateHelpers.js](src/utils/supplyRateHelpers.js)).
- **Права — в базе:** читать — сотрудник; писать — `supply_can_edit()` = правка «Тендеров» или «Тендеров на материалы».
  Тендер на материалы «Завершён» — расценки и позиции только для чтения (триггер `tender_supply_guard`; «Не требуется» не
  закрывает; каскад удаления тендера проходит).
- **Сохранение — само:** через секунду после ввода, при уходе из поля и при закрытии вкладки ([SupplyMoneyCell](src/components/supply/SupplyMoneyCell.jsx));
  пишется только набранное — проход по полю Tab ничего не пишет. Сохранённая цена — зелёная галочка в строке (остаётся),
  над таблицей — «Все цены сохранены» / «Сохраняем…» / «Не сохранено: N» (строка постоянной высоты, без плашек).
- **Параллельная правка:** `row_version` в условии правки (0 строк / 23505 → окно «изменено другим», если в базе не то же
  самое значение). Последняя версия строки — в `ratesRef`, который обновляется в момент ответа, а не на отрисовке:
  очередь записей одной строки иначе писала со старой версией и показывала ложное «изменено другим». Чужие правки —
  опрос журнала `tender_supply_rate_log` раз в 20 с: перечитываются только строки из новых записей журнала
  (Realtime-публикацию не трогали). Черновики ввода — в `localStorage` до подтверждения сервером, повтор при сети и
  `OSP_READONLY`.
- **Загрузка:** тендер, затем всё остальное одновременно (`loadPricingBundle`); строки вкладки «ВОР» (у больших
  ВОР — десятки тысяч) таблица не ждёт, они грузятся фоном. В карточке таблица после первого открытия вкладки остаётся
  смонтированной (скрытая не опрашивает сервер), цены карточке отдаёт она (`onRatesChange`). Библиотека Excel (430 КБ) —
  только по требованию (разбор файла ВОР, выгрузка, «Указать лист и колонки»): сервис `supplyPricing.js` импортирует и
  реестр тендеров, поэтому статического `xlsx` в нём быть не должно (проверка имени файла — `utils/vorFiles.js`).
- **Длинные списки — только видимые строки** ([VirtualTableBody](src/components/VirtualTableBody.jsx)): таблица расценки
  от 150 строк (прокрутка внутри, шапка и итог закреплены), реестр «Тендеры на материалы» от 120 строк (режим `viewport`
  — по положению на экране, прокручивается `.main-content`; на телефоне — все строки). Раньше каждое сохранение
  заставляло браузер заново раскладывать и рисовать 2,3 тыс. строк, а 360 строк реестра (27 тыс. элементов) — секунды
  на открытие и подвисания при прокрутке. Тест — `tests/tender/large-lists.test.mjs` (стенд: `bigPricing=N`, `matTenders=1`).
- **Похожесть** (миграция 20261025, [supplySimilarity.js](src/utils/supplySimilarity.js) = `supply_name_stems` /
  `supply_name_nums` / `supply_name_score` в базе; совпадение сторожит `tests/supply/similarity.test.mjs`). Прежняя
  (общие слова и числа одной кучей) на копии прода 15.10 давала до ~150 «похожих» на позицию — клапаны одной серии всех
  размеров (22,9 тыс. пар на 1,1 тыс. цен); новая — 459 пар, до 18 на позицию, и это тот же материал в другой записи.
  Слова — по основе (окончания), сокращение — по началу не короче 4 букв, двухбуквенные обозначения — слова; размер
  «700x700» («700 х 700», «400x300» = «300x400») — одно число с весом 2; ГОСТ / ТУ и «мм2», «м3/ч» не считаются;
  итог 0,4 × слова + 0,6 × числа (у обоих свои числа вместо общих — штраф; чисел нет у одного — слова × 0,8). Похожие:
  слова ≥ 0,6 и итог ≥ 0,75; сопоставление документа поставщика — ≥ 0,5 и ≥ 0,6. Кандидаты в базе — GIN по
  `name_heads` (первые 4 буквы основ), оценка — plpgsql-циклом (в 20 раз быстрее подзапросов): 200 позиций — 0,3–0,6 с
  на копии прода. Меняете расчёт — меняйте обе стороны (новой миграцией) и пересчитайте колонки.
- Ключ `material_key` / `positions[].k` = `supply_norm_name()` — порт `normName` на SQL; совпадение сторожит
  `tests/supply/norm-name.test.mjs`. Меняете `normName` — меняйте и функцию (новой миграцией) и пересчитайте колонку.
- **Сметный отдел обновил ВОР — версии ВОР** (миграция 20261029, решения пользователя 21.10: цену переносить только при
  полном совпадении наименования, остальное спрашивать, уведомлять, подсвечивать, старые расценки сохранять). Цены не
  удаляются ничем, кроме решения человека; у позиции с тем же ключом наименования (`material_key`) в том же ВОР цена
  остаётся сама (та же строка). Триггер `tender_supply_sources_revision` пишет версию в `tender_supply_revisions`, когда файл
  ВОР заменён (в том числе удалённый — новым), позиции стали из файла вместо вкладки, вкладка «ВОР» перезагружена (подпись
  без `vor`/`vor2`), файл удалён (`removed`) или в расценённом тендере добавлен ВОР (`added`); не версия — тот же файл
  другим листом / колонками, перенос ВОР (версии переходят), смена разбора. В версии — что изменилось (новые, убранные,
  объём, ед. изм. в едином виде `kp_norm_unit`) с ценой позиции и снимок всех цен ВОР. Без цен в тендере, без изменений в
  материалах и у завершённой расценки — сразу «просмотрено». Страница ([supplyVorVersions.js](src/utils/supplyVorVersions.js)):
  шапка ВОР и плашка «Сметный отдел обновил ВОР», в строках «новая позиция», «было …» у объёма и ед. изм., фильтр «Изменения
  ВОР», «изменения просмотрены», окно «Версии ВОР» ([SupplyVersionsDialog](src/components/supply/SupplyVersionsDialog.jsx):
  что изменилось и цены до изменения, выгрузка в Excel). **Спрашиваем:** файл с другим именем (`ВОР ОВ изм.1.xlsx`) —
  новая версия прежнего ВОР или отдельный ВОР (`versionQuestions`: прежний с ценами или документами, его файл удалён или
  позиции из вкладки — хоть одно совпадение; оба файла на месте — совпадение ≥ половины с обеих сторон); «да» — окно с
  последствиями и `supply_vor_adopt` (прежний ВОР получает файл и позиции, имя ВОР то же — «Сравнение КП» не теряет цены;
  подставленная из другого тендера цена нового ВОР уступает своей, введённая — заменяет прежнюю), «нет» —
  `separate_at`; пока вопрос открыт, подстановка из других тендеров ждёт. Цена убранной позиции — «похоже на убранную …
  перенести цену / не то» у похожей позиции без своей цены и «перенести на позицию ВОР…» в «Ценах без позиции»
  (`supply_rate_carry`: та же строка цены — день расценки и история прежние, документ — следом). Цена за другую ед. изм.
  (`unitMismatch`, «м» = «пог. м») — «цена верна за …» (меняет только ед. изм. цены). Прежние файлы ВОР —
  `tender_supply_sources.prior_document_ids`: автозагрузка (и служба osp-api) не заводит из старого файла отдельный ВОР.
  Реестр тендеров на материалы — «ВОР изменён» (подсказка — что случилось), уведомления — вкладка «Изменения ВОР» у тех,
  кто правит «Тендеры на материалы». Та же миграция чинит закрытие: файл ВОР завершённой расценки теперь удаляется
  (обнуление ссылки на файл — не правка расценки). Тесты: `tests/supply/versions-db.test.mjs`, `vor-versions.test.mjs`,
  в `supply-pricing.test.mjs` — стенд `vorChanges=1`, `vorQuestion=1`, `noVersions=1`.
- База Яндекса — `migration/yandex/20261020_supply_pricing.sql`, `20261022_supply_links.sql`,
  `20261023_supply_rate_reuse.sql`, `20261024_supply_import_state.sql`, `20261025_supply_docs_similarity.sql` и
  `20261029_supply_vor_versions.sql` (тела функций совпадают — `tests/supply/migrations.test.mjs`; реестр СУ-10 у Яндекса в
  `osp_private`); проверки для прода — `migration/backup/checks/20261020.sql` … `20261025.sql`, `20261029.sql`, откаты —
  `migration/rollback/*_rollback.sql` тех же дат; база ссылок — `tests/supply/links-db.test.mjs`, цен из других
  тендеров — `tests/supply/reuse-db.test.mjs`, файлов и похожести — `tests/supply/docs-similarity-db.test.mjs`; разбор
  счетов / КП — `tests/supply/supplier-doc.test.mjs` (PDF печатает Chromium, читает pdf.js), окно распознавания — в
  `tests/tender/supply-pricing.test.mjs`.

## Договорные расценки (Larix) — четвёртая вкладка реестра расценок (миграции 20261018, 20261021)

Вкладка «Договорные расценки (Larix)» на `/rates-registry` (после «Расценки от снабжения СУ-10»; заглушка
«ДП и ДС» оставлена). Источник — Larix.CPM, метод «ВОР по договорам» (`project_contract_boq`).

- **Загрузка — osp-api на сервере corp, раз в день** ([server/osp-api/src/lib/larixSync.js](server/osp-api/src/lib/larixSync.js),
  клиент — [larixClient.js](server/osp-api/src/lib/larixClient.js), раздел в `server/osp-api/README.md`). Когда пора,
  решает база (`larix_sync_begin`: после 05:00 Мск, раз в день, повтор через 30 минут); замена — одной транзакцией
  (`larix_sync_finish`). После переноса пишет только базу Яндекса (`LARIX_SYNC_TARGETS=db`); Supabase-вариант
  остался прежним (20261018, строка × вид) — цель `supabase` не включать.
- **Логин Larix — только в `secrets/osp-api.env` на сервере** (`LARIX_USERNAME` / `LARIX_PASSWORD`); в чат, git и
  браузер не попадает. Отдельной учётки в Supabase нет: запись в базу прежнего портала — служебным ключом и только
  функциями `larix_sync_*` (EXECUTE только `service_role`, не SECURITY DEFINER).
- **Защита данных:** пустой ответ или падение ниже 30 % прежнего числа позиций — `held`, расценки не меняются
  (принять — `deploy.sh larix sync --force`); сбой — `failed` с кодом причины, на вкладке понятное предупреждение.
- **Строка — позиция договора с обеими ценами** (материалов и работ; нет цены — «—»), подвкладки «Все позиции /
  Материалы / Работы» — фильтр по наличию цены (фильтр цены — по цене подвкладки, на «Все» — по любой из двух).
  **Повторы схлопываются при загрузке:** тот же договор, та же позиция и единица (без учёта регистра и пробелов), те
  же цены — одна строка, число повторов — `repeats`. Дата договора
  — по Москве (Larix отдаёт полночь Мск в UTC). Наш договор — по `contracts.document_link` вида
  `https://cpm.su10.larix.ru/contract/<contract_id>` (только однозначное совпадение); ссылка на карточку — при
  `canView('contracts')`, иначе на Larix. Колонка НДС появляется, если Larix отдаёт ставку (имена полей — `VAT_KEYS`).
- **Поиск по индексу, поэтому строки — в закрытой схеме.** У таблицы с правилами по строкам поиск подстрокой
  (`ILIKE`) по индексу не идёт: оператор не leakproof, PostgreSQL вычисляет его перебором после правила (на 83 тыс.
  строк — 120 мс на каждый из трёх запросов ввода против 2–7 мс по индексу). Поэтому данные — `osp_private.larix_rates`
  (без RLS; PostgREST видит только `public`), вкладка читает представление `larix_rates_registry` с правами владельца:
  условие «вошедший с правом раздела» — один раз на запрос, `ILIKE` — по `larix_rates_name_trgm`. Так же устроены КП и СУ-10.
  Не возвращать вкладку на таблицу с RLS и не делать представление `security_invoker`.
- **Права:** строки представления и журнал `larix_sync_runs` — `osp_can('rates_registry','view')` (строже, чем КП и
  СУ-10); запись через представление закрыта правилами `osp_readonly_*`; `larix_sync_stage` и закрытая таблица —
  только загрузка. Списки фильтров — `larix_sync_runs.filters` последней удачной загрузки.
- Фронт: [src/pages/LarixRegistrySection.jsx](src/pages/LarixRegistrySection.jsx); общие помощники всех вкладок реестра —
  [src/utils/ratesRegistry.js](src/utils/ratesRegistry.js). База Яндекса — `migration/yandex/20261018_larix_contract_rates.sql`
  (тексты функций совпадают с Supabase-вариантом — сторожит `tests/osp-api/larix-sync.test.mjs`) и
  `20261021_larix_rates_registry.sql` (закрытая таблица, представление, новая `larix_sync_finish`, перенос уже
  загруженного). Ручные команды на corp:
  `bash /opt/portals/osp/deploy.sh larix probe | sync [--force]`.

## ПСДЦ / ВОР (миграция 20260908)

Ведомость стоимости работ документа первого этапа (договор, ДС на изменение ВОР, ДС на доп. работы). Связь — `psdc.document_id` → `contracts.id`; в самом XLSX ID документа нет и не требуется.

- **Расчёт — только в базе** (`psdc_validate_internal`, NUMERIC, `round()` = Excel ROUND half-up на каждой строке). Браузер лишь читает XLSX и шлёт сырые ячейки. Не дублировать формулы на фронте.
- Процесс: `K = ROUND(ROUND(I,5)·ROUND(J,2),2)`, `M = ROUND(ROUND(I,5)·ROUND(L,2),2)`, `N = ROUND(J+L,2)`, `O = M` при `D = ДМ`, иначе `ROUND(K+M,2)`. Секция — агрегат процессов с № `«секция.»…` (текстовый префикс, 5.10 ∈ 5): `K` без ДМ, `M` со всеми работами. Итог — только из процессов. Скрытый `U = deleted` — строка не в расчёте; других статусов нет.
- **Жизненный цикл** `uploaded → validated|invalid → applied → deleted`, незавершённая загрузка → `cancelled`. Один `applied` на документ (уникальный индекс). Все изменения — SECURITY DEFINER RPC (`psdc_create/add_rows/validate/apply/cancel/delete`, пакет: `psdc_batch_*`), таблицы ПСДЦ клиенту только на чтение.
- **Сумма документа**: `contracts.psdc_total` (пишут только `psdc_apply`/`psdc_delete`, триггер `contracts_psdc_total_guard`). В JS — `effectiveDocumentAmount(doc)` в [contractAmendments.js](src/utils/contractAmendments.js); `effectiveValues`/`contractActualAmount` уже учитывают ПСДЦ. Ручная `contract_amount` не перезаписывается. Если грузите договоры для расчёта сумм — добавляйте `psdc_total` в select.
- **Статусы**: завершённое ДС (и договор, созданный после внедрения ПСДЦ) — сначала вернуть на доработку; старые завершённые договоры принимают первичную ПСДЦ. Правило — `psdc_document_lock_reason()`.
- **Предыдущая ПСДЦ** — ближайшая применённая вверх по родителям в той же ветке (`psdc_find_previous`); по ней сохраняются ID строк из столбца T.
- НДС — из документа (`psdc_document_vat`), подпись в файле только диагностика.
- Фронт: [src/utils/psdcWorkbook.js](src/utils/psdcWorkbook.js) (безопасное чтение XLSX, копия с подсветкой ошибок, экспорт с формулами, шаблон), [src/services/psdc.js](src/services/psdc.js), [src/components/psdc/PsdcPanel.jsx](src/components/psdc/PsdcPanel.jsx) (вкладка «ПСДЦ / ВОР» карточки), [src/pages/PsdcBatchPage.jsx](src/pages/PsdcBatchPage.jsx) (`/contracts/psdc-batch`), [src/utils/psdcMatching.js](src/utils/psdcMatching.js) (автосопоставление имён файлов).
- Исходные XLSX хранятся в S3 как `owner_type='general'`, `owner_id=psdc.id`, `doc_category='psdc_source'` (редеплой `s3-presign` не нужен).
- Предел — 25 000 строк на ведомость (проверка укладывается в `statement_timeout` Supabase).
- Старая таблица `contract_psdc_items` (float-расчёт) больше не используется интерфейсом.

**Тесты** (`npm run test:psdc`): поднимают временный локальный PostgreSQL 17+ (`initdb/pg_ctl/psql` в PATH или `PG_BIN`, иначе Docker) с настоящими миграциями 20260906 + 20260908, проверяют движок, XLSX, интеграцию с суммами и UI в Chrome/Edge через Playwright (`PSDC_BROWSER`). Замер: `npm run bench:psdc`.

## Пути документа в «Договорах и ДС»: папка, Signal, Larix.CPM (миграция 20261012)

У договора и ДС три пути, все вносятся в реестре под номером документа и показываются в карточке
(«Основная информация») только для чтения — второго места ввода нет:

| Путь | Колонка `contracts` | Компонент |
|---|---|---|
| к папке | `folder_path` | [FolderPathCell](src/components/FolderPathCell.jsx) — копируется (проводник кликом не открыть) |
| к Signal | `signal_link` | [SignalLinkCell](src/components/SignalLinkCell.jsx) |
| к Larix.CPM | `document_link` | [LarixLinkCell](src/components/LarixLinkCell.jsx) |

- Signal и Larix.CPM — одна основа [WebLinkCell](src/components/WebLinkCell.jsx): вид и ввод одинаковы.
- **«Внесён в Larix» отдельно не хранится** — выводится из заполненности пути: `isInLarix(doc)` в
  [contractLarix.js](src/utils/contractLarix.js). Имя поля и подписи — оттуда же (`LARIX_LINK_FIELD`,
  `LARIX_LINK_LABEL`). Колонки `larix_entered` / `larix_number` / `larix_entered_at` / `larix_entered_by`
  остались в базе, но интерфейс их не читает и не пишет — не возвращать (это проверяет `test:contracts`).
- В реестре заполненный путь — своя строка; пустые собраны в одну «путь к папке · Signal · Larix.CPM»
  (`.cpaths` в `ContractRegistryPolish.css`): три полные подписи не помещались, и каждая строка реестра
  вырастала на строку.
- Excel-импорт: колонка «Путь к Larix.CPM» (принимаются и прежний заголовок «Ссылка на документ», и «СРМ»
  кириллицей); в ней допустима только ссылка `http(s)` — путь к папке даёт ошибку строки.

## Excel Import/Export (xlsx)

Used in `TenderDetailPage.jsx`, `ContractorProposalsPage.jsx`, and BSM pages:

```javascript
import * as XLSX from 'xlsx'

// Import
const workbook = XLSX.read(arrayBuffer, { type: 'array' })
const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])

// Export
const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
XLSX.writeFile(wb, 'filename.xlsx')
```

**Estimate columns (tender import):** A=№ п/п, B=КОД, C=Наименование затрат, D=Ед. изм., E=Объем по виду работ, F=Общий расход

**Section detection:** Rows without code (Р or мат.) and without numeric data are automatically marked as sections (`is_section=true`). The `original_row_number` field preserves the original Excel row numbering. Sections display with highlighted styling as headers for groups of work items.

### Numeric Value Cleaning (BSMPage pattern)

Excel imports may contain formatted numbers with currency symbols and spaces. Use this pattern:
```javascript
const cleanNumericValue = (value) => {
  if (typeof value === 'number') return value
  let str = String(value)
  str = str.replace(/[₽$€¥£]/g, '')                    // Remove currency symbols
  str = str.replace(/[\s\u00A0\u2007\u202F]/g, '')     // Remove spaces (including non-breaking)
  str = str.replace(',', '.')                          // Decimal comma to dot
  str = str.replace(/[^\d.\-]/g, '')                   // Keep only digits, dot, minus
  return parseFloat(str) || 0
}
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

### Props-Based Filtering

`TendersPage` uses `department` prop ('construction' | 'warranty') for filtering by object status. The component maps this to `objectStatus`:
- `'construction'` → `'main_construction'`
- `'warranty'` → `'warranty_service'`

`ContractsPage` uses internal state selectors for department and status (pending/signed).

### Tab-Based Filtering

Pages with tab navigation filter fetched data in memory rather than re-fetching from Supabase. See TendersPage (`active`/`completed` tabs) for the pattern.

### Protected Routes

`EmployeeLayout` component in `App.jsx` wraps all employee routes. It checks `isLoggedIn` and `isEmployee` from RoleContext, redirecting unauthorized users to `/login` or `/contractor/proposals`.

### Multi-File Excel Accumulation (BSMPage)

BSMPage supports loading multiple Excel files that accumulate into a single analysis. Each parsed row tracks its `sourceFile` for per-file removal. Removing a file filters rows and recalculates the pivot.

### BSM Item Type Detection

Materials vs works are distinguished by КОД column:
- `Р` or starts with `Р-` → work (uses `priceWorks`)
- `мат.` or default → material (uses `priceMaterials`)

### BSM Expected Excel Format

BSMPage expects Excel files with this column structure:
| Column | Content |
|--------|---------|
| A | КОД — `Р` (work) or `мат.` (material) |
| B | Наименование |
| C | Ед. изм. |
| D | Объем |
| E | Цена материалов (с НДС) |
| F | Цена работ (с НДС) |

### ObjectDetailPage Tabs

Five tabs: Информация (object fields like dates, area, budget), Документы (hierarchical documents), Гарантия (warranty periods), Гарантийные удержания (retention percentages), Смета (ДГП — комплектный и полный единый ПСДЦ, см. «Routing»; ниже — estimate with materials/works pricing and VAT support).

**Гарантия (task 353):** каждая строка — отдельный вид работ. Начало гарантии бывает двух типов:
- **По дате** (`start_type='date'`) — обычный datepicker.
- **По событию** (`start_type='event'`) — текстовое описание (`start_event_text`, например «с даты подписания Акта о практическом завершении Работ (Акт № 3)»), опциональная привязка к документу из `object_documents` (`start_document_id`, FK с `ON DELETE SET NULL`) и опциональная фактическая дата начала (заполняется когда событие наступит).

Срок хранится в месяцах (`warranty_months`). Дата окончания вычисляется по приоритетам: (1) `end_date_override` если задан, (2) `start_date + warranty_months`, (3) для события без даты — плейсхолдер «после события + N мес.», (4) прочерк. Поле `notes` — отдельная колонка «Примечание» в таблице. Хелперы расчёта — `getWarrantyEndDisplay()` / `getWarrantyStartDisplay()` в [ObjectDetailPage.jsx](src/pages/ObjectDetailPage.jsx).

### Hierarchical Documents (ObjectDetailPage)

`object_documents` supports parent-child relationships via `parent_document_id` self-reference. Documents are grouped by type (general contracts → additional agreements/attachments as children). The UI uses expandable rows to show nested documents.

**S3-файлы (task 282):** к каждому документу можно прикрепить два файла — подписанный и редактируемый (`signed_s3_document_id` / `editable_s3_document_id`, FK на `s3_documents` с `ON DELETE SET NULL`). Записи в `s3_documents` создаются с `owner_type='object'`, `owner_id=object_id` — файлы лежат в одной папке `objects/{object_id}/` независимо от того, к какому документу/приложению относятся. UI-слот — [src/components/ObjectDocumentFileSlot.jsx](src/components/ObjectDocumentFileSlot.jsx). При удалении документа (включая каскадно удаляемые приложения) код в [ObjectDetailPage.jsx](src/pages/ObjectDetailPage.jsx) рекурсивно собирает все привязанные `s3_documents` и удаляет их через `deleteDocument()` до DELETE — иначе остаются orphan-файлы в S3. Старые поля `signed_link` / `editable_link` (Google Drive) deprecated, в UI не используются.

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
