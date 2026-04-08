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
| `bsm_contract_rates` | Agreed material rates | `object_id` (CASCADE) |
| `bsm_supply_rates` | Supply dept rates (has `applied_at` date) | `object_id` (CASCADE) |
| `bsm_contractor_rates` | Contractor-specific rates | `object_id`, `counterparty_id` (CASCADE) |
| `object_documents` | Object documents (contracts, agreements, attachments) | `object_id`, `parent_document_id` (CASCADE) |
| `object_cost_plan` | Cost plan items per object | `object_id` (CASCADE) |
| `object_estimate_items` | Object estimate line items (imported from Excel) | `object_id` (CASCADE) |
| `object_warranties` | Warranty periods per object (start date + duration in months) | `object_id` (CASCADE) |
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

### Hierarchical Documents (ObjectDetailPage)

`object_documents` supports parent-child relationships via `parent_document_id` self-reference. Documents are grouped by type (general contracts → additional agreements/attachments as children). The UI uses expandable rows to show nested documents.

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
