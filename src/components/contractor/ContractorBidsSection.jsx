import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext'
import {
  loadBidOverview, loadBidRates, loadBidForm, loadFormFields, createFormField, updateFormField, deleteFormField,
  loadCurrentBidRates, BIDS_MIGRATION_HINT, BID_TENDER_DONE,
} from '../../services/contractorBids'
import { formatAmount } from '../../utils/money'
import { useDebounced } from '../../utils/ratesRegistry'
import { FIELD_KINDS, VAT_FIELD_CODE, VAT_OPTIONS, parseOptions } from '../../utils/bidForm'
import './ContractorBidsSection.css'

// Реестр расценок → «Расценки подрядчиков (актуальные тендеры)» (миграция 20261102): цены и анкеты, которые
// подрядчики вводят в кабинете, по тендерам, которые ещё не завершены. Пока только администратору (решение
// пользователя). После завершения тендера расценки по позициям уходят во вкладку «Расценки от подрядчиков (КП)»
// (миграция 20261103, при пересчёте реестра), здесь тендер больше не показывается.
//   • «Тендеры и подрядчики» — кто в каком тендере что расценил, суммы, НДС, анкета; подробности и выгрузка;
//   • «Позиции» — все цены актуальных тендеров списком (поиск, вид);
//   • «Поля анкеты» — «Квалификационная и контактная информация», которую подрядчик заполняет в кабинете.

const fmtDateTime = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}
const fmtVolume = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }))
const money = (v) => (v == null ? '—' : formatAmount(Number(v)))

const PARTICIPATION = {
  request_sent: 'Участник · приглашён',
  proposal_provided: 'Участник · КП',
  accepted_for_work: 'Участник · принят в работу',
  declined: 'Участник · отказался',
}
const REQUEST = { pending: 'Заявка: ждёт решения', accepted: 'Заявка принята', rejected: 'Заявка отклонена' }
const SOURCE = { manual: 'вручную', import: 'из файла', history: 'из прошлого тендера' }

function participationText(r) {
  if (r.invite_status) return PARTICIPATION[r.invite_status] || 'Участник'
  if (r.request_status) return REQUEST[r.request_status] || r.request_status
  return '—'
}

const SUBTABS = [
  ['bids', 'Тендеры и подрядчики'],
  ['positions', 'Позиции'],
  ['fields', 'Поля анкеты'],
]

export default function ContractorBidsSection() {
  const { isAdmin } = useRole()
  const [tab, setTab] = useState('bids')
  if (!isAdmin) return <div className="cbp-state">Расценки подрядчиков по актуальным тендерам видит администратор.</div>
  return (
    <div className="cbp-section">
      <p className="cbp-muted">
        Цены и анкеты, которые подрядчики вводят в кабинете, по тендерам, которые ещё идут. Видно только администратору.
        После завершения тендера расценки по позициям попадают во вкладку «Расценки от подрядчиков (КП)».
      </p>
      <nav className="cbp-tabs" role="tablist">
        {SUBTABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      {tab === 'bids' ? <BidsOverview /> : tab === 'positions' ? <BidPositions /> : <FormFieldsEditor />}
    </div>
  )
}

// ── Сводка ───────────────────────────────────────────────────────────────────────────────────────────
function BidsOverview() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(false)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all') // all | open | priced | pending
  const [open, setOpen] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const data = await loadBidOverview()
      if (data === null) { setMissing(true); setRows([]); return }
      setRows(data)
    } catch (e) {
      setError(e.message || String(e))
      setRows([])
    }
  }, [])
  useEffect(() => { load() }, [load])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows || []).filter((r) => {
      // Завершённый тендер — уже в «Расценках от подрядчиков (КП)».
      if (r.tender_status === BID_TENDER_DONE) return false
      if (scope === 'open' && !r.is_open) return false
      if (scope === 'priced' && !(r.materials_priced + r.works_priced)) return false
      if (scope === 'pending' && r.request_status !== 'pending') return false
      if (!q) return true
      return [r.public_tender_number, r.object_name, r.work_description, r.counterparty_name, r.counterparty_inn]
        .some((v) => String(v ?? '').toLowerCase().includes(q))
    })
  }, [rows, query, scope])

  const totals = useMemo(() => ({
    tenders: new Set(list.map((r) => r.tender_id)).size,
    orgs: new Set(list.map((r) => r.counterparty_id)).size,
    sum: list.reduce((s, r) => s + Number(r.total || 0), 0),
    pending: list.filter((r) => r.request_status === 'pending').length,
  }), [list])

  if (rows === null) return <div className="cbp-state">Загрузка…</div>
  if (missing) return <div className="cbp-state">{BIDS_MIGRATION_HINT}</div>

  return (
    <>
      <div className="cbp-stats">
        <div><b>{totals.tenders}</b><span>тендеров</span></div>
        <div><b>{totals.orgs}</b><span>организаций</span></div>
        <div><b>{formatAmount(totals.sum)} ₽</b><span>сумма расценок</span></div>
        <div><b>{totals.pending}</b><span>заявок ждут решения</span></div>
      </div>
      <div className="cbp-filters">
        <input type="search" className="cbp-input" placeholder="№ тендера, объект, организация, ИНН…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск" />
        <select className="cbp-input" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Отбор">
          <option value="all">Все</option>
          <option value="open">Только идёт приём предложений</option>
          <option value="priced">Только с ценами</option>
          <option value="pending">Заявки ждут решения</option>
        </select>
        <button type="button" className="cbp-btn" onClick={load}>Обновить</button>
      </div>
      {error && <div className="cbp-error">Не загрузилось: {error}</div>}
      {list.length === 0 ? (
        <div className="cbp-state">{rows.length ? 'Ничего не нашлось.' : 'По актуальным тендерам подрядчики пока ничего не расценили на сайте.'}</div>
      ) : (
        <div className="cbp-table-wrap">
          <table className="cbp-table">
            <thead>
              <tr>
                <th>Тендер</th>
                <th>Организация</th>
                <th>Участие</th>
                <th className="num">Материалы</th>
                <th className="num">Работы</th>
                <th className="num">Итого, ₽</th>
                <th>НДС</th>
                <th className="num">Анкета</th>
                <th>Изменено</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={`${r.tender_id}|${r.counterparty_id}`} className="cbp-row" onClick={() => setOpen(r)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r) }}>
                  <td>
                    <span className="cbp-strong">№ {r.public_tender_number ?? '—'}</span>{!r.is_open && <span className="cbp-chip">закрыт</span>}
                    <span className="cbp-sub">{r.object_name || '—'}</span>
                    <span className="cbp-sub cbp-clamp">{r.work_description}</span>
                  </td>
                  <td>
                    <span className="cbp-strong">{r.counterparty_name}</span>
                    {r.counterparty_inn && <span className="cbp-sub">ИНН {r.counterparty_inn}</span>}
                  </td>
                  <td className={r.request_status === 'pending' && !r.invite_status ? 'cbp-wait' : undefined}>{participationText(r)}</td>
                  <td className="num">{r.materials_priced}<span className="cbp-sub">{money(r.materials_total)}</span></td>
                  <td className="num">{r.works_priced}<span className="cbp-sub">{money(r.works_total)}</span></td>
                  <td className="num cbp-strong">{money(r.total)}</td>
                  <td className={r.vat ? 'cbp-date' : 'cbp-wait'}>{r.vat || 'не указан'}</td>
                  <td className="num">{r.form_answers || '—'}</td>
                  <td className="cbp-date">{fmtDateTime(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <BidDetail row={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function BidDetail({ row, onClose }) {
  const [rates, setRates] = useState(null)
  const [form, setForm] = useState(null)
  const [kind, setKind] = useState('material')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([loadBidRates(row.tender_id, row.counterparty_id), loadBidForm(row.tender_id, row.counterparty_id)])
      .then(([r, f]) => { if (!cancelled) { setRates(r); setForm(f) } })
      .catch((e) => { if (!cancelled) { setRates([]); setError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [row])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = (rates || []).filter((r) => (kind === 'form' ? false : r.kind === kind))
  const answers = Object.values(form?.answers || {})
  const exportExcel = async () => {
    const { downloadRatesWorkbook } = await import('../../utils/bidExport')
    downloadRatesWorkbook({ row, rates: rates || [], form })
  }

  return (
    <div className="cbp-drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="cbp-drawer" role="dialog" aria-modal="true" aria-label="Расценка организации">
        <header className="cbp-drawer-head">
          <div>
            <h2>{row.counterparty_name}</h2>
            <p className="cbp-muted">
              <Link to={`/tenders/${row.tender_id}`}>Тендер № {row.public_tender_number ?? '—'}</Link> · {row.object_name || '—'} · {participationText(row)}
            </p>
            <p className="cbp-muted">
              Материалы: {row.materials_priced} · {money(row.materials_total)} ₽ · Работы: {row.works_priced} · {money(row.works_total)} ₽ ·
              Итого: <b>{money(row.total)} ₽</b> · НДС: {row.vat || 'не указан'}
            </p>
          </div>
          <div className="cbp-drawer-actions">
            <button type="button" className="cbp-btn" onClick={exportExcel} disabled={!rates}>Скачать Excel</button>
            <button type="button" className="cbp-close" onClick={onClose} aria-label="Закрыть">×</button>
          </div>
        </header>
        <nav className="cbp-tabs cbp-tabs-sm">
          {[['material', `Материалы (${(rates || []).filter((r) => r.kind === 'material').length})`],
            ['work', `Работы (${(rates || []).filter((r) => r.kind === 'work').length})`],
            ['form', `Анкета (${answers.length})`]].map(([k, label]) => (
            <button key={k} type="button" className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>{label}</button>
          ))}
        </nav>
        <div className="cbp-drawer-body">
          {error && <div className="cbp-error">{error}</div>}
          {rates === null ? (
            <div className="cbp-state">Загрузка…</div>
          ) : kind === 'form' ? (
            answers.length === 0 ? <div className="cbp-state">Анкета не заполнена.</div> : (
              <dl className="cbp-answers">
                {answers.map((a, i) => (
                  <div key={i}><dt>{a.label}</dt><dd>{a.value}</dd></div>
                ))}
              </dl>
            )
          ) : shown.length === 0 ? (
            <div className="cbp-state">Цен этого вида нет.</div>
          ) : (
            <table className="cbp-table cbp-table-detail">
              <thead>
                <tr>
                  <th>Наименование</th><th>Ед. изм.</th><th className="num">Объём</th><th className="num">Цена за ед., ₽</th>
                  <th className="num">Сумма, ₽</th><th>Примечание</th><th>Как введена</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.unit || '—'}</td>
                    <td className="num">{fmtVolume(r.volume)}</td>
                    <td className="num">{money(r.price)}</td>
                    <td className="num">{money(r.total)}</td>
                    <td>{r.note || ''}</td>
                    <td className="cbp-date">{SOURCE[r.source] || r.source}<span className="cbp-sub">{fmtDateTime(r.updated_at)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </div>
  )
}

// ── Позиции ──────────────────────────────────────────────────────────────────────────────────────────
const POSITIONS_PAGE = 100

function BidPositions() {
  const [kind, setKind] = useState('material')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search, 400)
  const [page, setPage] = useState(0)
  const [data, setData] = useState(null) // { rows, count } | null — загрузка
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setPage(0) }, [kind, debouncedSearch])
  useEffect(() => {
    let cancelled = false
    setError('')
    loadCurrentBidRates({ kind, search: debouncedSearch, page, pageSize: POSITIONS_PAGE })
      .then((res) => {
        if (cancelled) return
        if (res === null) { setMissing(true); setData({ rows: [], count: 0 }); return }
        setData(res)
      })
      .catch((e) => { if (!cancelled) { setError(e.message || String(e)); setData({ rows: [], count: 0 }) } })
    return () => { cancelled = true }
  }, [kind, debouncedSearch, page])

  if (missing) return <div className="cbp-state">{BIDS_MIGRATION_HINT}</div>
  const pages = data ? Math.max(1, Math.ceil(data.count / POSITIONS_PAGE)) : 1
  return (
    <>
      <div className="cbp-filters">
        <input type="search" className="cbp-input" placeholder="Наименование позиции…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Поиск по наименованию" />
        <select className="cbp-input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Вид">
          <option value="material">Материалы</option>
          <option value="work">Работы</option>
        </select>
        {data && <span className="cbp-muted">Найдено: {data.count}</span>}
      </div>
      {error && <div className="cbp-error">Не загрузилось: {error}</div>}
      {!data ? (
        <div className="cbp-state">Загрузка…</div>
      ) : data.rows.length === 0 ? (
        <div className="cbp-state">{debouncedSearch ? 'Ничего не нашлось.' : 'Цен по актуальным тендерам пока нет.'}</div>
      ) : (
        <>
          <div className="cbp-table-wrap">
            <table className="cbp-table">
              <thead>
                <tr>
                  <th>Наименование</th><th>Ед. изм.</th><th className="num">Объём</th><th className="num">Цена за ед., ₽</th>
                  <th className="num">Сумма, ₽</th><th>Подрядчик</th><th>Тендер</th><th>Изменено</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}{r.note && <span className="cbp-sub">{r.note}</span>}</td>
                    <td>{r.unit || '—'}</td>
                    <td className="num">{fmtVolume(r.volume)}</td>
                    <td className="num cbp-strong">{money(r.price)}</td>
                    <td className="num">{money(r.total)}</td>
                    <td>{r.counterparties?.name || '—'}</td>
                    <td>
                      <Link to={`/tenders/${r.tender_id}`}>№ {r.tenders?.public_tender_number ?? '—'}</Link>
                      <span className="cbp-sub cbp-clamp">{r.tenders?.work_description}</span>
                    </td>
                    <td className="cbp-date">{fmtDateTime(r.updated_at)}<span className="cbp-sub">{SOURCE[r.source] || r.source}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="cbp-pager">
              <button type="button" className="cbp-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Назад</button>
              <span className="cbp-muted">Страница {page + 1} из {pages}</span>
              <button type="button" className="cbp-btn" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Вперёд</button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Поля анкеты ──────────────────────────────────────────────────────────────────────────────────────
function FormFieldsEditor() {
  const [fields, setFields] = useState(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({ label: '', hint: '', kind: 'text', options: '' })
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await loadFormFields({ all: true })
      setMissing(list === null)
      setFields(list || [])
    } catch (e) {
      setError(e.message || String(e))
      setFields([])
    }
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (fn) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  if (fields === null) return <div className="cbp-state">Загрузка…</div>
  if (missing) return <div className="cbp-state">{BIDS_MIGRATION_HINT}</div>

  const draftOptions = parseOptions(draft.options)
  const canAdd = !!draft.label.trim() && (draft.kind !== 'select' || draftOptions.length > 0)
  const add = () => {
    const label = draft.label.trim()
    if (!canAdd) return
    const max = fields.reduce((m, f) => Math.max(m, f.sort_order || 0), 0)
    run(async () => {
      await createFormField({ label, hint: draft.hint.trim(), kind: draft.kind, options: draftOptions, sort_order: max + 10 })
      setDraft({ label: '', hint: '', kind: 'text', options: '' })
    })
  }
  // Перестановка — обменом порядковых номеров с соседом.
  const move = (i, dir) => {
    const a = fields[i]
    const b = fields[i + dir]
    if (!a || !b) return
    const ao = a.sort_order === b.sort_order ? a.sort_order + dir : b.sort_order
    run(async () => {
      await updateFormField(a.id, { sort_order: ao })
      await updateFormField(b.id, { sort_order: a.sort_order })
    })
  }

  return (
    <div className="cbp-fields">
      <p className="cbp-muted">
        Подрядчик видит поля в кабинете, в разделе «Анкета» расценки тендера. Скрытое поле не показывается, а уже данные
        ответы на него сохраняются. Переименование не меняет ответов, данных раньше: у них остаётся прежняя подпись.
        Поле «выбор из списка» — как выпадающий список в Excel: подрядчик выбирает один из вариантов. Ставка НДС
        участвует в итогах расценки — её не удалить и не скрыть, варианты можно поправить.
      </p>
      {error && <div className="cbp-error">{error}</div>}
      <ol className="cbp-field-list">
        {fields.map((f, i) => (
          <FieldRow key={`${f.id}|${f.updated_at}`} field={f} first={i === 0} last={i === fields.length - 1} busy={busy}
            onSave={(patch) => run(() => updateFormField(f.id, patch))}
            onMove={(dir) => move(i, dir)}
            onDelete={() => { if (window.confirm(`Удалить поле «${f.label}»? Ответы, уже данные подрядчиками, останутся в их анкетах.`)) run(() => deleteFormField(f.id)) }}
          />
        ))}
      </ol>
      <div className="cbp-field-add">
        <input className="cbp-input" placeholder="Новое поле, например «Опыт аналогичных работ»" value={draft.label} maxLength={500}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <input className="cbp-input" placeholder="Подсказка (необязательно), например «да / нет»" value={draft.hint} maxLength={500}
          onChange={(e) => setDraft((d) => ({ ...d, hint: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <select className="cbp-input" value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))} aria-label="Тип поля">
          {Object.entries(FIELD_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button type="button" className="cbp-btn cbp-btn-primary" onClick={add} disabled={busy || !canAdd}>Добавить поле</button>
        {draft.kind === 'select' && (
          <textarea className="cbp-input cbp-options" rows={3} placeholder="Варианты — каждый с новой строки, например: да, нет" value={draft.options}
            onChange={(e) => setDraft((d) => ({ ...d, options: e.target.value }))} aria-label="Варианты списка" />
        )}
      </div>
    </div>
  )
}

function FieldRow({ field, first, last, busy, onSave, onMove, onDelete }) {
  const isVat = field.code === VAT_FIELD_CODE
  const [label, setLabel] = useState(field.label)
  const [hint, setHint] = useState(field.hint || '')
  const [kind, setKind] = useState(field.kind || 'text')
  const initialOptions = (field.options || []).join('\n')
  const [optionsText, setOptionsText] = useState(initialOptions)
  const options = parseOptions(optionsText)
  const dirty = label.trim() !== field.label || hint.trim() !== (field.hint || '') || kind !== (field.kind || 'text')
    || (kind === 'select' && options.join('\n') !== initialOptions)
  const valid = !!label.trim() && (kind !== 'select' || options.length > 0)
  return (
    <li className={`cbp-field${field.is_active ? '' : ' is-off'}`}>
      <div className="cbp-field-inputs">
        <input className="cbp-input" value={label} maxLength={500} onChange={(e) => setLabel(e.target.value)} aria-label="Поле" />
        <input className="cbp-input" value={hint} maxLength={500} placeholder="подсказка" onChange={(e) => setHint(e.target.value)} aria-label="Подсказка" />
        {isVat ? (
          <span className="cbp-chip cbp-chip-vat" title="По ставке считаются итоги расценки подрядчика">ставка НДС</span>
        ) : (
          <select className="cbp-input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Тип поля">
            {Object.entries(FIELD_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        )}
        {kind === 'select' && (
          <textarea className="cbp-input cbp-options" rows={Math.min(7, Math.max(2, options.length))} value={optionsText}
            placeholder="варианты — каждый с новой строки" onChange={(e) => setOptionsText(e.target.value)} aria-label="Варианты списка" />
        )}
        {isVat && kind === 'select' && options.join('\n') !== VAT_OPTIONS.join('\n') && (
          <button type="button" className="bid-link cbp-link" onClick={() => setOptionsText(VAT_OPTIONS.join('\n'))}>вернуть ставки по умолчанию</button>
        )}
      </div>
      <div className="cbp-field-actions">
        {dirty && (
          <button type="button" className="cbp-btn cbp-btn-primary" disabled={busy || !valid}
            onClick={() => onSave({ label: label.trim(), hint: hint.trim() || null, kind, options: kind === 'select' ? options : null })}>Сохранить</button>
        )}
        {!isVat && (
          <button type="button" className="cbp-btn" disabled={busy} onClick={() => onSave({ is_active: !field.is_active })}>
            {field.is_active ? 'Скрыть' : 'Показать'}
          </button>
        )}
        <button type="button" className="cbp-icon" disabled={busy || first} onClick={() => onMove(-1)} aria-label="Выше">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
        </button>
        <button type="button" className="cbp-icon" disabled={busy || last} onClick={() => onMove(1)} aria-label="Ниже">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <button type="button" className="cbp-icon cbp-icon-danger" disabled={busy || isVat} onClick={onDelete} aria-label="Удалить поле">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
        </button>
      </div>
    </li>
  )
}
