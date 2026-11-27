// Окно «Цены по документу» сметы КП / ПЗ (только администратор, 27.11.2026, миграция 20270308): подгрузить документ (ДС, ДГП,
// ПСДЦ, счёт, КП — или сам файл сметы с этапами ДГП / ДС), сопоставить его строки с позициями сметы и поменять цены.
//   • строки сопоставляются, как строки счёта с позициями ВОР в тендерах на материалы (utils/kpEstimatePriceDoc): та же строка
//     файла сметы → тот же код → похожее наименование; сама ставится только уверенная пара, остальное — человеком: «Найти»
//     (кандидаты и поиск по смете) или «не применять»;
//   • строка документа — у позиции цена за единицу, у группы / раздела / укрупнённой позиции — сумма: позиции внутри
//     пересчитываются пропорционально (kpEstimatePrices);
//   • до записи видно: было → станет по каждой строке и итог сметы; «объём из документа» — по желанию в «Актуальный».
// Пишет одна функция базы kp_estimate_price_apply (проверяет администратора и охват объекта), порциями по 1500 строк.
import { useEffect, useMemo, useRef, useState } from 'react'
import VirtualTableBody from '../VirtualTableBody'
import { ESTIMATE_READ_OPTIONS, parseKpWorkbook } from '../../utils/kpEstimateImport'
import {
  estimateDocLines, estimateTotals, genericDocLines, matchPriceLines, planPriceChanges, priceMatchIndex, pricesAfter, searchEstimate,
} from '../../utils/kpEstimatePriceDoc'
import { effectivePrices } from '../../utils/kpEstimatePrices'
import { BID_DOC_ACCEPT, DOC_ERROR_TEXT, readBidPriceDoc } from '../../utils/bidImport'
import { fmtMoney, fmtMoneyShort, fmtQty } from '../../utils/kpEstimate'
import { applyPrices } from '../../services/kpEstimate'
import { Modal } from './KpEstimateFields'

const pause = () => new Promise((r) => setTimeout(r, 0))
const GRADE_TEXT = { same: 'то же', close: 'очень похоже', refine: 'уточнение', near: 'похоже', far: 'отдалённо' }
const VIA_TEXT = { key: 'та же строка файла', code: 'тот же код', name: 'по наименованию' }
const FILTERS = [
  { key: 'changes', label: 'Изменится' },
  { key: 'check', label: 'Проверить' },
  { key: 'unmatched', label: 'Не найдено' },
  { key: 'all', label: 'Все строки' },
]
const fold = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е')
const unitKey = (u) => fold(u).replace(/[.\s]/g, '').replace('²', '2').replace('³', '3')
const pctText = (v) => (v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`)

async function readDoc(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
    const mod = await import('xlsx')
    const XLSX = mod.utils ? mod : mod.default
    let wb = null
    try { wb = XLSX.read(bytes, { type: 'array', ...ESTIMATE_READ_OPTIONS }) } catch { wb = null }
    // Файл в раскладке сметы (К14, «Лот 31», «Алия», King & Sons, «Событие 6.2») — строками сметы, с этапами.
    const parsed = wb ? parseKpWorkbook(XLSX, wb) : null
    if (parsed && !parsed.error) return { kind: 'estimate', parsed }
  }
  const doc = await readBidPriceDoc(bytes, file.name)
  if (doc.error) return { error: DOC_ERROR_TEXT[doc.error] || doc.message || 'Файл не прочитан' }
  return { kind: 'generic', items: doc.items, vat: doc.vat || null }
}

export default function KpEstimatePriceDocDialog({ tree, estimate, effective, prices, states, marks, onClose, onApplied }) {
  const [index, setIndex] = useState(null)
  const [file, setFile] = useState(null)
  const [doc, setDoc] = useState(null)
  const [stage, setStage] = useState(null)
  const [title, setTitle] = useState('')
  const [matched, setMatched] = useState(null)
  const [progress, setProgress] = useState(null)
  const [problem, setProblem] = useState('')
  const [picks, setPicks] = useState(() => new Map())
  const [withVolumes, setWithVolumes] = useState(false)
  const [filter, setFilter] = useState('changes')
  const [query, setQuery] = useState('')
  const [finding, setFinding] = useState(null)
  const [findQuery, setFindQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const aliveRef = useRef(true)
  const inputRef = useRef(null)
  const scrollRef = useRef(null)

  useEffect(() => () => { aliveRef.current = false }, [])
  // Указатель сметы — сразу при открытии, порциями (смета в 2–5 тыс. строк — доли секунды, окно не замирает).
  useEffect(() => {
    priceMatchIndex(tree, { pause, alive: () => aliveRef.current }).then((ix) => { if (aliveRef.current && ix) setIndex(ix) })
  }, [tree])

  const stages = doc?.kind === 'estimate' ? (doc.parsed.stages || []) : []
  const stageLabel = stage === null ? (stages.length ? 'КП до перекидок' : '') : (stages[stage]?.label || '')
  const lines = useMemo(() => {
    if (!doc) return null
    return doc.kind === 'estimate' ? estimateDocLines(doc.parsed, stage) : genericDocLines(doc.items, doc.vat)
  }, [doc, stage])

  useEffect(() => {
    if (!lines || !index) return undefined
    let alive = true
    setMatched(null)
    setPicks(new Map())
    setFinding(null)
    setProgress({ text: 'Сопоставляем строки с позициями сметы…', done: 0, total: lines.length })
    matchPriceLines(lines, index, {
      pause, alive: () => alive && aliveRef.current,
      onProgress: (done, total) => { if (alive) setProgress({ text: 'Сопоставляем строки с позициями сметы…', done, total }) },
    }).then((m) => { if (alive && m) { setMatched(m); setProgress(null) } })
    return () => { alive = false }
  }, [lines, index])

  const addFile = async (f) => {
    if (!f) return
    setProblem('')
    setDoc(null)
    setMatched(null)
    setProgress({ text: 'Читаем файл…' })
    try {
      const res = await readDoc(f)
      if (!aliveRef.current) return
      if (res.error) { setProblem(`«${f.name}»: ${res.error}`); setProgress(null); return }
      setFile(f)
      setTitle(f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '))
      // Файл с этапами (ДГП, ДС …) — по умолчанию последний этап: действующая цена договора.
      setStage(res.kind === 'estimate' && res.parsed.stages?.length ? res.parsed.stages.length - 1 : null)
      setDoc(res)
      if ((res.kind === 'estimate' ? res.parsed.items.length : res.items.length) === 0) setProblem('В файле нет строк с ценами.')
    } catch (e) {
      setProblem(`Файл не прочитан: ${e.message || e}`)
      setProgress(null)
    }
  }

  const plan = useMemo(() => (matched ? planPriceChanges(matched, { tree, effective, states, marks, picks, withVolumes, docTitle: title }) : null),
    [matched, tree, effective, states, marks, picks, withVolumes, title])
  const totals = useMemo(() => (plan ? estimateTotals(tree, effective, effectivePrices(tree, pricesAfter(prices, plan.items))) : null),
    [plan, tree, effective, prices])
  const byLine = useMemo(() => new Map((matched || []).map((m) => [m.line.i, m])), [matched])

  const stats = useMemo(() => {
    if (!plan) return null
    const out = { lines: plan.lines.length, matched: 0, unmatched: 0, check: 0, changes: 0, volumes: 0, touched: 0 }
    for (const l of plan.lines) {
      if (!l.group) { out.unmatched++; continue }
      out.matched++
      const m = byLine.get(l.i)
      if (needsCheck(l, m, picks)) out.check++
      if (l.changed) out.changes++
      if (l.volume) out.volumes++
      if (l.changed || l.volume) out.touched++
    }
    return out
  }, [plan, byLine, picks])

  const shown = useMemo(() => {
    if (!plan) return []
    const tokens = fold(query).split(/\s+/).filter(Boolean)
    return plan.lines.filter((l) => {
      const m = byLine.get(l.i)
      if (filter === 'changes' && !(l.changed || l.volume)) return false
      if (filter === 'unmatched' && l.group) return false
      if (filter === 'check' && !(l.group && needsCheck(l, m, picks))) return false
      if (!tokens.length) return true
      const hay = fold(`${l.line.code} ${l.line.name} ${l.row?.code || ''} ${l.row?.name || ''}`)
      return tokens.every((t) => hay.includes(t))
    })
  }, [plan, byLine, filter, query, picks])

  // Выбор позиции для строки (или «не применять» — null): та же позиция у другой строки снимается — одна позиция одной строке.
  const pick = (i, group) => {
    setPicks((prev) => {
      const next = new Map(prev)
      if (group) {
        for (const l of plan?.lines || []) if (l.i !== i && l.group?.key === group.key) next.set(l.i, null)
      }
      next.set(i, group)
      return next
    })
    setFinding(null)
  }
  const unpick = (i) => setPicks((prev) => { const next = new Map(prev); next.delete(i); return next })

  const findList = useMemo(() => {
    if (finding === null || !index) return []
    const m = byLine.get(finding)
    const own = (m?.cands || []).map((c) => ({ group: c.group, hint: `${GRADE_TEXT[c.grade] || ''}${c.unitOk ? '' : ', другая ед. изм.'}${c.dup ? ', наименование у нескольких позиций' : ''}` }))
    if (!findQuery.trim()) return own
    const found = searchEstimate(findQuery, index, 30).map((g) => ({ group: g, hint: '' }))
    return found
  }, [finding, findQuery, index, byLine])

  const apply = async () => {
    if (!plan?.items.length || busy) return
    setBusy(true)
    setProblem('')
    try {
      const summary = {
        file: file?.name || null, lines: stats.lines, matched: stats.matched, unmatched: stats.unmatched, changes: plan.items.length,
        before: totals ? Math.round(totals.before * 100) / 100 : null, after: totals ? Math.round(totals.after * 100) / 100 : null,
      }
      const res = await applyPrices(estimate.id, { title: title.trim() || file?.name || 'Документ', stage: stageLabel || null, summary }, plan.items,
        (done, total) => setProgress({ text: 'Записываем цены…', done, total }))
      onApplied({ ...res, title: title.trim() || file?.name || 'Документ' })
    } catch (e) {
      const msg = String(e?.message || e)
      setProblem(/kp_estimate_price_admin/.test(msg) ? 'Цены сметы меняет только администратор.' : `Цены не записаны: ${msg}`)
      setProgress(null)
      setBusy(false)
    }
  }

  const findLine = finding !== null ? plan?.lines.find((l) => l.i === finding) : null
  const renderRow = (n) => {
    const l = shown[n]
    const m = byLine.get(l.i)
    const picked = picks.has(l.i)
    const c = picked ? null : m?.match
    const unitLabel = l.isGroup || (l.row && !l.row.unit) ? 'сумма' : 'за ед.'
    return (
      <tr key={l.i} className={`kpe-pd-row${l.group ? '' : ' is-none'}${l.changed ? ' is-change' : ''}`}>
        <td className="kpe-pd-no kpe-muted">{l.i + 1}</td>
        <td className="kpe-pd-doc">
          <div className="kpe-pd-name" title={l.line.name}>{l.line.code ? <span className="kpe-muted">{l.line.code} </span> : null}{l.line.name}</div>
          <div className="kpe-muted kpe-small">{[l.line.unit, l.line.qty !== null && l.line.qty !== undefined ? `кол-во ${fmtQty(l.line.qty)}` : null,
            l.line.unitPrice !== null && l.line.unitPrice !== undefined ? `${fmtMoney(l.line.unitPrice)} за ед.` : null,
            l.line.total !== null && l.line.total !== undefined ? `сумма ${fmtMoney(l.line.total)}` : null].filter(Boolean).join(' · ')}</div>
        </td>
        <td className="kpe-pd-est">
          {l.group ? (
            <>
              <div className="kpe-pd-name" title={l.row.name}>{l.row.code || l.row.pos_no ? <span className="kpe-muted">{l.row.code || `№ ${l.row.pos_no}`} </span> : null}{l.row.name}</div>
              <div className="kpe-small">
                <span className={`kpe-pd-badge kpe-pd-badge--${picked ? 'manual' : c?.via === 'name' ? c.grade : 'same'}`}>
                  {picked ? 'выбрано вручную' : c ? (c.via === 'name' ? GRADE_TEXT[c.grade] || 'похоже' : VIA_TEXT[c.via]) : ''}
                </span>
                {l.isGroup && <span className="kpe-muted"> · группа: позиции внутри — пропорционально</span>}
                {l.row.unit && l.line.unit && unitKey(l.row.unit) !== unitKey(l.line.unit) && <span className="kpe-muted"> · в смете {l.row.unit}</span>}
              </div>
            </>
          ) : (
            <span className="kpe-muted">{picks.get(l.i) === null ? 'не применять' : m?.cands?.length ? `не найдено уверенно — похожих ${m.cands.length}` : 'не найдено'}</span>
          )}
        </td>
        <td className="kpe-num kpe-pd-money">{l.group && l.before !== null ? fmtMoney(l.before) : ''}<div className="kpe-muted kpe-small">{l.group ? unitLabel : ''}</div></td>
        <td className="kpe-num kpe-pd-money"><b className={l.changed ? (l.after > l.before ? 'kpe-up' : 'kpe-down') : ''}>{l.group && l.after !== null ? fmtMoney(l.after) : ''}</b>
          <div className="kpe-small">{l.changed ? pctText(l.pct) : l.group && l.after !== null ? <span className="kpe-muted">без изменений</span> : ''}</div>
          {l.volume && <div className="kpe-small kpe-muted" title="Объём документа станет «Актуальным»">объём {fmtQty(l.volume.from)} → {fmtQty(l.volume.to)}</div>}
        </td>
        <td className="kpe-pd-act">
          <button type="button" className="kpe-text-btn" onClick={() => { setFinding(l.i); setFindQuery('') }}>{l.group ? 'Другая' : 'Найти'}</button>
          {l.group && <button type="button" className="kpe-text-btn" onClick={() => pick(l.i, null)}>Не применять</button>}
          {picked && <button type="button" className="kpe-text-btn" onClick={() => unpick(l.i)}>Как было</button>}
        </td>
      </tr>
    )
  }

  const footer = (
    <>
      <span className="kpe-pd-foot-note kpe-muted">
        {totals && plan?.items.length ? <>Смета: {fmtMoneyShort(totals.before)} → <b>{fmtMoneyShort(totals.after)}</b> ({pctText(Math.round(((totals.after - totals.before) / (totals.before || 1)) * 1000) / 10)})</> : null}
      </span>
      <button type="button" className="kpe-btn" disabled={busy} onClick={onClose}>Отмена</button>
      <button type="button" className="kpe-btn kpe-btn--primary" disabled={busy || !plan?.items.length} onClick={apply}>
        {busy ? 'Записываем…' : plan?.items.length ? `Применить: ${plan.items.length}` : 'Применить'}
      </button>
    </>
  )

  return (
    <Modal title="Цены по документу" onClose={busy ? () => {} : onClose} wide className="kpe-pd-dialog" footer={footer}>
      <div className={`kpe-drop kpe-pd-drop${drag ? ' is-drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) addFile(e.dataTransfer.files?.[0]) }}>
        <div className="kpe-pd-drop-row">
          <input ref={inputRef} type="file" accept={BID_DOC_ACCEPT} hidden onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = '' }} />
          <button type="button" className="kpe-btn" disabled={busy} onClick={() => inputRef.current?.click()}>{file ? 'Другой файл' : 'Выбрать файл'}</button>
          {file ? <b className="kpe-pd-file" title={file.name}>{file.name}</b>
            : <span className="kpe-muted">ДС, ДГП, ПСДЦ, счёт или КП (Excel, PDF) — или файл сметы с этапами. Можно перетащить сюда.</span>}
        </div>
        {doc && (
          <div className="kpe-pd-opts">
            <label className="kpe-f">Документ
              <input className="kpe-field" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} aria-label="Название документа" placeholder="Например: ДС №4 от 01.12.2026" />
            </label>
            {stages.length > 0 && (
              <label className="kpe-f">Цены этапа
                <select className="kpe-field" value={stage === null ? '' : String(stage)} aria-label="Этап файла" onChange={(e) => setStage(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">КП до перекидок</option>
                  {stages.map((s, i) => <option key={s.label} value={String(i)}>{s.label}{s.totals?.total ? ` — ${fmtMoneyShort(s.totals.total)}` : ''}</option>)}
                </select>
              </label>
            )}
            <label className="kpe-check" title="Где количество в документе отличается от действующего объёма — записать его в «Актуальный» (с причиной и историей)">
              <input type="checkbox" checked={withVolumes} onChange={(e) => setWithVolumes(e.target.checked)} /> Объём документа → «Актуальный»
            </label>
          </div>
        )}
      </div>

      {problem && <div className="kpe-warn" role="alert">{problem}</div>}
      {!index && <p className="kpe-muted">Готовим смету к сопоставлению…</p>}
      {progress && (
        <div className="kpe-progress" role="status">{progress.text}{progress.total ? ` ${progress.done.toLocaleString('ru-RU')} из ${progress.total.toLocaleString('ru-RU')}` : ''}
          {progress.total ? <progress max={progress.total} value={progress.done} /> : null}</div>
      )}

      {plan && stats && (
        <>
          <p className="kpe-small kpe-pd-stats">
            Строк в документе: <b>{stats.lines}</b> · сопоставлено {stats.matched} · не найдено {stats.unmatched} · изменится цен <b>{stats.changes}</b>
            {withVolumes ? ` · объёмов ${stats.volumes}` : ''}
            {doc?.kind === 'estimate' && doc.parsed.layout === 'stages' ? ' · строки ниже итога файла (новые позиции ПСДЦ) в смету не входят' : ''}
          </p>
          <div className="kpe-toolbar kpe-pd-tools">
            <div className="kpe-seg" role="group" aria-label="Показать строки">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className={filter === f.key ? 'is-on' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label} ({f.key === 'changes' ? stats.touched : f.key === 'check' ? stats.check : f.key === 'unmatched' ? stats.unmatched : stats.lines})
                </button>
              ))}
            </div>
            <input type="search" className="kpe-field kpe-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по документу и смете" aria-label="Поиск по строкам" />
          </div>

          {findLine && (
            <div className="kpe-pd-find" role="dialog" aria-label="Найти позицию сметы">
              <div className="kpe-pd-find-head">
                <span>Позиция сметы для строки <b>«{findLine.line.name.slice(0, 140)}»</b></span>
                <button type="button" className="kpe-icon-btn" aria-label="Закрыть поиск" onClick={() => setFinding(null)}>✕</button>
              </div>
              <input className="kpe-field" autoFocus value={findQuery} onChange={(e) => setFindQuery(e.target.value)} placeholder="Код или слова наименования — поиск по всей смете" aria-label="Поиск позиции сметы"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFinding(null) } }} />
              <ul className="kpe-pd-find-list">
                {findList.map(({ group, hint }) => (
                  <li key={group.key}>
                    <button type="button" className="kpe-pd-find-item" onClick={() => pick(finding, group)}>
                      <span className="kpe-muted">{group.row.code || (group.row.pos_no ? `№ ${group.row.pos_no}` : '')}</span> {group.name}
                      <span className="kpe-muted kpe-small"> {[group.row.unit, hint].filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                ))}
                {!findList.length && <li className="kpe-muted">{findQuery.trim() ? 'Ничего не найдено' : 'Похожих позиций нет — найдите поиском'}</li>}
              </ul>
            </div>
          )}

          <div className="kpe-pd-table-wrap" ref={scrollRef}>
            <table className="kpe-pd-table">
              <colgroup><col style={{ width: '2.5rem' }} /><col /><col /><col style={{ width: '8.5rem' }} /><col style={{ width: '9rem' }} /><col style={{ width: '6.5rem' }} /></colgroup>
              <thead>
                <tr><th>№</th><th>Строка документа</th><th>Позиция сметы</th><th className="kpe-num">Было, ₽</th><th className="kpe-num">Станет, ₽</th><th aria-label="Действия" /></tr>
              </thead>
              {shown.length ? (
                <VirtualTableBody rowCount={shown.length} renderRow={renderRow} colSpan={6} scrollRef={scrollRef} rowHeight={52} />
              ) : (
                <tbody><tr><td colSpan={6} className="kpe-empty-row">{filter === 'changes' ? 'Цены не меняются — все сопоставленные строки как в смете' : 'Нет строк'}</td></tr></tbody>
              )}
            </table>
          </div>
        </>
      )}
    </Modal>
  )
}

// Пара, которую стоит посмотреть: найдена по наименованию (не та же строка и не тот же код с тем же наименованием) или выбрана
// вручную.
function needsCheck(l, m, picks) {
  if (picks.has(l.i)) return !!picks.get(l.i)
  return !!m?.match && m.match.via === 'name' && m.match.grade !== 'same'
}
