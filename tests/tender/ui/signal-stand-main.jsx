// Стенд «Signal»: карточка договора со строкой «Путь к Signal» и «Администрирование» → «Signal» (пакет P5b, 23.11.2026).
// Своя точка входа (signal-stand.html): данные — seed.js (?contracts=30), «сервер сверки» — signal-fake.js (P5a) и надстройки
// signal-card-fake.js (договоры ctr-16…ctr-29 с состояниями и деревом файлов) и signal-admin-fake.js (администрирование).
//   page=card (по умолчанию) — карточка договора /contracts/<contract> (по умолчанию ctr-16);
//   page=admin — страница «Администрирование» целиком (вкладка «Signal» — если сервер её отдаёт и вошёл администратор);
//   page=tab   — только вкладка «Signal» в обвязке страницы «Администрирование».
//   signal=1 включает сервер сверки (signal=off — выключен, signal=missing — маршрутов нет, signal=down — сбой), остальные
//   параметры — в шапках signal-fake.js, signal-card-fake.js и signal-admin-fake.js; canEdit=0 и asRole=… — fake-role.jsx.
import './seed.js'
import './signal-card-fake.js'
import './signal-admin-fake.js'
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/App.css'
import '../../../src/mobile.css'

const params = new URLSearchParams(window.location.search)
const page = params.get('page') || 'card'
const ContractDetailPage = lazy(() => import('../../../src/pages/ContractDetailPage'))
const AdminStand = lazy(() => import('./admin-stand.jsx'))
const SignalAdminStand = lazy(() => import('./signal-admin-stand.jsx'))

const start = page === 'card' ? `/contracts/${params.get('contract') || 'ctr-16'}` : `/${page}`

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[start]}>
    <Suspense fallback={null}>
      <Routes>
        <Route path="/contracts/:contractId" element={<ContractDetailPage />} />
        <Route path="/admin" element={<AdminStand />} />
        <Route path="/tab" element={<SignalAdminStand />} />
        <Route path="*" element={<div data-testid="stand-location">{start}</div>} />
      </Routes>
    </Suspense>
  </MemoryRouter>,
)
