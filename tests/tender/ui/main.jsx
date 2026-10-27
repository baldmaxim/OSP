// Стенд тендеров в браузере (данные в памяти).
//   route   — начальный адрес: /tenders/tender-1 (карточка, по умолчанию), /tenders/construction или
//             /tenders/materials (реестры), /reports (отчёты; kpStats=1 — файлы КП для статистики),
//             /general (разделы «Общей информации» и порталы компании), /public/tenders (страница без входа;
//             publicNoContact=1 — колонок ответственного ещё нет, как до миграции 20261101);
//             /general/departments (отделы; departments=missing — таблицы ещё нет), /tasks?task=task-1 (карточка
//             задачи с чек-листом; taskChecklist=N — ещё N пунктов, taskList=N — ещё N задач), /stand/dgp (блок ДГП вкладки «Смета» объекта), /reports&dcStats=1 (заявки на ДС),
//             /contracts&contracts=N (реестр «Договоры и ДС», понятийные соглашения),
//             /dc-requests&dcStats=1 (реестр заявок на ДС с файлами; dcNumbers=1 — номера заявок из базы, миграция 20261106;
//             dcSubmission=1 — столбцы «Статус ОКС» и «Комментарий», миграция 20261108;
//             dcContracts=1 — договор, ДС и подразделение заявок, миграция 20261109;
//             dcMany=N — ещё N заявок; dcOldFiles=N — ещё N старых файлов, с maxRows=1000 — потолок строк PostgREST;
//             /dc-requests?file=<id> — ссылка на файл из выгрузки в Excel),
//             /kp-review&kpReview=1 («Проверка КП»; kpReviewMany=N — длинный список, kpRole — роль, см. seed.js),
//             /cost-plans («Планы затрат», «Документы» → «Экономисты ОСП»);
//   items   — позиций ВОР (по умолчанию 5000, три документа, разделы),
//   cps     — подрядчиков с КП (по умолчанию 10),
//   tenders — тендеров в реестре (по умолчанию 40),
//   latency — задержка «сети» на запрос, мс;
//   cpContacts=1 — у контрагентов контакты с телефонами и один в чёрном списке;
//   shell=1 — страница внутри обвязки приложения (.layout / .main-content и полоса меню телефона):
//             на телефоне прокрутка зависит от неё, без обвязки стенд прокручивает окно.
//   callReminder=1 — показать вторничное напоминание об обзвоне (TenderCallReminder); без него оно
//             отмечено закрытым на эту неделю: во вторник окно открывалось поверх реестра и
//             перекрывало строки — тесты реестра падали раз в неделю.
// window.__navigate(путь) — переход между разделами без перезагрузки (данные в памяти сохраняются):
//             так проверяется, что правка в одном разделе видна в другом (/tenders/construction ↔ /vors).
import './seed.js'
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import '../../../src/mobile.css'
import TendersPage from '../../../src/pages/TendersPage'
import TenderDetailPage from '../../../src/pages/TenderDetailPage'
import CounterpartiesPage from '../../../src/pages/CounterpartiesPage'
import SupplyPricingPage from '../../../src/pages/SupplyPricingPage'
import VorsPage from '../../../src/pages/VorsPage'
import ReportsPage from '../../../src/pages/ReportsPage'
import GeneralInfoPage from '../../../src/pages/GeneralInfoPage'
import PublicTendersPage from '../../../src/pages/PublicTendersPage'
import DepartmentsPage from '../../../src/pages/DepartmentsPage'
import TasksPage from '../../../src/pages/TasksPage'
// Блок ДГП — только по требованию: стили карточки объекта (ObjectDetailPage.css) не должны задеть другие стенды.
const DgpStand = lazy(() => import('./dgp-stand.jsx'))
// Реестр договоров — так же: его стили (ContractRegistry*.css, MobileCards.css) глобальные.
const ContractsPage = lazy(() => import('../../../src/pages/ContractsPage'))
// «Проверка КП» — так же: стили страницы и рабочего слоя (workUi.css) не должны задеть другие стенды.
const KpReviewPage = lazy(() => import('../../../src/pages/KpReviewPage'))
// Реестр заявок на ДС — так же (DcRequestsPage.css, рабочий слой).
const DcRequestsPage = lazy(() => import('../../../src/pages/DcRequestsPage'))
// «Планы затрат» — так же (CostPlansPage.css, рабочий слой).
const CostPlansPage = lazy(() => import('../../../src/pages/CostPlansPage'))
import { weekKey } from '../../../src/utils/weeks'

const params = new URLSearchParams(window.location.search)
const route = params.get('route') || '/tenders/tender-1'

if (params.get('callReminder') !== '1') {
  try {
    for (const d of ['construction', 'all']) localStorage.setItem(`tenderCallReminder:${d}`, weekKey(new Date()))
  } catch { /* приватный режим */ }
}

function NavBridge() {
  window.__navigate = useNavigate()
  return null
}

const routes = (
  <Routes>
    <Route path="/vors" element={<VorsPage />} />
    <Route path="/reports" element={<ReportsPage />} />
    <Route path="/tenders/construction" element={<TendersPage department="construction" tenderType="main" />} />
    <Route path="/tenders/materials" element={<TendersPage key="tenders-materials" tenderType="materials" />} />
    <Route path="/general" element={<GeneralInfoPage />} />
    <Route path="/general/departments" element={<DepartmentsPage />} />
    <Route path="/tasks" element={<TasksPage />} />
    <Route path="/stand/dgp" element={<Suspense fallback={null}><DgpStand /></Suspense>} />
    <Route path="/public/tenders" element={<PublicTendersPage />} />
    <Route path="/general/counterparties" element={<CounterpartiesPage />} />
    <Route path="/contracts" element={<Suspense fallback={null}><ContractsPage /></Suspense>} />
    <Route path="/kp-review" element={<Suspense fallback={null}><KpReviewPage /></Suspense>} />
    <Route path="/dc-requests" element={<Suspense fallback={null}><DcRequestsPage /></Suspense>} />
    <Route path="/cost-plans" element={<Suspense fallback={null}><CostPlansPage /></Suspense>} />
    <Route path="/tenders/materials/:tenderId/pricing" element={<SupplyPricingPage />} />
    <Route path="/tenders/:tenderId" element={<TenderDetailPage />} />
  </Routes>
)

// Полоса меню телефона — того же размера, что .mobile-topbar (Sidebar.css): fixed, 52px.
const phoneTopbar = (
  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, zIndex: 1250, background: '#0f172a' }} />
)

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[route]}>
    <NavBridge />
    {params.get('shell') === '1' ? (
      <div className="layout">
        {window.matchMedia('(max-width: 768px)').matches && phoneTopbar}
        <main className="main-content">{routes}</main>
      </div>
    ) : routes}
  </MemoryRouter>,
)
