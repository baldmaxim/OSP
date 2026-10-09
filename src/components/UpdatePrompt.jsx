/* global __BUILD_ID__, __BUILD_COMPAT__ */
import { useEffect, useRef, useState } from 'react'
import { refreshRuntimeFeatures } from '../config/runtime'
import { reportClientVersion } from '../services/telemetry'
import './UpdatePrompt.css'

// Попап «Доступна новая версия». Сверяет build id, вшитый в текущий бандл
// (__BUILD_ID__, подставляется Vite при сборке), с dist/version.json, который
// отдаётся с задеплоенной версией. nginx отдаёт version.json как no-cache, а
// хэш-ассеты — immutable, поэтому свежий fetch version.json всегда отражает
// актуальную сборку. Расхождение id → вышла новая версия, предлагаем обновить.
//
// Обычная новая версия — без авто-перезагрузки: reload только по кнопке, чтобы не
// потерять несохранённый ввод (например, открытую модалку проверки КП).
//
// Несовместимая версия (compat в version.json выше вшитого __BUILD_COMPAT__,
// release.json): окно без «Позже». Чтобы не потерять ввод, его можно свернуть
// кнопкой «Сначала сохраню» — остаётся незакрываемая полоса сверху. Запись пока
// работает: старое на сервере убираем, только когда вкладок со старой сборкой не
// осталось (телеметрия + лог nginx по ?b=).

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 минуты

const CURRENT_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : null
const CURRENT_COMPAT = typeof __BUILD_COMPAT__ !== 'undefined' ? Number(__BUILD_COMPAT__) : 0

export default function UpdatePrompt() {
  // 'none' — всё актуально; 'update' — есть новая версия; 'forced' — обновиться обязательно.
  const [mode, setMode] = useState('none')
  const [open, setOpen] = useState(false)
  const offered = useRef(false) // обычное окно показываем один раз
  const forced = useRef(false)

  useEffect(() => {
    let timer = null

    const check = async () => {
      // Флаги config.json — и в открытой вкладке: явное false выключает новый путь без перезагрузки.
      refreshRuntimeFeatures().catch(() => {})
      if (forced.current) return
      reportClientVersion().catch(() => {})
      try {
        // b= — id сборки этой вкладки: по логу nginx видно, остались ли вкладки
        // старых сборок (в том числе открытые до появления телеметрии).
        const res = await fetch(`/version.json?b=${encodeURIComponent(CURRENT_ID || '')}&_=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const latest = data?.buildId
        if (!latest || !CURRENT_ID || latest === CURRENT_ID) return
        if (Number(data?.compat) > CURRENT_COMPAT) {
          forced.current = true
          setMode('forced')
          setOpen(true)
        } else if (!offered.current) {
          offered.current = true
          setMode('update')
          setOpen(true)
        }
      } catch {
        // dev / 404 / офлайн — молча пропускаем, попробуем в следующий раз.
      }
    }

    // Проверяем при возврате на вкладку/окно — чтобы обновление замечалось быстро.
    const onVisible = () => { if (document.visibilityState === 'visible') check() }

    timer = setInterval(check, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    // Первую проверку не делаем сразу на маунте (только что загрузили свежий бандл).

    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
    }
  }, [])

  const isForced = mode === 'forced'

  if (!open) {
    if (!isForced) return null
    return (
      <div className="upd-banner" role="status">
        <span>Версия портала устарела — сохраните введённое и обновите страницу.</span>
        <button type="button" className="upd-banner-reload" onClick={() => window.location.reload()}>Обновить</button>
      </div>
    )
  }

  const close = () => setOpen(false)

  return (
    <div className="upd-overlay" onClick={isForced ? undefined : close}>
      <div
        className="upd-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="upd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="upd-prompt-icon" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v5h-5" />
          </svg>
        </div>
        <div className="upd-prompt-title" id="upd-title">
          {isForced ? 'Нужно обновить страницу' : 'Доступна новая версия'}
        </div>
        <div className="upd-prompt-text">
          {isForced
            ? 'Эта версия портала устарела. Если вы что-то вводили и не сохранили — сначала сохраните, затем обновите страницу.'
            : 'Обновите страницу, чтобы применить последние изменения.'}
        </div>
        <div className="upd-prompt-actions">
          <button
            type="button"
            className="upd-prompt-later"
            onClick={close}
          >{isForced ? 'Сначала сохраню' : 'Позже'}</button>
          <button
            type="button"
            className="upd-prompt-reload"
            onClick={() => window.location.reload()}
          >Обновить</button>
        </div>
      </div>
    </div>
  )
}
