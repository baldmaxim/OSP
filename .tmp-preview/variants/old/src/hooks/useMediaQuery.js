import { useState, useEffect } from 'react'

// Подписка на CSS media-query из React. Возвращает boolean совпадения и
// обновляется при ресайзе/повороте экрана. Нужен, чтобы рендерить ЛИБО таблицу,
// ЛИБО мобильные карточки (а не то и другое разом) — без дублирования DOM.
export function useMediaQuery(query) {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false

  const [matches, setMatches] = useState(getMatch)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange() // синхронизируемся на случай, если query изменился между рендерами
    // addEventListener('change') — современный API; Safari <14 использовал addListener.
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [query])

  return matches
}

// Телефон: портрет телефонов и малых планшетов. В ландшафте (>640px) остаётся
// таблица с горизонтальной прокруткой.
export function useIsPhone() {
  return useMediaQuery('(max-width: 640px)')
}

// Фактическая ширина элемента в CSS-пикселях (ResizeObserver).
//
// Зачем, если есть media-query: ширина ОКНА и ширина места под таблицу — разные
// величины. На 2К-мониторе Windows масштабирует изображение (125-150%), браузер
// может иметь свой зум, слева стоит меню, а у раздела свои отступы. Порог вида
// «@media (max-width: 1450px)» во всём этом промахивается. Меряем то, что есть
// на самом деле, — тогда раскладка подстраивается под любой экран и масштаб.
export function useElementWidth(ref) {
  const [width, setWidth] = useState(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentRect — ширина без рамок и паддингов: ровно то, что достаётся
        // содержимому.
        setWidth(Math.round(entry.contentRect.width))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return width
}
