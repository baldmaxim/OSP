import { useEffect } from 'react'

// Класс на <body>, пока компонент смонтирован (и enabled). Нужен для оформления
// всплывающих окон, которые рисуются порталом в <body> — вне корня страницы.
export default function useBodyClass(className, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined
    document.body.classList.add(className)
    return () => document.body.classList.remove(className)
  }, [className, enabled])
}
