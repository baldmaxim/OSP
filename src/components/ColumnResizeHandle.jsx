import { useSyncExternalStore } from 'react'
import './ColumnResizeHandle.css'

// Граница столбца в заголовке таблицы — потянуть мышью, чтобы изменить ширину (hooks/useColumnWidths.js).
// Двойной щелчок — ширина по умолчанию; с клавиатуры (Tab до границы) — стрелки влево / вправо, с Shift — шаг крупнее,
// Delete — по умолчанию. Ставится последним элементом в <th>: у ячейки шапки должно быть position (sticky или relative).
// Ширину берёт из хука сама (subscribe / getWidth): смена ширины перерисовывает границы, а не всю таблицу.
export default function ColumnResizeHandle({ label, subscribe, getWidth, onStart, onStep, onReset }) {
  const width = useSyncExternalStore(subscribe, getWidth)
  return (
    <span
      className="col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Ширина столбца «${label}»`}
      aria-valuenow={Math.round(width * 16)}
      aria-valuetext={`${Math.round(width * 16)} пикселей`}
      tabIndex={0}
      title="Потяните, чтобы изменить ширину столбца. Двойной щелчок — ширина по умолчанию"
      onPointerDown={onStart}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); onReset() }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 2 : 0.5
        if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(-step) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onStep(step) }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onReset() }
      }}
    />
  )
}

// Кнопка «вернуть ширины по умолчанию» — видна, пока есть свои ширины. widths — то, что вернул useColumnWidths;
// остальное (className, title, текст) — как у обычной кнопки.
export function ColumnWidthsReset({ widths, children, ...rest }) {
  const customized = useSyncExternalStore(widths.subscribe, widths.isCustomized)
  if (!customized) return null
  return <button type="button" {...rest} onClick={widths.resetAll}>{children}</button>
}
