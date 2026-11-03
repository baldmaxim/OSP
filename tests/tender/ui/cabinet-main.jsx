// Стенд кабинета подрядчика (данные в памяти, cabinet-seed.js): ?page=cabinet — кабинет «ООО Альфа»,
// ?page=admin — реестр расценок администратора на вкладке «Расценки подрядчиков (актуальные тендеры)»;
// ?page=signup&view=register|confirm|claim|forgot|reset — регистрация подрядчика (&closed=1 — закрыта);
// ?page=signups — «Регистрации подрядчиков» у администратора.
import './cabinet-seed.js'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import ContractorCabinetPage from '../../../src/pages/ContractorCabinetPage'
import RatesRegistryPage from '../../../src/pages/RatesRegistryPage'
import ContractorSignupPage from '../../../src/pages/ContractorSignupPage'
import ContractorSignupsTab from '../../../src/components/admin/ContractorSignupsTab'
import { setAuthMode } from '../../../src/api/authMode'

const params = new URLSearchParams(window.location.search)
const page = params.get('page') || 'cabinet'
if (page === 'signup') setAuthMode({ mode: 'own', ownLogin: true, signup: params.get('closed') !== '1' }, () => false)
const START = { admin: '/rates-registry?tab=bids', signup: '/signup', signups: '/signups' }

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[START[page] || '/contractor']}>
    <Routes>
      <Route path="/signup" element={<ContractorSignupPage view={params.get('view') || 'register'} />} />
      <Route path="/signups" element={<ContractorSignupsTab />} />
      <Route path="/contractor" element={<ContractorCabinetPage />} />
      <Route path="/rates-registry" element={<RatesRegistryPage />} />
      <Route path="/partner" element={<div>Вход подрядчика</div>} />
    </Routes>
  </MemoryRouter>,
)
