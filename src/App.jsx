import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { RoleProvider, useRole } from './contexts/RoleContext'
import { NotificationsProvider } from './contexts/NotificationsContext'
import { lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import AccessError from './components/AccessError'
import AccessDenied from './components/AccessDenied'
import UpdatePrompt from './components/UpdatePrompt'
import './App.css'
// Глобальный мобильный слой — импортируется последним, чтобы перебивать базовые
// правила при равной специфичности (модалки/формы/таблицы/шапки на всех страницах).
import './mobile.css'

// security fix: route-level гейт по конкретному праву раздела (canView). Самодостаточен
// (проверяет загрузку/ошибку/тип пользователя), поэтому при отсутствии права запрещённая
// страница вообще НЕ монтируется и не делает Supabase-запросов. Секции — те же ключи, что
// в Sidebar (canView('tenders') и т.д.) и в role_permissions.section: единый словарь прав.
function PermissionRoute({ section, anyOf, children }) {
  const { authLoading, roleError, isLoggedIn, isEmployee, canView } = useRole()
  if (authLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-tertiary)' }}>Загрузка...</div>
  }
  if (roleError) return <AccessError message={roleError} />
  if (!isLoggedIn) return <Navigate to="/login" replace />
  if (!isEmployee) return <Navigate to="/contractor/proposals" replace />
  if (anyOf && anyOf.length > 0 && !anyOf.some((s) => canView(s))) return <AccessDenied />
  if (section && !canView(section)) return <AccessDenied />
  return children
}

// Lazy load всех страниц — загружаются только при переходе
const ObjectsPage = lazy(() => import('./pages/ObjectsPage'))
const ObjectDetailPage = lazy(() => import('./pages/ObjectDetailPage'))
const ContactsPage = lazy(() => import('./pages/ContactsPage'))
const CounterpartiesPage = lazy(() => import('./pages/CounterpartiesPage'))
const TendersHubPage = lazy(() => import('./pages/TendersHubPage'))
const TendersPage = lazy(() => import('./pages/TendersPage'))
const TenderDetailPage = lazy(() => import('./pages/TenderDetailPage'))
const CostPlansPage = lazy(() => import('./pages/CostPlansPage'))
const VorsPage = lazy(() => import('./pages/VorsPage'))
const KpReviewPage = lazy(() => import('./pages/KpReviewPage'))
const SummaryPage = lazy(() => import('./pages/SummaryPage'))
const ContractsPage = lazy(() => import('./pages/ContractsPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const ContractorProposalsPage = lazy(() => import('./pages/ContractorProposalsPage'))
const ContractorNegotiationsPage = lazy(() => import('./pages/ContractorNegotiationsPage'))
const BSMPage = lazy(() => import('./pages/BSMPage'))
const GeneralInfoPage = lazy(() => import('./pages/GeneralInfoPage'))
const GeneralDocumentsPage = lazy(() => import('./pages/GeneralDocumentsPage'))
const TasksPage = lazy(() => import('./pages/TasksPage'))
const RatesRegistryPage = lazy(() => import('./pages/RatesRegistryPage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const ContractDetailPage = lazy(() => import('./pages/ContractDetailPage'))
const DcRequestsPage = lazy(() => import('./pages/DcRequestsPage'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'))
const PublicTendersPage = lazy(() => import('./pages/PublicTendersPage'))

const PageLoader = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh', color: 'var(--text-tertiary)' }}>
    Загрузка...
  </div>
)

// Компонент для защищённых маршрутов сотрудника
function EmployeeLayout() {
  const { isEmployee, isLoggedIn, authLoading, roleError } = useRole()

  if (authLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-tertiary)' }}>Загрузка...</div>
  }

  // security fix (fail-closed): ошибка загрузки роли/прав → экран ошибки, НЕ внутренние
  // страницы и НЕ admin. Раньше тут пользователь с непроверенной ролью мог получить доступ.
  if (roleError) return <AccessError message={roleError} />

  if (!isLoggedIn) return <Navigate to="/login" replace />
  if (!isEmployee) return <Navigate to="/contractor/proposals" replace />

  return (
    <NotificationsProvider>
    <div className="layout">
      <Sidebar />
      <main className="main-content">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Navigate to="/general" replace />} />
            {/* /notifications — доступен любому сотруднику; содержимое зависит от canView
                разделов (тендеры/договоры) внутри провайдера уведомлений. */}
            <Route path="/notifications" element={<PermissionRoute><NotificationsPage /></PermissionRoute>} />
            {/* /general — навигационный хаб; внутри карточки гейтятся по canView.
                Доступен сотруднику, у которого есть право хотя бы на один из разделов хаба. */}
            <Route path="/general" element={<GeneralInfoPage />} />
            <Route path="/general/objects" element={<PermissionRoute section="objects"><ObjectsPage /></PermissionRoute>} />
            <Route path="/general/objects/:objectId" element={<PermissionRoute section="objects"><ObjectDetailPage /></PermissionRoute>} />
            <Route path="/general/contacts" element={<PermissionRoute section="contacts"><ContactsPage /></PermissionRoute>} />
            <Route path="/general/counterparties" element={<PermissionRoute section="counterparties"><CounterpartiesPage /></PermissionRoute>} />
            <Route path="/general/documents" element={<PermissionRoute section="general_documents"><GeneralDocumentsPage /></PermissionRoute>} />
            {/* task 433: карточка задачи открывается query-параметром ?task=<id>,
                отдельного маршрута для неё нет — ссылка из уведомления ведёт сюда. */}
            <Route path="/tasks" element={<PermissionRoute section="tasks"><TasksPage /></PermissionRoute>} />
            <Route path="/tenders" element={<PermissionRoute section="tenders"><TendersHubPage /></PermissionRoute>} />
            <Route path="/tenders/construction" element={<PermissionRoute section="tenders"><TendersPage department="construction" tenderType="main" /></PermissionRoute>} />
            <Route path="/tenders/warranty" element={<PermissionRoute section="tenders"><TendersPage department="warranty" tenderType="main" /></PermissionRoute>} />
            <Route path="/tenders/materials" element={<PermissionRoute section="tenders"><TendersPage tenderType="materials" /></PermissionRoute>} />
            <Route path="/tenders/:tenderId" element={<PermissionRoute section="tenders"><TenderDetailPage /></PermissionRoute>} />
            <Route path="/cost-plans" element={<PermissionRoute section="tenders"><CostPlansPage /></PermissionRoute>} />
            <Route path="/vors" element={<PermissionRoute section="tenders"><VorsPage /></PermissionRoute>} />
            <Route path="/kp-review" element={<PermissionRoute section="tenders"><KpReviewPage /></PermissionRoute>} />
            <Route path="/summary" element={<PermissionRoute section="tenders"><SummaryPage /></PermissionRoute>} />
            <Route path="/analysis-kp" element={<PermissionRoute section="analysis_kp"><BSMPage /></PermissionRoute>} />
            <Route path="/contracts" element={<PermissionRoute section="contracts"><ContractsPage /></PermissionRoute>} />
            <Route path="/contracts/:contractId" element={<PermissionRoute section="contracts"><ContractDetailPage /></PermissionRoute>} />
            <Route path="/dc-requests" element={<PermissionRoute section="dc_requests"><DcRequestsPage /></PermissionRoute>} />
            {/* /profile — без отдельной секции в role_permissions: доступен любому
                сотруднику. PermissionRoute без section всё равно гейтит загрузку/ошибку
                роли/тип пользователя. */}
            <Route path="/rates-registry" element={<PermissionRoute section="rates_registry"><RatesRegistryPage /></PermissionRoute>} />
            <Route path="/reports" element={<PermissionRoute section="reports"><ReportsPage /></PermissionRoute>} />
            <Route path="/admin" element={<PermissionRoute section="admin"><AdminPage /></PermissionRoute>} />
            <Route path="/profile" element={<PermissionRoute><ProfilePage /></PermissionRoute>} />
            <Route path="*" element={<Navigate to="/general" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
    </NotificationsProvider>
  )
}

function AuthRoutes() {
  const { isLoggedIn, isEmployee, isContractor, authLoading } = useRole()

  if (authLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-tertiary)' }}>Загрузка...</div>
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Публичная страница тендеров — доступна без авторизации */}
        <Route path="/public/tenders" element={<PublicTendersPage />} />
        {/* Вход для сотрудников */}
        <Route
          path="/login"
          element={
            isLoggedIn
              ? <Navigate to={isEmployee ? "/general" : "/contractor/proposals"} replace />
              : <LoginPage variant="employee" />
          }
        />
        {/* Вход для подрядчиков (отдельная ссылка) */}
        <Route
          path="/partner"
          element={
            isLoggedIn
              ? <Navigate to={isEmployee ? "/general" : "/contractor/proposals"} replace />
              : <LoginPage variant="contractor" />
          }
        />
        <Route
          path="/contractor/proposals"
          element={
            isContractor
              ? <ContractorProposalsPage />
              : <Navigate to="/partner" replace />
          }
        />
        <Route
          path="/contractor/negotiations"
          element={
            isContractor
              ? <ContractorNegotiationsPage />
              : <Navigate to="/partner" replace />
          }
        />
        <Route path="/*" element={<EmployeeLayout />} />
      </Routes>
    </Suspense>
  )
}

function App() {
  return (
    <ThemeProvider>
      <RoleProvider>
        <BrowserRouter>
          <AuthRoutes />
        </BrowserRouter>
      </RoleProvider>
      {/* Попап «доступна новая версия» — на всех маршрутах, вне роутера (fixed). */}
      <UpdatePrompt />
    </ThemeProvider>
  )
}

export default App
