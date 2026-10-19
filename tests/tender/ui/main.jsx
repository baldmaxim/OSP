// Стенд тендеров в браузере (данные в памяти).
//   route   — начальный адрес: /tenders/tender-1 (карточка, по умолчанию), /tenders/construction или
//             /tenders/materials (реестры);
//   items   — позиций ВОР (по умолчанию 5000, три документа, разделы),
//   cps     — подрядчиков с КП (по умолчанию 10),
//   tenders — тендеров в реестре (по умолчанию 40),
//   latency — задержка «сети» на запрос, мс;
//   cpContacts=1 — у контрагентов контакты с телефонами и один в чёрном списке;
//   shell=1 — страница внутри обвязки приложения (.layout / .main-content и полоса меню телефона):
//             на телефоне прокрутка зависит от неё, без обвязки стенд прокручивает окно.
// window.__navigate(путь) — переход между разделами без перезагрузки (данные в памяти сохраняются):
//             так проверяется, что правка в одном разделе видна в другом (/tenders/construction ↔ /vors).
import './seed.js'
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

const params = new URLSearchParams(window.location.search)
const route = params.get('route') || '/tenders/tender-1'

function NavBridge() {
  window.__navigate = useNavigate()
  return null
}

const routes = (
  <Routes>
    <Route path="/vors" element={<VorsPage />} />
    <Route path="/tenders/construction" element={<TendersPage department="construction" tenderType="main" />} />
    <Route path="/tenders/materials" element={<TendersPage key="tenders-materials" tenderType="materials" />} />
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
    <NavBridge />
    {params.get('shell') === '1' ? (
      <div className="layout">
        {window.matchMedia('(max-width: 768px)').matches && phoneTopbar}
        <main className="main-content">{routes}</main>
      </div>
    ) : routes}
  </MemoryRouter>,
)
