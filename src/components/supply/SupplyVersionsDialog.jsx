import { useEffect, useRef, useState } from 'react'
import { loadRevisionDetail, loadRevisionHistory } from '../../services/supplyPricing'
import { revisionCounts, revisionTitle } from '../../utils/supplyVorVersions'
import { formatAmount, roundMoney } from '../../utils/money'
import { fmtPriceDate } from '../../utils/supplyRateHelpers'
import { IconFileSpreadsheet } from '../icons/BsmIcons'

// История версий ВОР тендера (миграция 20261029): когда и что сметный отдел менял в ВОР, кто смотрел изменения, и по
// каждой версии — что изменилось в позициях и цены ВОР на тот момент («старые расценки»: снимок пишет база, его
// не меняет ни новая версия, ни правка цен). Снимок можно выгрузить в Excel.
const VOLUME_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 })
const fmtVolume = (v) => (v == null || v === '' ? '—' : VOLUME_FMT.format(Number(v)))
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const KIND = { update: 'ВОР обновлён', added: 'Новый ВОР', removed: 'Файл удалён' }
const OP = { added: 'новая позиция', removed: 'убрана', volume: 'объём', unit: 'ед. изм.' }
const money = (v) => (v == null ? '—' : formatAmount(Number(v)))
// Сумма позиции в снимке: записанная базой, иначе цена × прежний объём.
const snapTotal = (p) => (p.total != null ? Number(p.total) : p.price != null && p.volume != null ? roundMoney(Number(p.price) * Number(p.volume)) : null)

export default function SupplyVersionsDialog({ mainId, nameOf, tenderNumber, onClose }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')
  const closeRef = useRef(null)
  // Фокус — один раз при открытии: панель расценки под окном перерисовывается (опрос), фокус не должен прыгать.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let alive = true
    loadRevisionHistory(mainId)
      .then((rows) => { if (alive) setList(rows) })
      .catch((e) => { if (alive) setError(e.message || 'История не загрузилась') })
    return () => { alive = false }
  }, [mainId])

  useEffect(() => {
    if (!openId) { setDetail(null); return undefined }
    let alive = true
    setDetail(null)
    setDetailError('')
    loadRevisionDetail(openId)
      .then((d) => { if (alive) setDetail(d) })
      .catch((e) => { if (alive) setDetailError(e.message || 'Версия не загрузилась') })
    return () => { alive = false }
  }, [openId])

  const exportPrices = async () => {
    if (!detail) return
    let XLSX
    try { XLSX = await import('xlsx') } catch (e) { setDetailError(`Выгрузка не открылась: ${e.message}`); return }
    const wb = XLSX.utils.book_new()
    const prices = [['Наименование', 'Ед. изм.', 'Объём (прежний)', 'Цена за ед. с доставкой и НДС, ₽', 'Итого, ₽', 'Дата цены'],
      ...(detail.prices || []).map((p) => [p.name, p.unit || '', p.volume ?? '', p.price != null ? Number(p.price) : '', snapTotal(p) ?? '', fmtPriceDate(p.date)])]
    const changes = [['Изменение', 'Наименование', 'Было: ед. изм.', 'Было: объём', 'Стало: ед. изм.', 'Стало: объём', 'Цена тогда, ₽'],
      ...(detail.changes || []).map((c) => [OP[c.op] || c.op, c.name, c.old_unit || '', c.old_volume ?? '', c.unit || '', c.volume ?? '', c.price != null ? Number(c.price) : ''])]
    for (const [aoa, name, cols] of [[prices, 'Цены прежней версии', [60, 10, 14, 16, 16, 12]], [changes, 'Что изменилось', [16, 60, 12, 12, 12, 12, 14]]]) {
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws['!cols'] = cols.map((wch) => ({ wch }))
      XLSX.utils.book_append_sheet(wb, ws, name)
    }
    const day = new Date(detail.created_at).toLocaleDateString('ru-RU')
    XLSX.writeFile(wb, `Цены ВОР ${detail.estimate_name} до ${day}_№${tenderNumber ?? ''}.xlsx`.replace(/[\\/:*?"<>|]/g, ' '))
  }

  const who = (r) => r.uploaded_by_name || (r.created_by ? nameOf(r.created_by) : null)
  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sp-modal sp-modal-versions" role="dialog" aria-modal="true" aria-labelledby="sp-versions-title">
        <h3 id="sp-versions-title">Версии ВОР</h3>
        <div className="sp-modal-body">
          <p className="sp-muted">
            Когда сметный отдел менял ВОР и что изменилось. У каждой версии сохранены цены ВОР на момент изменения — они не
            меняются, даже если цену потом исправили или удалили.
          </p>
          {error && <p className="sp-error-text">{error}</p>}
          {!error && list === null && <p className="sp-muted">Загрузка…</p>}
          {list?.length === 0 && <p>Изменений ВОР пока не было.</p>}
          {list?.length > 0 && (
            <ul className="sp-versions">
              {list.map((r) => (
                <li key={r.id} className={openId === r.id ? 'is-open' : undefined}>
                  <button type="button" className="sp-versions-item" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                    <span className="sp-versions-head">
                      <span className="ui-num">{fmtTime(r.created_at)}</span>
                      <b>ВОР «{r.estimate_name}»</b>
                      <span className={`sp-versions-kind is-${r.kind}`}>{KIND[r.kind] || r.kind}</span>
                      {!r.reviewed_at && <span className="sp-versions-new">не просмотрено</span>}
                    </span>
                    <span className="sp-versions-text">{revisionTitle(r)}</span>
                    <span className="sp-muted">
                      {who(r) ? `загрузил(а) ${who(r)}` : 'загружено автоматически'}
                      {r.reviewed_at ? ` · просмотрено ${fmtTime(r.reviewed_at)}${r.reviewed_by && nameOf(r.reviewed_by) ? `, ${nameOf(r.reviewed_by)}` : ''}` : ''}
                    </span>
                  </button>
                  {openId === r.id && (
                    <div className="sp-versions-detail">
                      {detailError && <p className="sp-error-text">{detailError}</p>}
                      {!detail && !detailError && <p className="sp-muted">Загрузка…</p>}
                      {detail && (
                        <>
                          {detail.changes?.length > 0 && (
                            <>
                              <h4>Что изменилось{revisionCounts(detail) ? `: ${revisionCounts(detail)}` : ''}</h4>
                              <div className="table-container sp-versions-table">
                                <table className="data-table">
                                  <thead>
                                    <tr><th>Изменение</th><th>Наименование</th><th>Было</th><th>Стало</th><th className="ui-money">Цена тогда, ₽</th></tr>
                                  </thead>
                                  <tbody>
                                    {detail.changes.map((c, i) => (
                                      <tr key={i} className={`is-${c.op}`}>
                                        <td>{OP[c.op] || c.op}</td>
                                        <td>{c.name}</td>
                                        <td className="ui-num">{c.op === 'added' ? '—' : `${fmtVolume(c.old_volume)} ${c.old_unit || ''}`}</td>
                                        <td className="ui-num">{c.op === 'removed' ? '—' : `${fmtVolume(c.volume)} ${c.unit || ''}`}</td>
                                        <td className="ui-money">{money(c.price)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                          {detail.prices?.length > 0 ? (
                            <>
                              <h4 className="sp-versions-prices">
                                Цены ВОР до изменения: <span className="ui-num">{detail.prices.length}</span>
                                <button type="button" className="sp-link-btn" onClick={exportPrices}><IconFileSpreadsheet size={14} /> Скачать Excel</button>
                              </h4>
                              <div className="table-container sp-versions-table">
                                <table className="data-table">
                                  <thead>
                                    <tr><th>Наименование</th><th>Ед. изм.</th><th className="ui-money">Объём</th><th className="ui-money">Цена за ед., ₽</th><th className="ui-money">Итого, ₽</th><th>Дата цены</th></tr>
                                  </thead>
                                  <tbody>
                                    {detail.prices.map((p) => (
                                      <tr key={p.rate_id || p.name}>
                                        <td>{p.name}{p.source_kind ? <span className="sp-muted"> · из другого тендера</span> : null}</td>
                                        <td>{p.unit || '—'}</td>
                                        <td className="ui-money">{fmtVolume(p.volume)}</td>
                                        <td className="ui-money">{money(p.price)}</td>
                                        <td className="ui-money">{money(snapTotal(p))}</td>
                                        <td className="ui-num">{fmtPriceDate(p.date) || '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          ) : detail.kind === 'update' && <p className="sp-muted">Цен в ВОР до этого изменения не было.</p>}
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="sp-modal-actions">
          <button ref={closeRef} type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
