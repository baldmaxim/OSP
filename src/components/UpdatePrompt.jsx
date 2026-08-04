/* global __BUILD_ID__ */
import { useEffect, useRef, useState } from 'react'
import './UpdatePrompt.css'

// Попап «Доступна новая версия». Сверяет build id, вшитый в текущий бандл
// (__BUILD_ID__, подставляется Vite при сборке), с dist/version.json, который
// отдаётся с задеплоенной версией. nginx отдаёт version.json как no-cache, а
// хэш-ассеты — immutable, поэтому свежий fetch version.json всегда отражает
// актуальную сборку. Расхождение id → вышла новая версия, предлагаем обновить.
//
// Без авто-перезагрузки: reload только по кнопке — чтобы не потерять
// несохранённый ввод (например, открытую модалку проверки КП с замечаниями).

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 минуты

export default function UpdatePrompt() {
  const [show, setShow] = useState(false)
  // id текущей запущенной сборки; в dev __BUILD_ID__ — timestamp запуска конфига.
  const currentId = useRef(typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : null)
  const stopped = useRef(false)

  useEffect(() => {
    let timer = null

    const check = async () => {
      if (stopped.current) return
      try {
        const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const latest = data?.buildId
        if (latest && currentId.current && latest !== currentId.current) {
          stopped.current = true
          setShow(true)
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

  if (!show) return null

  return (
    <div className="upd-prompt" role="status" aria-live="polite">
      <div className="upd-prompt-body">
        <div className="upd-prompt-title">Доступна новая версия</div>
        <div className="upd-prompt-text">
          Обновите страницу, чтобы применить изменения.
        </div>
      </div>
      <div className="upd-prompt-actions">
        <button
          type="button"
          className="upd-prompt-later"
          onClick={() => setShow(false)}
        >Позже</button>
        <button
          type="button"
          className="upd-prompt-reload"
          onClick={() => window.location.reload()}
        >Обновить</button>
      </div>
    </div>
  )
}
