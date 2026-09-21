import { useState } from 'react'

// Ошибки и предупреждения проверки: Файл | Строка Excel | Ячейка | Сообщение.
// Ошибки блокируют применение, предупреждения — нет.
const COLLAPSED = 8

function PsdcIssues({ issues = [], showFile = false, emptyText = null }) {
  const [expanded, setExpanded] = useState(false)
  if (!issues.length) return emptyText ? <p className="psdc-hint">{emptyText}</p> : null

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  const list = expanded ? issues : issues.slice(0, COLLAPSED)

  return (
    <div className="psdc-issues">
      <div className="psdc-issues-head">
        {errors > 0 && <span className="psdc-count is-error">Ошибки: {errors}</span>}
        {warnings > 0 && <span className="psdc-count is-warning">Предупреждения: {warnings}</span>}
        {errors > 0 && <span className="psdc-hint">Ошибки нужно исправить в файле и загрузить его заново. Предупреждения применение не блокируют.</span>}
      </div>
      <div className="psdc-issues-scroll">
        <table className="psdc-issues-table">
          <thead>
            <tr>
              {showFile && <th>Файл</th>}
              <th>Строка</th>
              <th>Ячейка</th>
              <th>Сообщение</th>
            </tr>
          </thead>
          <tbody>
            {list.map((issue, idx) => (
              <tr key={`${issue.psdc_id || ''}-${issue.cell || ''}-${idx}`} className={issue.severity === 'error' ? 'is-error' : 'is-warning'}>
                {showFile && <td className="psdc-issue-file">{issue.file}</td>}
                <td className="mono">{issue.excel_row ?? '—'}</td>
                <td className="mono">{issue.cell ?? '—'}</td>
                <td>
                  <span className={`psdc-sev ${issue.severity === 'error' ? 'is-error' : 'is-warning'}`} aria-hidden="true" />
                  {issue.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {issues.length > COLLAPSED && (
        <button type="button" className="psdc-link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Свернуть' : `Показать все (${issues.length})`}
        </button>
      )}
    </div>
  )
}

export default PsdcIssues
