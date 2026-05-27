import { useRef, useLayoutEffect, useCallback } from 'react'

/**
 * Авторастягивающаяся textarea без layout-thrash.
 *
 * Старый паттерн `ref={el => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}`
 * пересоздаёт ref-функцию на каждом рендере родителя, что заставляет React
 * вызывать ref(null)+ref(el) и пересчитывать layout. Для таблиц с сотнями
 * строк это давало 1000+ принудительных reflow на каждое нажатие клавиши.
 *
 * Этот компонент:
 *  - привязывает ref ОДИН раз через useRef,
 *  - инициализирует высоту через useLayoutEffect только при изменении defaultValue
 *    (или при mount),
 *  - подстраивает высоту в onInput без re-render.
 */
function AutoGrowTextarea({
  defaultValue = '',
  minHeight = 32,
  onInput,
  onBlur,
  className,
  placeholder,
  rows = 1,
  disabled,
  readOnly,
  style,
  title,
  ...rest
}) {
  const ref = useRef(null)

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.max(el.scrollHeight, minHeight) + 'px'
  }, [minHeight])

  // Подстраиваем высоту под defaultValue — при mount и при смене defaultValue
  // (например, после refetch данных). Не пересчитываем при каждом рендере.
  useLayoutEffect(() => {
    resize()
  }, [defaultValue, resize])

  return (
    <textarea
      ref={ref}
      defaultValue={defaultValue}
      rows={rows}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      readOnly={readOnly}
      style={style}
      title={title}
      onInput={(e) => {
        resize()
        onInput?.(e)
      }}
      onBlur={onBlur}
      {...rest}
    />
  )
}

export default AutoGrowTextarea
