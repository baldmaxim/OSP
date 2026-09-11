// Стенд тендеров в браузере (данные в памяти).
//   route   — начальный адрес: /tenders/tender-1 (карточка, по умолчанию) или /tenders/construction (реестр);
//   items   — позиций ВОР (по умолчанию 5000, три документа, разделы),
//   cps     — подрядчиков с КП (по умолчанию 10),
//   tenders — тендеров в реестре (по умолчанию 40),
//   latency — задержка «сети» на запрос, мс.
import './seed.js'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import '../../../src/mobile.css'
import TendersPage from '../../../src/pages/TendersPage'
import TenderDetailPage from '../../../src/pages/TenderDetailPage'
import CounterpartiesPage from '../../../src/pages/CounterpartiesPage'

const params = new URLSearchParams(window.location.search)
const route = params.get('route') || '/tenders/tender-1'

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[route]}>
    <Routes>
      <Route path="/tenders/construction" element={<TendersPage department="construction" tenderType="main" />} />
      <Route path="/general/counterparties" element={<CounterpartiesPage />} />
      <Route path="/tenders/:tenderId" element={<TenderDetailPage />} />
    </Routes>
  </MemoryRouter>,
)
