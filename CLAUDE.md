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
```

**Note:** No test framework configured. Project relies on ESLint and manual testing.

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
└── supabase/
    ├── index.js          # Re-exports supabase client
    ├── client.js         # Supabase client init
    └── hooks.js          # Auth hooks (unused - roles via localStorage)

supabase/                 # Database schemas (NOT in src/)
├── schemas/              # Table definitions (preferred for reading)
└── migrations/           # Chronological schema changes
```

### Data Flow Pattern

No centralized state management. Each page:
1. Fetches data in `useEffect` on mount
2. Manages local state with `useState`
3. Calls Supabase directly for mutations
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
- `/contractor/proposals` - Contractor portal
- `/general` - General info hub (GeneralInfoPage)
- `/general/objects|contacts|counterparties` - General info subpages (employees)
- `/general/objects/:objectId` - Object detail (5 tabs: info, documents, warranty, warranty retentions, estimate)
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
- `/reports` - Reports page (placeholder)

### Theming

```javascript
import { useTheme } from './contexts/ThemeContext'
const { theme, toggleTheme } = useTheme()
```

CSS variables defined for `[data-theme="light"]` and `[data-theme="dark"]` in `index.css`.

## Supabase Integration

### Client Usage

```javascript
// From pages/ directory:
import { supabase } from '../supabase'

// Fetch with joins
const { data } = await supabase
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
| `counterparties` | Contractor directory | - |
| `counterparty_contacts` | Contact persons | `counterparty_id` (CASCADE) |
| `contracts` | Contract registry | `object_id`, `counterparty_id` |
| `tenders` | Tender management | `object_id`, `winner_counterparty_id`, `responsible_contact_id` |
| `tender_counterparties` | Tender participants | `tender_id`, `counterparty_id` (CASCADE) |
| `tender_estimate_items` | Estimate line items | `tender_id` (CASCADE) |
| `tender_counterparty_proposals` | Price proposals | `estimate_item_id`, `counterparty_id` |
| `tender_documents` | Tender attachments (Google Drive links) | `tender_id` (CASCADE) |
| `tender_proposal_files` | Uploaded Excel КП files from contractors | `tender_id`, `counterparty_id` (CASCADE) |
| `tender_vor_supply_rates` | Расценки от снабжения по материалам ВОР тендера (task 398). Привязка к документу-ВОР через `estimate_name`; сопоставление с позициями по `material_name`. Стоимость = `material_consumption × supply_price`. | `tender_id` (CASCADE), `UNIQUE(tender_id, estimate_name, material_name)` |
| `bsm_contract_rates` | Agreed material rates | `object_id` (CASCADE) |
| `bsm_supply_rates` | Supply dept rates (has `applied_at` date) | `object_id` (CASCADE) |
| `bsm_contractor_rates` | Contractor-specific rates | `object_id`, `counterparty_id` (CASCADE) |
| `object_documents` | Object documents (contracts, agreements, attachments). Files via S3 (`signed_s3_document_id`, `editable_s3_document_id` → `s3_documents`, ON DELETE SET NULL). | `object_id`, `parent_document_id` (CASCADE), `signed_s3_document_id`, `editable_s3_document_id` (SET NULL) |
| `object_cost_plan` | Cost plan items per object | `object_id` (CASCADE) |
| `object_estimate_items` | Object estimate line items (imported from Excel) | `object_id` (CASCADE) |
| `object_warranties` | Warranty periods per object — поддерживает начало по дате ИЛИ по событию (`start_type`, `start_event_text`), привязку к документу-акту (`start_document_id`), фиксированную дату окончания `end_date_override` и `notes` | `object_id` (CASCADE), `start_document_id` (SET NULL) |
| `object_warranty_retentions` | Warranty retention terms (percentage + period) | `object_id` (CASCADE) |

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

## S3 Document Storage (cloud.ru)

Task 277. Универсальное хранение файлов в S3-совместимом хранилище cloud.ru (bucket `osp`). Архитектура: браузер → Supabase Edge Function `s3-presign` → presigned URL → cloud.ru. Секреты живут только на стороне Edge Function, в браузер не попадают.

### Components

- Таблица `s3_documents` — единая для всех разделов. Привязка через `(owner_type, owner_id)`. Поддерживаемые типы: `'tender'`, `'contract'`, `'object'`, `'customer'`, `'general'` (расширяется в `FOLDER_BY_OWNER` в edge-функции).
- Edge Function `supabase/functions/s3-presign/index.ts` — операции `upload` / `download` / `delete`. Требует Authorization (Supabase JWT).
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
      "https://osp.root.sx"
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
| **AllowedOrigins** | `http://localhost:5173`, `http://osp.root.sx`, `https://osp.root.sx` | dev-сервер Vite + прод-домен в обеих схемах (HTTP/HTTPS), чтобы CORS не сломался при переходе на TLS. |
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

1. Добавить ключ в `FOLDER_BY_OWNER` в [supabase/functions/s3-presign/index.ts](supabase/functions/s3-presign/index.ts).
2. Передавать новый `ownerType` в `<S3DocumentList>`.
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

**Права.** У материализованного представления нет RLS и не работает `security_invoker` — оно читается напрямую. Грант выдан **только `authenticated`**, у `anon` отозван явно. При правке этих объектов не возвращайте `grant ... to anon`: это откроет анонимам цены подрядчиков.

**Обновление.** `refresh_rates_registry()` (security definer) делает `REFRESH MATERIALIZED VIEW CONCURRENTLY` обоих MV и пишет отметку в `app_settings('rates_registry_refreshed_at')`. Запускается расписанием pg_cron каждые 10 минут и кнопкой «Обновить» на странице (`supabase.rpc('refresh_rates_registry')`).

**Требуется включить pg_cron** в Supabase → Database → Extensions. Если расширение недоступно, миграция не падает — просто не создаётся расписание, и реестр обновляется только кнопкой.

Если менять SQL реестра — править нужно **тело MV** в миграции, а не вью-обёртку. После правки обязательно `REFRESH`.

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

Each page handles its own CRUD operations directly with Supabase. Pattern:
1. `useState` for data, loading, editing state
2. `useEffect` to fetch on mount
3. Form handling with local state
4. Direct Supabase calls for mutations

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

Five tabs: Информация (object fields like dates, area, budget), Документы (hierarchical documents), Гарантия (warranty periods), Гарантийные удержания (retention percentages), Смета (estimate with materials/works pricing and VAT support).

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
