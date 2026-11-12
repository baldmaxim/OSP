import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'

// Поле в одну строку, растущее по тексту: Enter — onSubmit, Shift+Enter — новая строка. Для сообщения заявки. ref — само поле
// (фокус после выбора файла).
const DocCheckGrowingField = forwardRef(function DocCheckGrowingField({ value, onChange, onSubmit, ...rest }, outerRef) {
  const ref = useRef(null)
  useImperativeHandle(outerRef, () => ref.current, [])
  // Высота — по числу строк (и обратно в одну строку после отправки).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    el.style.height = el.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + 'px'
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
