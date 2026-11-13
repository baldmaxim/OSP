// Окна сметы КП / ПЗ: история изменений, паспорт и коэффициенты, распределение выделенных строк (тендер + подрядчик).
import { useCallback, useEffect, useState } from 'react'
import { describeLogEntry, fmtLogTime } from '../../utils/kpEstimateLog'
import { allocationText, fmtMoney } from '../../utils/kpEstimate'
import { loadLog } from '../../services/kpEstimate'
import { Modal, TenderContractorFields } from './KpEstimateFields'

// История всей сметы: от новых к старым, порциями по 100; фильтр по сотруднику; нажатие на позицию — перейти к ней.
export function HistoryDialog({ estimateId, onClose, onGoto }) {
  const [items, setItems] = useState([])
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [who, setWho] = useState('')
  const more = useCallback(async (before = null) => {
    setLoading(true)
    try {
      const page = await loadLog(estimateId, { beforeId: before, limit: 100 })
      setItems((prev) => (before ? [...prev, ...page] : page))
      setDone(page.length < 100)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [estimateId])
  useEffect(() => { more(null) }, [more])
  const people = [...new Set(items.map((e) => e.changed_by_name).filter(Boolean))].sort()
  const shown = who ? items.filter((e) => e.changed_by_name === who) : items
  return (
    <Modal title="История изменений сметы" onClose={onClose} wide>
      <div className="kpe-history-tools">
        <select className="kpe-field" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Кто изменил">
          <option value="">Все сотрудники</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="kpe-muted">Показано записей: {shown.length}{done ? '' : '+'}</span>
      </div>
      {error && <div className="kpe-warn">{error}</div>}
      <ul className="kpe-log kpe-log--full">
        {shown.map((e) => {
          const d = describeLogEntry(e)
          return (
            <li key={e.id}>
              <div className="kpe-log-head">
                <span className="kpe-muted">{fmtLogTime(e.changed_at)}</span> <b>{e.changed_by_name || '—'}</b>
                {e.row_label && e.row_id && <> · <button type="button" className="kpe-text-btn" onClick={() => onGoto(e.row_id)}>{e.row_label}</button></>}
              </div>
              <div className="kpe-log-title">{d.title}</div>
              {d.lines.map((l, i) => <div key={i} className="kpe-log-line">{l}</div>)}
            </li>
          )
        })}
        {!shown.length && !loading && <li className="kpe-muted">Изменений пока нет.</li>}
      </ul>
      {!done && <button type="button" className="kpe-btn" disabled={loading} onClick={() => more(items[items.length - 1]?.id)}>{loading ? 'Загрузка…' : 'Показать ещё'}</button>}
    </Modal>
  )
}

const cellText = (v) => (typeof v === 'number' ? v.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : (v ?? ''))

// Паспорт, коэффициенты и сверка формул — как в загруженном файле.
export function PassportDialog({ estimate, onClose }) {
  const meta = estimate?.meta || {}
  const fc = meta.formula_check || {}
  return (
    <Modal title="Паспорт и коэффициенты" onClose={onClose} wide>
      <section className="kpe-box">
        <h4>Документ</h4>
        <table className="kpe-plain">
          <tbody>
            <tr><th>Название</th><td>{estimate.title}</td></tr>
            {estimate.kp_file_name && <tr><th>{estimate.pz_file_name && estimate.pz_file_name !== estimate.kp_file_name ? 'Файл КП' : 'Файл'}</th><td>{estimate.kp_file_name}{meta.kp_file?.sheet ? `, лист «${meta.kp_file.sheet}»` : ''}</td></tr>}
            {estimate.pz_file_name && estimate.pz_file_name !== estimate.kp_file_name && <tr><th>Файл сметы ПЗ</th><td>{estimate.pz_file_name}{meta.pz_file?.sheet ? `, лист «${meta.pz_file.sheet}»` : ''}</td></tr>}
            <tr><th>Загрузил(а)</th><td>{estimate.created_by_name || '—'}, {fmtLogTime(estimate.activated_at || estimate.created_at)}</td></tr>
            <tr><th>Строк</th><td>{(estimate.row_count || 0).toLocaleString('ru-RU')}</td></tr>
            {meta.vat && <tr><th>НДС</th><td>{meta.vat}</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="kpe-box">
        <h4>Сверка формул файла</h4>
        {fc.issue_count ? (
          <>
            <p className="kpe-over">Расхождений: {fc.issue_count}{fc.issue_count > (fc.issues || []).length ? ` (показаны первые ${(fc.issues || []).length})` : ''}</p>
            <table className="kpe-plain">
              <thead><tr><th>Строка файла</th><th>Код</th><th>Что</th><th>По формуле</th><th>В файле</th></tr></thead>
              <tbody>{(fc.issues || []).map((x, i) => (
                <tr key={i}><td>{x.row ?? '—'}</td><td>{x.code}</td><td>{{ materials: 'материалы', works: 'работы', total: 'итог' }[x.key] || x.key}</td><td>{fmtMoney(x.expected)}</td><td>{fmtMoney(x.actual)}</td></tr>
              ))}</tbody>
            </table>
          </>
        ) : <p>Расхождений нет: материалы = Кол-во ГП × за ед., работы = Кол-во ГП × за ед., итог = материалы + работы, суммы групп (SUBTOTAL) и ИТОГО совпадают с файлом.</p>}
        {fc.totals && <p className="kpe-muted">Итог КП по позициям: материалы {fmtMoney(fc.totals.materials)} ₽, работы {fmtMoney(fc.totals.works)} ₽, всего {fmtMoney(fc.totals.total)} ₽.</p>}
      </section>
      {meta.passport?.length > 0 && (
        <section className="kpe-box">
          <h4>Паспорт</h4>
          <table className="kpe-plain"><tbody>
            {meta.passport.map((r, i) => (r.length > 1
              ? <tr key={i}><th>{cellText(r[0])}</th><td>{r.slice(1).map(cellText).join(' ')}</td></tr>
              : <tr key={i}><td colSpan={2}><b>{cellText(r[0])}</b></td></tr>))}
          </tbody></table>
        </section>
      )}
      {meta.coefficients?.length > 0 && (
        <section className="kpe-box">
          <h4>Коэффициенты</h4>
          <table className="kpe-plain kpe-plain--grid"><tbody>
            {meta.coefficients.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{cellText(v)}</td>)}</tr>)}
          </tbody></table>
        </section>
      )}
      {[['Вне итога', meta.out_of_total], ['Детализация', meta.detail]].map(([title, rows]) => rows?.length ? (
        <section key={title} className="kpe-box">
          <h4>{title}</h4>
          <table className="kpe-plain kpe-plain--grid"><tbody>
            {rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{cellText(v)}</td>)}</tr>)}
          </tbody></table>
        </section>
      ) : null)}
    </Modal>
  )
}

// Распределить выделенные позиции: каждой — её свободный остаток, тендер (может не быть) и подрядчик-победитель.
export function TenderBulkDialog({ count, pickers, onClose, onApply, preview }) {
  const [draft, setDraft] = useState({ tender_id: null, tender_label: null, counterparty_id: null, counterparty_name: null })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = draft.tender_id || (draft.tender_label || '').trim() || draft.counterparty_id || (draft.counterparty_name || '').trim()
    ? { tender_id: draft.tender_id || null, tender_label: (draft.tender_label || '').trim() || null, counterparty_id: draft.counterparty_id || null, counterparty_name: (draft.counterparty_name || '').trim() || null }
    : null
  const plan = target ? preview(target) : null
  return (
    <Modal title="Распределить выделенное" onClose={onClose}
      footer={<><button type="button" className="kpe-btn" onClick={onClose}>Отмена</button>
        <button type="button" className="kpe-btn kpe-btn--primary" disabled={busy || !plan || !(plan.inserts.length + plan.updates.length)}
          onClick={async () => { setBusy(true); setError(''); try { await onApply(target); onClose() } catch (e) { setError(e.message || String(e)); setBusy(false) } }}>
          {busy ? 'Распределяем…' : 'Распределить'}</button></>}>
      <p>Выделено строк: {count}. Каждой позиции уйдёт её свободный остаток; позиции без остатка пропускаются.</p>
      <div className="kpe-bulk-grid">
        <TenderContractorFields draft={draft} setDraft={setDraft} pickers={pickers} disabled={busy} />
      </div>
      {plan && (
        <p className="kpe-note-box">{allocationText(target)}: позиций — {plan.inserts.length + plan.updates.length}
          {plan.updates.length ? ` (у ${plan.updates.length} объём добавится к уже распределённому этой паре)` : ''}{plan.skipped.length ? `; без остатка — ${plan.skipped.length}` : ''}.</p>
      )}
      {error && <div className="kpe-warn">{error}</div>}
    </Modal>
  )
}
