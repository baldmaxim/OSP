import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Положение прокрутки страницы переживает обновление: пишется в sessionStorage вкладки браузера и возвращается
// один раз — когда данные на месте (ready), иначе возвращать некуда. Прокручивается .main-content, а не окно
// (App.css); без обвязки приложения — окно; у страницы с закреплённой шапкой — свой блок (ownBox — его селектор
// внутри корня, например таблица «Заявок на ДС»), если он и правда прокручивается. Возвращает ref для корня страницы.
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

function scrollBoxOf(root, ownBox) {
  const own = ownBox ? root?.querySelector(ownBox) : null
  if (own && own.scrollHeight > own.clientHeight) return own
  return root?.closest('.main-content') || null
}

export default function useScrollMemory(key, ready, ownBox = null) {
  const rootRef = useRef(null)
  const [savedTop] = useState(() => readTop(key))
  // Положение, которое ещё предстоит вернуть (null — нечего или уже вернули).
  const pendingRef = useRef(savedTop)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    // Блок выбирается в момент записи: свой блок появляется и начинает прокручиваться, когда загрузились данные.
    const currentTop = () => {
      const box = scrollBoxOf(root, ownBox)
      return box ? box.scrollTop : window.scrollY
    }
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
    // scroll не всплывает — ловим на погружении: так слышна прокрутка и окна, и .main-content, и своего блока.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('wheel', cancel, { passive: true })
    window.addEventListener('touchmove', cancel, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('wheel', cancel)
      window.removeEventListener('touchmove', cancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pagehide', flush)
    }
  }, [key, ownBox])

  // До отрисовки — без мелькания верха страницы.
  useLayoutEffect(() => {
    if (!ready || pendingRef.current == null) return
    const top = pendingRef.current
    pendingRef.current = null
    const box = scrollBoxOf(rootRef.current, ownBox)
    if (box) box.scrollTop = top
    else window.scrollTo(0, top)
  }, [ready, ownBox])

  return rootRef
}
