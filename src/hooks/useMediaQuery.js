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

// Элемент уже порога (CSS-пиксели, ширина содержимого — ResizeObserver); пока не измерен — false.
//
// Зачем, если есть media-query: ширина ОКНА и ширина места под таблицу — разные
// величины. На 2К-мониторе Windows масштабирует изображение (125-150%), браузер
// может иметь свой зум, слева стоит меню, а у раздела свои отступы. Порог вида
// «@media (max-width: 1450px)» во всём этом промахивается. Меряем то, что есть
// на самом деле, — тогда раскладка подстраивается под любой экран и масштаб.
//
// В состоянии — только «уже / не уже», а не сама ширина: иначе каждый пиксель
// смены ширины (окно тянут, свернули меню) перерисовывал бы всю страницу, хотя
// нужен ей только переход через порог (06.11.2026, реестр договоров).
export function useElementNarrowerThan(ref, px) {
  const [narrower, setNarrower] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentRect — ширина без рамок и паддингов: ровно то, что достаётся
        // содержимому.
        setNarrower(Math.round(entry.contentRect.width) < px)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, px])

  return narrower
}
