// Стенд кабинета подрядчика (данные в памяти, cabinet-seed.js): ?page=cabinet — кабинет «ООО Альфа»,
// ?page=admin — «Расценки подрядчиков» администратора.
import './cabinet-seed.js'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import ContractorCabinetPage from '../../../src/pages/ContractorCabinetPage'
import ContractorBidsPage from '../../../src/pages/ContractorBidsPage'

const page = new URLSearchParams(window.location.search).get('page') || 'cabinet'

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[page === 'admin' ? '/contractor-bids' : '/contractor']}>
    <Routes>
      <Route path="/contractor" element={<ContractorCabinetPage />} />
      <Route path="/contractor-bids" element={<ContractorBidsPage />} />
      <Route path="/partner" element={<div>Вход подрядчика</div>} />
    </Routes>
  </MemoryRouter>,
)
