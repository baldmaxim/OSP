// Стенд карточки тендера: крупный тендер в памяти браузера.
//   items   — позиций ВОР (по умолчанию 5000, три документа, разделы),
//   cps     — подрядчиков с КП (по умолчанию 10),
//   latency — задержка «сети» на запрос, мс.
import './seed.js'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import TenderDetailPage from '../../../src/pages/TenderDetailPage'

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/tenders/tender-1']}>
    <Routes>
      <Route path="/tenders/:tenderId" element={<TenderDetailPage />} />
    </Routes>
  </MemoryRouter>,
)
