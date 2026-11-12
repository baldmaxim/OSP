// Дерево разделов сметы КП / ПЗ: разделы и группы (без позиций) с поиском по названию и коду. Нажатие — таблица
// показывает только эту ветку; полоса — доля распределённого бюджета ветки, «⚠» — превышение внутри.
import { useMemo, useState } from 'react'
import { fmtMoneyShort, sectionTree } from '../../utils/kpEstimate'

export default function KpEstimateTree({ tree, sums, view, scope, onScope }) {
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState(() => new Set(tree.rows.filter((r) => r.level >= 2 && tree.children.has(r.id)).map((r) => r.id)))
  const { ids, matched } = useMemo(() => sectionTree(tree, query, view), [tree, query, view])
  const groupIds = useMemo(() => new Set(ids), [ids])

  // Видимые узлы: предок свёрнут — потомки скрыты (при поиске — всё раскрыто).
  const visible = []
  const hidden = new Set()
  for (const id of ids) {
    const parent = tree.parentOf.get(id)
    if (parent && hidden.has(parent)) { hidden.add(id); continue }
    visible.push(id)
    if (!matched && closed.has(id)) hidden.add(id)
  }
  const hasSubgroups = (id) => (tree.children.get(id) || []).some((c) => groupIds.has(c))

  const toggle = (id) => setClosed((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <nav className="kpe-tree" aria-label="Разделы сметы">
      <div className="kpe-tree-search">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по разделам" aria-label="Поиск по разделам" />
      </div>
      <ul className="kpe-tree-list">
        <li>
          <button type="button" className={`kpe-tree-item kpe-tree-root${scope ? '' : ' is-current'}`} onClick={() => onScope(null)}>
            <span className="kpe-tree-name">Вся смета</span>
          </button>
        </li>
        {visible.map((id) => {
          const r = tree.byId.get(id)
          const sum = sums.get(id)
          const share = sum && (sum.distributedMoney + sum.freeMoney) > 0 ? Math.min(1, sum.distributedMoney / (sum.distributedMoney + sum.freeMoney)) : 0
          const sub = hasSubgroups(id)
          return (
            <li key={id} style={{ paddingLeft: `${(r.level - 1) * 0.75}rem` }}>
              <div className={`kpe-tree-item${scope === id ? ' is-current' : ''}${matched?.has(id) ? ' is-match' : ''}`}>
                {sub
                  ? <button type="button" className={`kpe-toggle${closed.has(id) && !matched ? '' : ' is-open'}`} aria-label={closed.has(id) ? 'Развернуть раздел' : 'Свернуть раздел'} onClick={() => toggle(id)}>
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  : <span className="kpe-toggle-space" />}
                <button type="button" className="kpe-tree-label" onClick={() => onScope(id)} title={`${r.code ? `${r.code} ` : ''}${r.name}`}>
                  <span className="kpe-tree-name">{r.code ? <b>{r.code}</b> : null} {r.name}</span>
                  <span className="kpe-tree-meta">
                    {sum?.counts?.over ? <span className="kpe-over" title="Позиций с превышением">⚠ {sum.counts.over}</span> : null}
                    <span className="kpe-tree-sum">{fmtMoneyShort(view === 'pz' ? sum?.commTotal : sum?.total)}</span>
                  </span>
                  <span className="kpe-tree-bar" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
                </button>
              </div>
            </li>
          )
        })}
        {!visible.length && <li className="kpe-muted kpe-tree-empty">Разделов не найдено</li>}
      </ul>
    </nav>
  )
}
