import { useMemo, useState } from 'react'

// Вкладка «Расценки снабжения» карточки: цены, чей ВОР не совпадает ни с одним ВОР карточки (снабжение
// расценивало файл из «ВОРов и РД» под другим именем). «Привязать к…» переносит их — вместе со списком
// позиций — на ВОР карточки одной транзакцией (supply_estimate_rename); пересечение цен — отказ целиком.
export default function SupplyOrphanRates({ rates, docNames, canEdit, onRename }) {
  const groups = useMemo(() => {
    if (!docNames.length) return []
    const known = new Set(docNames)
    const m = new Map()
    for (const r of rates) {
      const name = r.estimate_name || 'Основная смета'
      if (known.has(name)) continue
      m.set(name, (m.get(name) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))
  }, [rates, docNames])
  const [target, setTarget] = useState({})
  const [busy, setBusy] = useState(null)
  if (groups.length === 0) return null
  return (
    <details className="supply-unmatched supply-orphan-docs">
      <summary>Расценки без документа ВОР в карточке: {groups.reduce((s, [, n]) => s + n, 0)}</summary>
      <p className="supply-tab-hint">
        Эти цены введены по ВОР, которого нет во вкладке «ВОР» (например, по файлу из «ВОРов и РД» под другим именем),
        поэтому здесь не сопоставляются. Привяжите их к ВОР карточки.
      </p>
      <ul>
        {groups.map(([name, count]) => (
          <li key={name}>
            <span>«{name}» — {count}</span>
            {canEdit && (
              <>
                <select
                  value={target[name] || ''}
                  onChange={(e) => setTarget((prev) => ({ ...prev, [name]: e.target.value }))}
                  aria-label={`ВОР карточки для «${name}»`}
                >
                  <option value="">ВОР карточки…</option>
                  {docNames.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={!target[name] || busy === name}
                  onClick={async () => {
                    setBusy(name)
                    try { await onRename(name, target[name]) } finally { setBusy(null) }
                  }}
                >{busy === name ? 'Привязка…' : 'Привязать'}</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
