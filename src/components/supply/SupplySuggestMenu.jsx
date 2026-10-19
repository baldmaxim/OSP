import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isWebLink, loadRateSuggestions } from '../../services/supplyPricing'
import { formatAmount } from '../../utils/money'
import { fmtPriceDate } from '../../utils/supplyRateHelpers'

// Меню похожих цен позиции (миграция 20261023): расценки снабжения других тендеров (и других ВОР этого) с похожим
// наименованием, той же ед. изм., не старше 3 месяцев — от самых недавних. «Взять» — цена за единицу в позицию с
// отметкой, откуда она; документ исходной позиции прикладывается, если у позиции своего нет. Без права правки —
// только просмотр. Поверх страницы (портал): прокрутка таблицы его не обрезает; прокрутили или кликнули мимо —
// закрывается. Клавиатура: стрелки — по строкам, Enter — взять, Esc — закрыть.
export default function SupplySuggestMenu({ anchor, mainId, row, editable, currentSourceId = null, onPick, onClose }) {
  const [state, setState] = useState({ loading: true, rows: [], error: '' })
  const [pos, setPos] = useState(null)
  const menuRef = useRef(null)
  const unit = row.p.unit || ''

  useEffect(() => {
    let alive = true
    loadRateSuggestions(mainId, { estimateName: row.doc, name: row.p.name, unit: row.p.unit })
      .then((rows) => { if (alive) setState({ loading: false, rows: rows || [], error: rows == null ? 'Подбор цен из других тендеров ещё не включён на сервере.' : '' }) })
      .catch((e) => { if (alive) setState({ loading: false, rows: [], error: e.message || 'Не удалось загрузить похожие цены' }) })
    return () => { alive = false }
  }, [mainId, row.doc, row.p.name, row.p.unit])

  // Под кнопкой, а если внизу мало места — над ней; не шире окна.
  const place = useCallback(() => {
    if (!anchor?.isConnected) return
    const r = anchor.getBoundingClientRect()
    const width = Math.min(36 * 16, window.innerWidth - 32)
    const h = menuRef.current?.offsetHeight || 240
    const below = window.innerHeight - r.bottom
    const top = below < h + 12 && r.top > below ? Math.max(8, r.top - h - 4) : r.bottom + 4
    setPos({ top, left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)), width })
  }, [anchor])
  useLayoutEffect(() => { place() }, [place, state])

  useEffect(() => {
    const inside = (t) => menuRef.current?.contains(t) || anchor?.contains(t)
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose(true)
    }
    const onDown = (e) => { if (!inside(e.target)) onClose(false) }
    const onScroll = (e) => { if (!menuRef.current?.contains(e.target)) onClose(false) }
    const onResize = () => onClose(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor, onClose])

  // Фокус — на первую строку, когда список пришёл.
  useEffect(() => {
    if (!state.loading) (menuRef.current?.querySelector('[data-item]') || menuRef.current)?.focus()
  }, [state.loading])

  const onListKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll('[data-item]') || [])]
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1)
    items[next].focus()
  }

  const title = `Похожие цены: ${row.p.name}`
  return createPortal(
    <div
      ref={menuRef}
      className="sp-suggest"
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden' }}
      onKeyDown={onListKey}
    >
      <div className="sp-suggest-head">
        <span className="sp-suggest-title">Цены похожих позиций</span>
        <span className="sp-muted">та же ед. изм. ({unit || '—'}), не старше 3 месяцев, сначала новые</span>
      </div>
      {state.loading && <p className="sp-suggest-empty">Ищем похожие цены…</p>}
      {state.error && <p className="sp-suggest-empty sp-error-text" role="alert">{state.error}</p>}
      {!state.loading && !state.error && !state.rows.length && (
        <p className="sp-suggest-empty">Похожих цен не старше 3 месяцев нет.</p>
      )}
      {state.rows.length > 0 && (
        <ul className="sp-suggest-list">
          {state.rows.map((s) => {
            const current = s.rate_id === currentSourceId
            const take = () => { if (editable && !current) onPick(s) }
            return (
              <li
                key={s.rate_id}
                data-item=""
                tabIndex={-1}
                className={current ? 'is-current' : undefined}
                onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); take() } }}
                aria-label={`${s.material_name}, ${formatAmount(s.unit_price)} ₽ за ${s.unit || 'ед.'}, ${fmtPriceDate(s.price_date)}`}
              >
                <div className="sp-suggest-info">
                  <span className="sp-suggest-name">
                    {s.material_name}
                    {s.same_name && <span className="sp-suggest-tag">то же наименование</span>}
                    {current && <span className="sp-suggest-tag is-current">сейчас в позиции</span>}
                  </span>
                  <span className="sp-suggest-meta">
                    <span>{s.tender_number != null ? `тендер № ${s.tender_number}` : 'тендер без номера'}</span>
                    {s.object_name && <span>{s.object_name}</span>}
                    <span>ВОР «{s.estimate_name}»</span>
                    <span className="ui-num">{fmtPriceDate(s.price_date)}</span>
                    {s.url && (isWebLink(s.url)
                      ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="link" title={s.url}>документ: Открыть</a>
                      : <span title={s.url}>документ: сетевой путь</span>)}
                  </span>
                </div>
                <div className="sp-suggest-side">
                  <span className="sp-suggest-price ui-num">{formatAmount(s.unit_price)} ₽<span className="sp-muted"> за {s.unit || 'ед.'}</span></span>
                  {editable && !current && (
                    <button type="button" className="btn-secondary sp-suggest-take" onClick={take}
                      aria-label={`Взять цену ${formatAmount(s.unit_price)} ₽: ${s.material_name}`}>Взять</button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>,
    document.body,
  )
}
