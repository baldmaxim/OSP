// Точка входа стенда: тот же TendersPage, что и в приложении, но без Supabase,
// прав и сайдбара. Вариант (old/cur/new) подставляет сборщик — алиас @variant
// указывает на src нужной ревизии (см. build.mjs).
//
// Параметры адреса:
//   ?view=materials — «Тендеры на материалы» (маршрут /tenders/materials);
//   ?view=warranty|joint|other — прочие направления;
//   ?theme=dark     — тёмная тема;
//   ?now=...        — «сегодня» (обрабатывается в index.html до загрузки бандла).
import '@variant/index.css'
import '@variant/App.css'
import '@variant/mobile.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '@variant/contexts/ThemeContext'
import { RoleProvider } from '@variant/contexts/RoleContext'
import TendersPage from '@variant/pages/TendersPage'

const params = new URLSearchParams(location.search)
const view = params.get('view') || 'construction'
const isMaterials = view === 'materials'
const theme = params.get('theme') || 'light'
document.documentElement.setAttribute('data-theme', theme)
try { localStorage.setItem('theme', theme) } catch { /* noop */ }

// Фильтры и «компактный вид» страница помнит в localStorage — на стенде всегда
// начинаем с чистого состояния, иначе снимки вариантов разъедутся.
if (params.get('keepState') !== '1') {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('tenders-filters:') || k.startsWith('tenders-compact-view:'))
      .forEach((k) => localStorage.removeItem(k))
  } catch { /* noop */ }
}

const route = isMaterials ? '/tenders/materials' : `/tenders/${view}`

function Stand() {
  return (
    <ThemeProvider>
      <RoleProvider>
        <MemoryRouter initialEntries={[route]}>
          <div className="layout">
            {/* Место сайдбара (200px) — чтобы ширина рабочей области совпадала с приложением. */}
            <div className="stand-sidebar" aria-hidden />
            <main className="main-content">
              {isMaterials
                ? <TendersPage key="tenders-materials" tenderType="materials" />
                : <TendersPage key={`tenders-${view}`} department={view} tenderType="main" />}
            </main>
          </div>
        </MemoryRouter>
      </RoleProvider>
    </ThemeProvider>
  )
}

const strict = params.get('strict') === '1'
const tree = strict ? <StrictMode><Stand /></StrictMode> : <Stand />
createRoot(document.getElementById('root')).render(tree)

// Признак готовности для Playwright: рендер прошёл без исключения.
window.__STAND_READY__ = true
