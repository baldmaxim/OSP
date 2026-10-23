import { useMemo, useState } from 'react'
import { readBidPriceDoc, BID_DOC_ACCEPT, DOC_ERROR_TEXT, bidGroups, matchBidItems, searchBidGroups } from '../../utils/bidImport'
import { unitPriceWithVat, DEFAULT_VAT_RATE } from '../../utils/supplierDoc'
import { formatAmount } from '../../utils/money'
import { BID_KIND_LABEL } from '../../utils/bidVor'

// «Цены из файла»: подрядчик загружает свой прайс («базу расценок»), КП, счёт или заполненный ВОР — строки с
// ценами сопоставляются с позициями расценки (сначала точно по наименованию, затем самые похожие), человек
// проверяет каждое сопоставление, может выбрать другую позицию или снять. Цена в расценку — за единицу с НДС по
// ставке подрядчика из анкеты (vat); «Без НДС» — цены файла как есть. Своя уже введённая цена заменяется только по
// отметке.

const MAX_FILE_MB = 25
const pct = (score) => `${Math.round(score * 100)} %`
const KIND_SHORT = { material: 'мат.', work: 'раб.' }

export default function BidImportDialog({ positions, rates, vat: ownVat = null, onApply, onClose }) {
  const groups = useMemo(() => bidGroups(positions), [positions])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [doc, setDoc] = useState(null) // { fileName, items, vat, sheetName, pages }
  const [rows, setRows] = useState([]) // [{ item, match, candidates, on }]
  // Подрядчик без НДС — цены файла как есть; иначе НДС сверху — по его ставке из анкеты.
  const [vatMode, setVatMode] = useState(ownVat?.exempt ? 'gross' : 'auto') // auto | gross | net
  const [vatRate, setVatRate] = useState(ownVat && !ownVat.exempt && ownVat.rate ? ownVat.rate : DEFAULT_VAT_RATE)
  const [searchRow, setSearchRow] = useState(null)
  const [query, setQuery] = useState('')

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    if (file.size > MAX_FILE_MB * 1024 * 1024) { setError(`Файл больше ${MAX_FILE_MB} МБ.`); return }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const res = await readBidPriceDoc(bytes, file.name)
      if (res.error) { setError(DOC_ERROR_TEXT[res.error] || 'Файл не распознан.'); return }
      const matched = matchBidItems(res.items, groups)
      setDoc({ fileName: file.name, ...res })
      setRows(matched.map((m) => ({ ...m, on: !!m.match && rates.get(m.match.group.key)?.price == null })))
      if (res.vat?.rate && !(ownVat && !ownVat.exempt)) setVatRate(res.vat.rate)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const vat = useMemo(() => {
    if (vatMode === 'gross') return { mode: 'gross', rate: vatRate, force: true }
    if (vatMode === 'net') return { mode: 'net', rate: vatRate, force: true }
    return { ...(doc?.vat || {}), rate: doc?.vat?.rate ?? vatRate }
  }, [vatMode, vatRate, doc])

  const priceOf = (item) => {
    const p = unitPriceWithVat(item, vat)
    return p == null ? null : Math.round(p * 100) / 100
  }

  const setRow = (i, patch) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const chooseGroup = (i, group) => {
    const own = group ? rates.get(group.key)?.price : null
    setRow(i, { match: group ? { group, score: 1, exact: false, manual: true } : null, on: !!group && own == null })
    setSearchRow(null)
    setQuery('')
  }

  // Одна позиция — одной строке: выбранная в другой строке недоступна.
  const usedBy = useMemo(() => {
    const m = new Map()
    rows.forEach((r, i) => { if (r.match) m.set(r.match.group.key, i) })
    return m
  }, [rows])

  const toApply = rows.filter((r) => r.on && r.match && priceOf(r.item) != null)
  const matchedCount = rows.filter((r) => r.match).length

  const apply = () => {
    onApply(toApply.map((r) => ({ position: r.match.group.position, patch: { price: priceOf(r.item), source: 'import' } })))
  }

  const searchResults = searchRow != null && query.trim() ? searchBidGroups(query, groups, rows[searchRow]?.item.kindHint || null) : []

  return (
    <div className="bid-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="bid-modal" role="dialog" aria-modal="true" aria-label="Цены из файла">
        <header className="bid-modal-head">
          <div>
            <h3>Цены из файла</h3>
            <p className="bid-muted">Ваш прайс, КП, счёт или заполненный ВОР: Excel, CSV или PDF с текстом.</p>
          </div>
          <button type="button" className="bid-modal-close" onClick={onClose} aria-label="Закрыть" disabled={busy}>×</button>
        </header>

        <div className="bid-modal-body">
          <div className="bid-import-file">
            <label className={`cab-btn cab-btn-primary${busy ? ' is-busy' : ''}`}>
              {busy ? 'Читаем файл…' : doc ? 'Другой файл' : 'Выбрать файл'}
              <input type="file" accept={BID_DOC_ACCEPT} hidden disabled={busy} onChange={onFile} />
            </label>
            {doc && (
              <span className="bid-muted">
                {doc.fileName}{doc.sheetName ? ` · лист ${doc.sheetName}` : doc.pages ? ` · страниц: ${doc.pages}` : ''} · строк с ценой: {doc.items.length}
              </span>
            )}
          </div>
          {error && <div className="bid-note is-warn">{error}</div>}

          {doc && (
            <>
              <div className="bid-filters">
                <label className="bid-check">
                  НДС:{' '}
                  <select className="bid-select" value={vatMode} onChange={(e) => setVatMode(e.target.value)}>
                    <option value="auto">как в документе{doc.vat?.mode === 'net' ? ' (без НДС — добавим)' : doc.vat?.mode === 'gross' ? ' (с НДС)' : doc.vat?.mode === 'none' ? ' (не облагается)' : ''}</option>
                    <option value="gross">{ownVat?.exempt ? 'как есть (вы без НДС)' : 'цены с НДС — как есть'}</option>
                    <option value="net">цены без НДС — добавить НДС</option>
                  </select>
                </label>
                {vatMode === 'net' && (
                  <label className="bid-check">
                    ставка{' '}
                    <input type="number" className="bid-num-input" min="0" max="50" step="1" value={vatRate}
                      onChange={(e) => setVatRate(Number(e.target.value) || 0)} /> %
                  </label>
                )}
                <span className="bid-filters-total">сопоставлено {matchedCount} из {rows.length} · поставим цен: {toApply.length}</span>
              </div>

              <div className="bid-table-wrap is-scroll bid-import-wrap">
                <table className="bid-table bid-import-table">
                  <thead>
                    <tr>
                      <th />
                      <th>Строка файла</th>
                      <th className="num">Цена с НДС, ₽</th>
                      <th>Позиция расценки</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const price = priceOf(r.item)
                      const g = r.match?.group
                      const own = g ? rates.get(g.key)?.price : null
                      return (
                        <tr key={i} className={g ? undefined : 'is-empty'}>
                          <td>
                            <input type="checkbox" checked={r.on} disabled={!g || price == null}
                              onChange={(e) => setRow(i, { on: e.target.checked })} aria-label="Поставить цену" />
                          </td>
                          <td className="bid-import-src">
                            <span className="bid-name">{r.item.name}</span>
                            <span className="bid-docs">
                              {[r.item.unit, r.item.qty != null ? `кол-во ${r.item.qty}` : null, r.item.sheet, r.item.source].filter(Boolean).join(' · ')}
                            </span>
                          </td>
                          <td className="num">{price == null ? '—' : formatAmount(price)}</td>
                          <td className="bid-import-target">
                            {searchRow === i ? (
                              <div className="bid-search-box">
                                <input type="search" className="bid-search" autoFocus placeholder="Найти позицию…" value={query}
                                  onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setSearchRow(null) }} />
                                <ul className="bid-search-list">
                                  {searchResults.map((sg) => (
                                    <li key={sg.key}>
                                      <button type="button" disabled={usedBy.has(sg.key) && usedBy.get(sg.key) !== i} onClick={() => chooseGroup(i, sg)}>
                                        <b>{KIND_SHORT[sg.kind]}</b> {sg.name}{sg.unit ? `, ${sg.unit}` : ''}
                                      </button>
                                    </li>
                                  ))}
                                  {query.trim() && !searchResults.length && <li className="bid-muted">не нашлось</li>}
                                </ul>
                                <button type="button" className="bid-link" onClick={() => setSearchRow(null)}>отмена</button>
                              </div>
                            ) : (
                              <>
                                <select
                                  className="bid-select bid-import-select"
                                  value={g?.key || ''}
                                  onChange={(e) => {
                                    if (e.target.value === '__search') { setSearchRow(i); setQuery(r.item.name.split(/\s+/).slice(0, 2).join(' ')); return }
                                    chooseGroup(i, groups.find((x) => x.key === e.target.value) || null)
                                  }}
                                >
                                  <option value="">— не ставить —</option>
                                  {g && !r.candidates.some((c) => c.group.key === g.key) && (
                                    <option value={g.key}>{KIND_SHORT[g.kind]} {g.name}{g.unit ? `, ${g.unit}` : ''}</option>
                                  )}
                                  {r.candidates.map((c) => (
                                    <option key={c.group.key} value={c.group.key} disabled={usedBy.has(c.group.key) && usedBy.get(c.group.key) !== i}>
                                      {KIND_SHORT[c.group.kind]} {c.group.name}{c.group.unit ? `, ${c.group.unit}` : ''}{c.exact ? '' : ` (похоже на ${pct(c.score)})`}
                                    </option>
                                  ))}
                                  <option value="__search">другая позиция…</option>
                                </select>
                                {g && own != null && (
                                  <span className="bid-docs">
                                    {r.on ? `заменит вашу цену ${formatAmount(own)} ₽` : `ваша цена ${formatAmount(own)} ₽ — отметьте, чтобы заменить`}
                                  </span>
                                )}
                                {g && !r.match.exact && !r.match.manual && <span className="bid-docs">{BID_KIND_LABEL[g.kind]}: проверьте, та ли это позиция</span>}
                              </>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <footer className="bid-modal-foot">
          <button type="button" className="cab-btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button type="button" className="cab-btn cab-btn-primary" onClick={apply} disabled={!toApply.length}>
            Поставить цены{toApply.length ? `: ${toApply.length}` : ''}
          </button>
        </footer>
      </div>
    </div>
  )
}
