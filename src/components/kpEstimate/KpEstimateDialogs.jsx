// Окна сметы КП / ПЗ: история изменений, паспорт и коэффициенты, выгрузка в Excel, распределение выделенного в тендер.
import { useCallback, useEffect, useState } from 'react'
import { describeLogEntry, fmtLogTime } from '../../utils/kpEstimateLog'
import { fmtMoney } from '../../utils/kpEstimate'
import { loadLog } from '../../services/kpEstimate'

function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="kpe-modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`kpe-modal${wide ? ' kpe-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="kpe-modal-head">
          <h3>{title}</h3>
          <button type="button" className="kpe-icon-btn" aria-label="Закрыть" onClick={onClose}>✕</button>
        </header>
        <div className="kpe-modal-body">{children}</div>
        {footer && <footer className="kpe-modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

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
            {estimate.kp_file_name && <tr><th>Файл КП</th><td>{estimate.kp_file_name}{meta.kp_file?.sheet ? `, лист «${meta.kp_file.sheet}»` : ''}</td></tr>}
            {estimate.pz_file_name && <tr><th>Файл сметы ПЗ</th><td>{estimate.pz_file_name}{meta.pz_file?.sheet ? `, лист «${meta.pz_file.sheet}»` : ''}</td></tr>}
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

// Выгрузка: что (выделенное, найденное, всё) и какие листы.
export function ExportDialog({ counts, onClose, onExport }) {
  const [scope, setScope] = useState(counts.selected ? 'selected' : (counts.found !== null ? 'found' : 'all'))
  const [sheets, setSheets] = useState({ kp: true, pz: true, mastering: true, allocations: true, coefficients: true, passport: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = (k) => setSheets((s) => ({ ...s, [k]: !s[k] }))
  const run = async () => {
    setBusy(true)
    setError('')
    try { await onExport({ scope, sheets }); onClose() } catch (e) { setError(e.message || String(e)); setBusy(false) }
  }
  return (
    <Modal title="Выгрузка в Excel" onClose={onClose}
      footer={<><button type="button" className="kpe-btn" onClick={onClose}>Отмена</button>
        <button type="button" className="kpe-btn kpe-btn--primary" disabled={busy || !Object.values(sheets).some(Boolean)} onClick={run}>{busy ? 'Собираем…' : 'Выгрузить'}</button></>}>
      <fieldset className="kpe-fieldset">
        <legend>Строки</legend>
        <label><input type="radio" name="kpe-scope" checked={scope === 'selected'} disabled={!counts.selected} onChange={() => setScope('selected')} /> Выделенные ({counts.selected})</label>
        <label><input type="radio" name="kpe-scope" checked={scope === 'found'} disabled={counts.found === null} onChange={() => setScope('found')} /> Найденные поиском и фильтрами{counts.found !== null ? ` (${counts.found})` : ''}</label>
        <label><input type="radio" name="kpe-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> Вся смета ({counts.all})</label>
        <p className="kpe-small kpe-muted">Группы над выбранными строками выгружаются тоже — для структуры и сумм (SUBTOTAL).</p>
      </fieldset>
      <fieldset className="kpe-fieldset">
        <legend>Листы</legend>
        {[['kp', 'КП (с формулами Кол-во × цена и SUBTOTAL)'], ['pz', 'Смета ПЗ (с формулами «Забрано», «Остаток», «Статус»)'], ['mastering', 'Освоение (распределения в рублях)'],
          ['allocations', 'Распределение (тендеры, подрядчики, договоры)'], ['coefficients', 'Коэффициенты'], ['passport', 'Паспорт']].map(([k, label]) => (
          <label key={k}><input type="checkbox" checked={sheets[k]} onChange={() => toggle(k)} /> {label}</label>
        ))}
      </fieldset>
      {error && <div className="kpe-warn">{error}</div>}
    </Modal>
  )
}

// Распределить свободный остаток выделенных позиций в тендер.
export function TenderBulkDialog({ count, pickers, onClose, onApply, preview }) {
  const [tenderId, setTenderId] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const tenders = pickers?.tenders || []
  const t = tenders.find((x) => x.id === tenderId)
  const target = t ? { tender_id: t.id, tender_label: `№ ${t.public_tender_number ?? '—'}` } : (manual.trim() ? { tender_id: null, tender_label: manual.trim() } : null)
  const plan = target ? preview(target) : null
  return (
    <Modal title="Распределить в тендер" onClose={onClose}
      footer={<><button type="button" className="kpe-btn" onClick={onClose}>Отмена</button>
        <button type="button" className="kpe-btn kpe-btn--primary" disabled={busy || !plan || !(plan.inserts.length + plan.updates.length)}
          onClick={async () => { setBusy(true); setError(''); try { await onApply(target); onClose() } catch (e) { setError(e.message || String(e)); setBusy(false) } }}>
          {busy ? 'Распределяем…' : 'Распределить'}</button></>}>
      <p>Выделено строк: {count}. Каждой позиции в тендер уйдёт её свободный остаток (без превышения); позиции без остатка пропускаются.</p>
      <label className="kpe-block-label">Тендер объекта
        <select className="kpe-field" value={tenderId} onChange={(e) => { setTenderId(e.target.value); setManual('') }} aria-label="Тендер">
          <option value="">— выберите —</option>
          {tenders.map((x) => <option key={x.id} value={x.id}>№ {x.public_tender_number ?? '—'}{x.work_description ? ` — ${String(x.work_description).slice(0, 90)}` : ''}</option>)}
        </select>
      </label>
      <label className="kpe-block-label">или вручную (тендера нет в портале)
        <input className="kpe-field" value={manual} onChange={(e) => { setManual(e.target.value); setTenderId('') }} placeholder="№ тендера, лот" aria-label="Тендер вручную" />
      </label>
      {plan && (
        <p className="kpe-note-box">Будет распределено позиций: {plan.inserts.length + plan.updates.length}
          {plan.updates.length ? ` (у ${plan.updates.length} увеличится объём уже взятого в этот тендер)` : ''}{plan.skipped.length ? `; без остатка — ${plan.skipped.length}` : ''}.</p>
      )}
      {error && <div className="kpe-warn">{error}</div>}
    </Modal>
  )
}

export { Modal }
