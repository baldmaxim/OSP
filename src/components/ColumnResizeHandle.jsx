import './ColumnResizeHandle.css'

// Граница столбца в заголовке таблицы — потянуть мышью, чтобы изменить ширину (hooks/useColumnWidths.js).
// Двойной щелчок — ширина по умолчанию; с клавиатуры (Tab до границы) — стрелки влево / вправо, с Shift — шаг крупнее,
// Delete — по умолчанию. Ставится последним элементом в <th>: у ячейки шапки должно быть position (sticky или relative).
export default function ColumnResizeHandle({ label, width, onStart, onStep, onReset }) {
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
