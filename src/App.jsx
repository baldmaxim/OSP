import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { RoleProvider, useRole } from './contexts/RoleContext'
import { lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import './App.css'

// Lazy load всех страниц — загружаются только при переходе
const ObjectsPage = lazy(() => import('./pages/ObjectsPage'))
const ObjectDetailPage = lazy(() => import('./pages/ObjectDetailPage'))
const ContactsPage = lazy(() => import('./pages/ContactsPage'))
const CounterpartiesPage = lazy(() => import('./pages/CounterpartiesPage'))
const TendersPage = lazy(() => import('./pages/TendersPage'))
const TenderDetailPage = lazy(() => import('./pages/TenderDetailPage'))
const ContractsPage = lazy(() => import('./pages/ContractsPage'))
const AcceptancePage = lazy(() => import('./pages/AcceptancePage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const ContractorProposalsPage = lazy(() => import('./pages/ContractorProposalsPage'))
const BSMPage = lazy(() => import('./pages/BSMPage'))
const BSMRatesPage = lazy(() => import('./pages/BSMRatesPage'))
const BSMContractRatesPage = lazy(() => import('./pages/BSMContractRatesPage'))
const BSMComparisonPage = lazy(() => import('./pages/BSMComparisonPage'))
const BSMContractorRatesPage = lazy(() => import('./pages/BSMContractorRatesPage'))
const GeneralInfoPage = lazy(() => import('./pages/GeneralInfoPage'))
const BSMSelectionPage = lazy(() => import('./pages/BSMSelectionPage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const ContractDetailPage = lazy(() => import('./pages/ContractDetailPage'))

const PageLoader = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '50vh', color: 'var(--text-tertiary)' }}>
    Загрузка...
  </div>
)

// Компонент для защищённых маршрутов сотрудника
function EmployeeLayout() {
  const { isEmployee, isLoggedIn, authLoading } = useRole()

  if (authLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-tertiary)' }}>Загрузка...</div>
  }

  if (!isLoggedIn) return <Navigate to="/login" replace />
  if (!isEmployee) return <Navigate to="/contractor/proposals" replace />

  return (
    <div className="layout">
      <Sidebar />
      <main className="main-content">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Navigate to="/general" replace />} />
            <Route path="/general" element={<GeneralInfoPage />} />
            <Route path="/general/objects" element={<ObjectsPage />} />
            <Route path="/general/objects/:objectId" element={<ObjectDetailPage />} />
            <Route path="/general/contacts" element={<ContactsPage />} />
            <Route path="/general/counterparties" element={<CounterpartiesPage />} />
            <Route path="/tenders" element={<Navigate to="/tenders/construction" replace />} />
            <Route path="/tenders/construction" element={<TendersPage department="construction" />} />
            <Route path="/tenders/warranty" element={<TendersPage department="warranty" />} />
            <Route path="/tenders/:tenderId" element={<TenderDetailPage />} />
            <Route path="/analysis-kp" element={<BSMPage />} />
            <Route path="/contracts" element={<ContractsPage />} />
            <Route path="/contracts/:contractId" element={<ContractDetailPage />} />
            <Route path="/bsm" element={<BSMSelectionPage />} />
            <Route path="/bsm/comparison" element={<BSMComparisonPage />} />
            <Route path="/bsm/contract-rates" element={<BSMContractRatesPage />} />
            <Route path="/bsm/supply-rates" element={<BSMRatesPage />} />
            <Route path="/bsm/contractor-rates" element={<BSMContractorRatesPage />} />
            <Route path="/acceptance" element={<AcceptancePage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="/general" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
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
        <Route
          path="/login"
          element={
            isLoggedIn
              ? <Navigate to={isEmployee ? "/general" : "/contractor/proposals"} replace />
              : <LoginPage />
          }
        />
        <Route
          path="/contractor/proposals"
          element={
            isContractor
              ? <ContractorProposalsPage />
              : <Navigate to="/login" replace />
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
    </ThemeProvider>
  )
}

export default App
