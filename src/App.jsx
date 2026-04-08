import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { RoleProvider, useRole } from './contexts/RoleContext'
import Sidebar from './components/Sidebar'
import ObjectsPage from './pages/ObjectsPage'
import ObjectDetailPage from './pages/ObjectDetailPage'
import ContactsPage from './pages/ContactsPage'
import CounterpartiesPage from './pages/CounterpartiesPage'
import TendersPage from './pages/TendersPage'
import TenderDetailPage from './pages/TenderDetailPage'
import ContractsPage from './pages/ContractsPage'
import AcceptancePage from './pages/AcceptancePage'
import ReportsPage from './pages/ReportsPage'
import LoginPage from './pages/LoginPage'
import ContractorProposalsPage from './pages/ContractorProposalsPage'
import BSMPage from './pages/BSMPage'
import BSMRatesPage from './pages/BSMRatesPage'
import BSMContractRatesPage from './pages/BSMContractRatesPage'
import BSMComparisonPage from './pages/BSMComparisonPage'
import BSMContractorRatesPage from './pages/BSMContractorRatesPage'
import GeneralInfoPage from './pages/GeneralInfoPage'
import BSMSelectionPage from './pages/BSMSelectionPage'
import AdminPage from './pages/AdminPage'
import ProfilePage from './pages/ProfilePage'
import './App.css'

// Компонент для защищённых маршрутов сотрудника
function EmployeeLayout() {
  const { isEmployee, isLoggedIn, authLoading } = useRole()

  // Ждём загрузку сессии
  if (authLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-tertiary)' }}>Загрузка...</div>
  }

  // Если не авторизован - редирект на логин
  if (!isLoggedIn) {
    return <Navigate to="/login" replace />
  }

  // Если подрядчик - редирект на его страницу
  if (!isEmployee) {
    return <Navigate to="/contractor/proposals" replace />
  }

  return (
    <div className="layout">
      <Sidebar />
      <main className="main-content">
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
      </main>
    </div>
  )
}

// Компонент для маршрутов авторизации
function AuthRoutes() {
  const { isLoggedIn, isEmployee, isContractor, authLoading } = useRole()

  if (authLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-tertiary)' }}>Загрузка...</div>
  }

  return (
    <Routes>
      {/* Страница входа */}
      <Route
        path="/login"
        element={
          isLoggedIn
            ? <Navigate to={isEmployee ? "/general" : "/contractor/proposals"} replace />
            : <LoginPage />
        }
      />

      {/* Страница подрядчика */}
      <Route
        path="/contractor/proposals"
        element={
          isContractor
            ? <ContractorProposalsPage />
            : <Navigate to="/login" replace />
        }
      />

      {/* Все остальные маршруты - для сотрудников */}
      <Route path="/*" element={<EmployeeLayout />} />
    </Routes>
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
