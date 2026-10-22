// Общие графики отчётов на чистом SVG (без зависимостей): кольцо статусов,
// сгруппированные столбцы динамики и полоса доли. Стили — ReportsPage.css.

// Кольцо статусов. segments суммируются в total.
export function StatusDonut({ total, segments, label = 'Статусы тендеров', caption = 'Всего' }) {
  const sum = segments.reduce((a, seg) => a + seg.value, 0) || 1
  const R = 54
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut-svg" role="img" aria-label={label}>
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--border-color)" strokeWidth="18" opacity="0.3" />
        {segments.filter(seg => seg.value > 0).map((seg, i) => {
          const len = (seg.value / sum) * C
          const el = (
            <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={seg.color} strokeWidth="18"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
              transform="rotate(-90 70 70)" />
          )
          offset += len
          return el
        })}
        <text x="70" y="66" textAnchor="middle" className="donut-num">{total}</text>
        <text x="70" y="86" textAnchor="middle" className="donut-cap">{caption}</text>
      </svg>
      <ul className="donut-legend">
        {segments.map((seg, i) => (
          <li key={i} title={seg.title}>
            <span className="legend-dot" style={{ background: seg.color }} />
            <span className="legend-label">{seg.label}</span>
            <span className="legend-val">{seg.value}</span>
            <span className="legend-pct">{Math.round((seg.value / sum) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Сгруппированные столбцы. data — [{label, title?, ...значения}]; series — [{key,label,color}].
// title столбца — всплывающая подсказка (полная дата периода).
export function BarChart({ data, series, label = 'Динамика тендеров' }) {
  const W = 520, H = 190
  const pad = { l: 24, r: 10, t: 22, b: 22 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const max = Math.max(1, ...data.flatMap(d => series.map(se => d[se.key])))
  const n = data.length || 1
  const groupW = iw / n
  const barGap = 3
  const barW = Math.max(4, (groupW * 0.66 - barGap * (series.length - 1)) / series.length)
  const y = (v) => pad.t + (1 - v / max) * ih
  // Подписи над столбцами — только если соседние не налезут друг на друга
  // (цифра шрифта 10px ≈ 6 единиц); иначе числа — в подсказке столбца.
  const showVals = String(max).length * 6 <= barW + barGap
  return (
    <div className="bars-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="bars-svg" role="img" aria-label={label}>
        {[0, 0.5, 1].map((g) => {
          const yy = pad.t + g * ih
          return <line key={g} x1={pad.l} x2={W - pad.r} y1={yy} y2={yy} stroke="var(--border-color)" strokeWidth="1" opacity="0.45" />
        })}
        {data.map((d, i) => {
          const gx = pad.l + i * groupW + (groupW - (barW * series.length + barGap * (series.length - 1))) / 2
          return (
            <g key={i}>
              {d.title && (
                <title>{`${d.title}: ${series.map(se => `${se.label.toLowerCase()} ${d[se.key]}`).join(', ')}`}</title>
              )}
              {/* Прозрачная подложка группы — подсказка срабатывает и над пустым столбцом. */}
              {d.title && <rect x={pad.l + i * groupW} y={pad.t} width={groupW} height={ih} fill="transparent" />}
              {series.map((se, j) => {
                const v = d[se.key]
                const bx = gx + j * (barW + barGap)
                const by = y(v)
                return (
                  <g key={se.key}>
                    <rect x={bx} y={by} width={barW} height={Math.max(0, pad.t + ih - by)} rx="2" fill={se.color} />
                    {showVals && v > 0 && <text x={bx + barW / 2} y={by - 3} textAnchor="middle" className="bar-val" fill={se.color}>{v}</text>}
                  </g>
                )
              })}
              <text x={pad.l + i * groupW + groupW / 2} y={H - 6} textAnchor="middle" className="bar-x">{d.label}</text>
            </g>
          )
        })}
      </svg>
      <ul className="bars-legend">
        {series.map(se => (
          <li key={se.key}><span className="legend-dot" style={{ background: se.color }} />{se.label}</li>
        ))}
      </ul>
    </div>
  )
}

export function ProgressBar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="bar-with-pct">
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-pct">{pct}%</span>
    </div>
  )
}
