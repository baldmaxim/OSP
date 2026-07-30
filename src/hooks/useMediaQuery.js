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
