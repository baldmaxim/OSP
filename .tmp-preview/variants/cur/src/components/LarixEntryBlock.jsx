import { useState } from 'react'
import './LarixEntryBlock.css'

// Блок «Внесение в Larix» в раскрытой строке договора. После заключения договора
// сотрудник заносит его в систему Larix и отмечает это здесь: факт + присвоенный
// в Larix номер; фиксируется кто и когда отметил. onAction(action, number):
//   'mark'  — отметить внесённым (сохраняет номер + кто/когда);
//   'update'— обновить только номер;
//   'unmark'— снять отметку.

function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export default function LarixEntryBlock({ contract, canEdit = false, onAction }) {
  const entered = !!contract.larix_entered
  const [num, setNum] = useState(contract.larix_number || '')
  const [busy, setBusy] = useState(false)

  const run = async (action) => {
    setBusy(true)
    try { await onAction(action, num) } finally { setBusy(false) }
  }

  return (
    <section className="ce-block larix-block">
      <div className="ce-block-title">Внесение в Larix</div>

      {entered ? (
        <div className="larix-done">
          <span className="larix-status"><IconCheck /> Внесён в Larix</span>
          {contract.larix_number && <span className="larix-num">№ {contract.larix_number}</span>}
          {(contract.larix_entered_by || contract.larix_entered_at) && (
            <span className="larix-meta">
              {contract.larix_entered_by ? `внёс ${contract.larix_entered_by}` : ''}
              {contract.larix_entered_at ? ` · ${fmtDateTime(contract.larix_entered_at)}` : ''}
            </span>
          )}
          {canEdit && (
            <div className="larix-edit">
              <input
                type="text"
                className="larix-input"
                value={num}
                onChange={(e) => setNum(e.target.value)}
                placeholder="№ в Larix"
              />
              <button type="button" className="larix-btn-secondary" disabled={busy} onClick={() => run('update')}>
                Сохранить №
              </button>
              <button type="button" className="larix-btn-ghost" disabled={busy} onClick={() => run('unmark')}>
                Снять отметку
              </button>
            </div>
          )}
        </div>
      ) : canEdit ? (
        <div className="larix-todo">
          <input
            type="text"
            className="larix-input"
            value={num}
            onChange={(e) => setNum(e.target.value)}
            placeholder="№ в Larix (необязательно)"
          />
          <button type="button" className="larix-btn-primary" disabled={busy} onClick={() => run('mark')}>
            Отметить внесённым в Larix
          </button>
        </div>
      ) : (
        <div className="larix-empty">Не внесён в Larix</div>
      )}
    </section>
  )
}
