import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadSupplyItems, grantSupplyItems } from '../../services/contractorBids'
import { formatAmount } from '../../utils/money'
import './BidRequestsBlock.css'

// Окно инженера «Цены снабжения подрядчику» (решение пользователя 25.11.2026, миграция 20270303): позиции основного тендера с ценой
// снабжения (только те, у которых цена одна во всех ВОР, — другие подрядчику не отдаются), отметка у каждой — открыть подрядчику.
// «Сохранить» заменяет набор открытых позиций целиком; пустой набор снимает разрешение. Окно — в <body>: строка реестра его обрезала бы.

const keyOf = (r) => `${r.item_key}|${r.unit_key || ''}`
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е')

export default function BidSupplyItemsDialog({ tenderId, tenderNumber, counterparty, onClose, onSaved }) {
  const titleId = useId()
  const [items, setItems] = useState(null)
  const [picked, setPicked] = useState(() => new Set())
  const [initial, setInitial] = useState(() => new Set())
  const [query, setQuery] = useState('')
  const [onlyPicked, setOnlyPicked] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadSupplyItems(tenderId, counterparty.counterparty_id)
      .then((rows) => {
        if (cancelled) return
        const open = new Set(rows.filter((r) => r.granted).map(keyOf))
        setItems(rows)
        setPicked(open)
        setInitial(open)
      })
      .catch((e) => { if (!cancelled) { setItems([]); setError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [tenderId, counterparty.counterparty_id])

  // Escape закрывает только это окно: ловим клавишу раньше окна подрядчиков под ним и дальше не пускаем.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!saving) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, saving])

  const shown = useMemo(() => {
    const q = norm(query.trim())
    return (items || []).filter((r) => (!onlyPicked || picked.has(keyOf(r))) && (!q || norm(r.name).includes(q)))
  }, [items, query, onlyPicked, picked])

  const changed = useMemo(() => picked.size !== initial.size || [...picked].some((k) => !initial.has(k)), [picked, initial])

  const toggle = (k) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })
  const setShown = (on) => setPicked((prev) => {
    const next = new Set(prev)
    for (const r of shown) { if (on) next.add(keyOf(r)); else next.delete(keyOf(r)) }
    return next
  })

  const save = async () => {
    const name = counterparty.counterparty_name || 'организации'
    if (picked.size === 0 && initial.size > 0
      && !window.confirm(`Не отмечено ни одной позиции — цены снабжения «${name}» будут закрыты. Продолжить?`)) return
    setSaving(true)
    setError('')
    try {
      const list = (items || []).filter((r) => picked.has(keyOf(r))).map((r) => ({ key: r.item_key, unit_key: r.unit_key || '' }))
      const n = await grantSupplyItems(tenderId, counterparty.counterparty_id, { items: list })
      await onSaved?.(n)
    } catch (e) {
      setError(e.message || String(e))
      setSaving(false)
    }
  }

  return createPortal(
    <div className="bsi-overlay">
      <div className="bsi-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="bsi-head">
          <div>
            <h3 id={titleId}>Цены снабжения подрядчику</h3>
            <p className="bsi-sub">
              {counterparty.counterparty_name || 'Организация'}{tenderNumber != null ? ` · тендер № ${tenderNumber}` : ''}
            </p>
          </div>
          <button type="button" className="bsi-close" aria-label="Закрыть" onClick={onClose} disabled={saving}>×</button>
        </div>

        <div className="bsi-body">
          <p className="bsi-lead">
            Отметьте позиции, цену снабжения которых подрядчик увидит и сможет взять (без поставщиков; к взятой цене — счёт снабжения).
            Позиции, которые снабжение расценит позже, сами не откроются.
          </p>
          <div className="bsi-tools">
            <input type="search" className="bsi-search" placeholder="Наименование" aria-label="Найти позицию"
              value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
            <label className="bsi-only">
              <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} />
              только отмеченные
            </label>
            <button type="button" className="bsi-link" onClick={() => setShown(true)} disabled={!shown.length || saving}>
              отметить {query.trim() || onlyPicked ? 'найденные' : 'все'}
            </button>
            <button type="button" className="bsi-link" onClick={() => setShown(false)} disabled={!shown.length || saving}>
              снять {query.trim() || onlyPicked ? 'у найденных' : 'все'}
            </button>
            {items && <span className="bsi-count">отмечено {picked.size} из {items.length}</span>}
          </div>

          {items === null ? (
            <div className="bsi-empty">Загрузка позиций…</div>
          ) : items.length === 0 && !error ? (
            <div className="bsi-empty">У тендера нет позиций с ценой снабжения (одной во всех ВОР).</div>
          ) : (
            <div className="bsi-table-wrap">
              <table className="bsi-table">
                <thead>
                  <tr>
                    <th className="bsi-c-check"><span className="ui-sr-only">Открыть</span></th>
                    <th>Наименование</th>
                    <th>Ед.</th>
                    <th className="num">Цена снабжения</th>
                    <th className="num">ВОР</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const k = keyOf(r)
                    const on = picked.has(k)
                    return (
                      <tr key={k} className={on ? 'is-picked' : undefined} onClick={() => !saving && toggle(k)}>
                        <td className="bsi-c-check">
                          <input type="checkbox" checked={on} disabled={saving} onChange={() => toggle(k)} onClick={(e) => e.stopPropagation()}
                            aria-label={`Открыть цену: ${r.name}`} />
                        </td>
                        <td>
                          {r.name}
                          {r.taken && <span className="bsi-taken" title="Подрядчик взял эту цену снабжения">взял</span>}
                        </td>
                        <td>{r.unit || '—'}</td>
                        <td className="num">{formatAmount(Number(r.price))}</td>
                        <td className="num">{r.vors || '—'}</td>
                      </tr>
                    )
                  })}
                  {shown.length === 0 && (
                    <tr><td colSpan={5} className="bsi-empty">Ничего не найдено</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="bsi-error" role="alert">{error}</p>}
        </div>

        <div className="bsi-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving || items === null || !changed}>
            {saving ? 'Сохраняем…' : `Сохранить (${picked.size})`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
