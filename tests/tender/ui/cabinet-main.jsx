// Стенд кабинета подрядчика (данные в памяти, cabinet-seed.js): ?page=cabinet — кабинет «ООО Альфа»,
// ?page=admin — реестр расценок администратора на вкладке «Расценки подрядчиков (актуальные тендеры)».
import './cabinet-seed.js'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import ContractorCabinetPage from '../../../src/pages/ContractorCabinetPage'
import RatesRegistryPage from '../../../src/pages/RatesRegistryPage'

const page = new URLSearchParams(window.location.search).get('page') || 'cabinet'

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[page === 'admin' ? '/rates-registry?tab=bids' : '/contractor']}>
    <Routes>
      <Route path="/contractor" element={<ContractorCabinetPage />} />
      <Route path="/rates-registry" element={<RatesRegistryPage />} />
      <Route path="/partner" element={<div>Вход подрядчика</div>} />
    </Routes>
  </MemoryRouter>,
)
