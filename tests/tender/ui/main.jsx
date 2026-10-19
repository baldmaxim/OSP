// Стенд тендеров в браузере (данные в памяти).
//   route   — начальный адрес: /tenders/tender-1 (карточка, по умолчанию) или /tenders/construction (реестр);
//   items   — позиций ВОР (по умолчанию 5000, три документа, разделы),
//   cps     — подрядчиков с КП (по умолчанию 10),
//   tenders — тендеров в реестре (по умолчанию 40),
//   latency — задержка «сети» на запрос, мс;
//   cpContacts=1 — у контрагентов контакты с телефонами и один в чёрном списке;
//   shell=1 — страница внутри обвязки приложения (.layout / .main-content и полоса меню телефона):
//             на телефоне прокрутка зависит от неё, без обвязки стенд прокручивает окно.
import './seed.js'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import '../../../src/mobile.css'
import TendersPage from '../../../src/pages/TendersPage'
import TenderDetailPage from '../../../src/pages/TenderDetailPage'
import CounterpartiesPage from '../../../src/pages/CounterpartiesPage'
import SupplyPricingPage from '../../../src/pages/SupplyPricingPage'

const params = new URLSearchParams(window.location.search)
const route = params.get('route') || '/tenders/tender-1'

const routes = (
  <Routes>
    <Route path="/tenders/construction" element={<TendersPage department="construction" tenderType="main" />} />
    <Route path="/general/counterparties" element={<CounterpartiesPage />} />
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
    {params.get('shell') === '1' ? (
      <div className="layout">
        {window.matchMedia('(max-width: 768px)').matches && phoneTopbar}
        <main className="main-content">{routes}</main>
      </div>
    ) : routes}
  </MemoryRouter>,
)
