// Общие части отчётов по заявкам («Заключение ДП», «Проверка ДП/ДС»): фильтр-плашка, строка «Требуют внимания», таблица
// «за период» (сегодня, неделя, месяц, всё время), кнопка «Показать все». Стили — ReportsPage.css (rf-*, attn-*, kps-*).
import { useState } from 'react'

const pad = (n) => String(n).padStart(2, '0')
export const ddmm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
export const num = (v) => (v ? v : '—')
export const fmtMoney = (n) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n || 0))} ₽`
export const money = (v) => (v ? fmtMoney(v) : '—')
export const fmtDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'
}
export const fmtDateTime = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : `${ddmm(d)}.${d.getFullYear()}`
}

// Фильтр-плашка: «Объект: Все ▾». options — [{ id, name }].
export function FilterChip({ label, value, onChange, options, allLabel = 'Все' }) {
  return (
    <label className={`rf-chip ${value !== 'all' ? 'is-active' : ''}`}>
      <span className="rf-chip-key">{label}:</span>
      <select className="rf-chip-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="all">{allLabel}</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  )
}

// Строка блока «Требуют внимания»: ноль — серым.
export function QueueItem({ tone, label, hint, value }) {
  return (
    <div className={`attn-item attn-item--${value > 0 ? tone : 'muted'}`}>
      <div className="attn-body">
        <div className="attn-label">{label}</div>
        <div className="attn-hint">{hint}</div>
      </div>
      <div className="attn-val">{value}</div>
    </div>
  )
}

const PERIODS = ['today', 'week', 'month', 'all']

// Таблица «за период». rows — [{ key, label, hint?, group?, sub?, money? }], matrix[key][период] — число.
export function PeriodMatrix({ rows, matrix, starts }) {
  return (
    <div className="kps-table-wrap">
      <table className="dense-table kps-matrix">
        <thead>
          <tr>
            <th>Показатель</th>
            <th className="num">Сегодня<span className="kps-th-sub">{ddmm(starts.today)}</span></th>
            <th className="num">Неделя<span className="kps-th-sub">с {ddmm(starts.week)}</span></th>
            <th className="num">Месяц<span className="kps-th-sub">с {ddmm(starts.month)}</span></th>
            <th className="num">Всего<span className="kps-th-sub">за всё время</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap(row => {
            const out = []
            if (row.group) {
              out.push(<tr key={`g-${row.group}`} className="kps-group-row"><td colSpan={5}>{row.group}</td></tr>)
            }
            out.push(
              <tr key={row.key} className={row.sub ? 'kps-sub-row' : ''}>
                <td title={row.hint}>{row.label}</td>
                {PERIODS.map(p => (
                  <td key={p} className={`num${row.sub ? '' : ' strong'}${row.money ? ' dcs-money-cell' : ''}`}>
                    {row.money ? money(matrix[row.key][p]) : num(matrix[row.key][p])}
                  </td>
                ))}
              </tr>
            )
            return out
          })}
        </tbody>
      </table>
    </div>
  )
}

// Длинный список: первые limit строк и «Показать все (N)». render(видимые строки) — сама таблица.
export function Limited({ rows, limit, render }) {
  const [showAll, setShowAll] = useState(false)
  const visible = limit && !showAll ? rows.slice(0, limit) : rows
  return (
    <>
      {render(visible)}
      {limit && rows.length > limit && (
        <button type="button" className="activity-refresh dcs-more" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Свернуть' : `Показать все (${rows.length})`}
        </button>
      )}
    </>
  )
}
