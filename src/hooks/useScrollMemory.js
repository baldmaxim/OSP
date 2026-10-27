import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Положение прокрутки страницы переживает обновление: пишется в sessionStorage вкладки браузера и возвращается
// один раз — когда данные на месте (ready), иначе возвращать некуда. Прокручивается .main-content, а не окно
// (App.css); без обвязки приложения — окно. Возвращает ref для корня страницы.
// Человек успел прокрутить сам, пока грузилось, — положение не возвращаем.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

function readTop(key) {
  try {
    const top = Number(window.sessionStorage.getItem(key))
    return Number.isFinite(top) && top > 0 ? top : null
  } catch { return null }
}

function writeTop(key, top) {
  try { window.sessionStorage.setItem(key, String(Math.round(top))) } catch { /* приватный режим */ }
}

const scrollBoxOf = (root) => root?.closest('.main-content') || null

export default function useScrollMemory(key, ready) {
  const rootRef = useRef(null)
  const [savedTop] = useState(() => readTop(key))
  // Положение, которое ещё предстоит вернуть (null — нечего или уже вернули).
  const pendingRef = useRef(savedTop)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const box = scrollBoxOf(root)
    const target = box || window
    const currentTop = () => (box ? box.scrollTop : window.scrollY)
    let timer = null
    // Пока положение не вернули, сохранённое не перезаписываем: прокрутка в начале — это ещё не данные.
    // Страницу уже убрали (переход в другой раздел) — .main-content прокручивает чужое содержимое.
    const save = () => {
      timer = null
      if (pendingRef.current == null && root.isConnected) writeTop(key, currentTop())
    }
    const onScroll = () => { if (!timer) timer = setTimeout(save, 150) }
    const cancel = () => { pendingRef.current = null }
    const onKey = (e) => {
      if (!SCROLL_KEYS.has(e.key) || e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      cancel()
    }
    const flush = () => { clearTimeout(timer); save() }
    target.addEventListener('scroll', onScroll, { passive: true })
    target.addEventListener('wheel', cancel, { passive: true })
    target.addEventListener('touchmove', cancel, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(timer)
      target.removeEventListener('scroll', onScroll)
      target.removeEventListener('wheel', cancel)
      target.removeEventListener('touchmove', cancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pagehide', flush)
    }
  }, [key])

  // До отрисовки — без мелькания верха страницы.
  useLayoutEffect(() => {
    if (!ready || pendingRef.current == null) return
    const top = pendingRef.current
    pendingRef.current = null
    const box = scrollBoxOf(rootRef.current)
    if (box) box.scrollTop = top
    else window.scrollTo(0, top)
  }, [ready])

  return rootRef
}
