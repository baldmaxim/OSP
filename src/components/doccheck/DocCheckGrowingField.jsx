import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'

// Поле в одну строку, растущее по тексту: Enter — onSubmit, Shift+Enter — новая строка. Для сообщения заявки. ref — само поле
// (фокус после выбора файла).
// Высота: текст стал длиннее — поле только растёт, без сброса (раньше каждая буква сбрасывала высоту и заставляла браузер раскладывать
// поле дважды; 13.11.2026, окно заявки подтормаживало при вводе); стал короче (стёрли, отправили) — сброс и замер заново. Пустое поле
// браузер меряет по подсказке (placeholder): подсказка длиннее строки — поле в две строки.
const DocCheckGrowingField = forwardRef(function DocCheckGrowingField({ value, onChange, onSubmit, ...rest }, outerRef) {
  const ref = useRef(null)
  const lastLength = useRef(0)
  useImperativeHandle(outerRef, () => ref.current, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const length = String(value ?? '').length
    if (length < lastLength.current) el.style.height = 'auto'
    lastLength.current = length
    const cs = getComputedStyle(el)
    const height = el.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + 'px'
    if (el.style.height !== height) el.style.height = height
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() }
      }}
      {...rest}
    />
  )
})

export default DocCheckGrowingField
