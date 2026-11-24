import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { db, signal } from '../api'
import AnchoredPopover from './AnchoredPopover'
import { useIsPhone } from '../hooks/useMediaQuery'
import { DOC_TYPE, DOC_TYPE_LABEL } from '../utils/contractAmendments'
import { contractParties } from '../utils/contractCounterpartyFilter'
import {
  STATE_LABEL, WARN_STATES, attemptKeys, candidateFlagText, candidateReasonText, isUnconfirmable, reasonText, suggestsAlias,
} from '../utils/signalReview'
import { isWebUrl, plural, ruDate, ruDateTime } from '../utils/signalPathRow'
import './SignalReviewDialog.css'

// «Сверка с Signal»: договор слева, папка SIGNAL справа, причины плашками (23.11.2026, интеграция с SIGNAL).
//   <SignalReviewDialog contractId onClose onChanged [contract] [anchor] [returnFocus] />
// Окно живёт по contractId: данные берёт у сервера (signal.contract), строка договора в таблице не нужна. С anchor (значок в
// видимой строке) на компьютере рисуется у значка (AnchoredPopover), без него и на телефоне — самостоятельным окном на весь
// экран, договор и папка один под другим. Оба — в <body>; Escape закрывает, фокус возвращается на значок или на
// returnFocus (элемент или функция), клавиатура — Tab по кругу внутри самостоятельного окна.
//
// Действия — решения человека, пишет их сервер одной транзакцией: «Подтвердить», при другой текущей ссылке — «Заменить на
// предложенную» / «Оставить текущую», «Другая папка…» (поиск папок объекта договора), «Отклонить» с причиной, «Позже».
// Каждое — с версией состояния и ссылкой, какими их видело окно (expectedStateVersion, expectedSignalLink), и ключом
// идемпотентности — один на попытку «действие + папка»: повтор той же попытки (после ошибки сети или 409) идёт с тем же
// ключом, смена действия или папки и успех, оставивший окно открытым, — новый ключ. Отказ 409 — «Данные изменились —
// откройте сверку заново» и перезагрузка данных окна. Права проверяет сервер; кнопки без права правки не показываются.
// onChanged({ contractId, action: 'confirm'|'replace'|'reject', state, stateVersion, signalLink? }) — после успеха.

const STALE_TEXT = 'Данные изменились — откройте сверку заново'
// Текст для «Запомнить как название объекта»: подсказка сервера, иначе путь папки без последнего звена (самой папки договора).
function aliasGuess(candidate) {
  if (candidate?.aliasText) return String(candidate.aliasText).slice(0, 120)
  const parts = String(candidate?.path || '').split(' / ').map((s) => s.trim()).filter(Boolean)
  return parts.slice(0, -1).join(' / ').slice(0, 120)
}

const Svg = ({ children }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const ChipIcon = ({ kind }) => {
  if (kind === 'ok') return <Svg><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
  if (kind === 'bad') return <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>
  if (kind === 'warn') return <Svg><path d="M12 6v8M12 18.5v.01" /></Svg>
  return <Svg><path d="M12 11v6M12 7.5v.01" /></Svg>
}

function ContractSide({ contract, dsCount }) {
  if (!contract) return <p className="srd-muted">Загрузка данных договора…</p>
  const parties = contractParties(contract).map((p) => p.name).filter(Boolean)
  const isDp = (contract.record_type || DOC_TYPE.CONTRACT) === DOC_TYPE.CONTRACT
  const date = ruDate(contract.contract_date)
  const kind = isDp
    ? `ДП${dsCount ? ` · ДС: ${dsCount}` : ''}`
    : (DOC_TYPE_LABEL[contract.record_type] || 'ДС')
  return (
    <div className="srd-card">
      <div className="srd-main">
        {contract.contract_number ? `№ ${contract.contract_number}` : 'Без номера'}{date ? ` от ${date}` : ''}
      </div>
      {contract.objects?.name && <div className="srd-line">{contract.objects.name}</div>}
      {parties.length > 0 && <div className="srd-line">{parties.join(', ')}</div>}
      <div className="srd-sub">{kind}{contract.display_id != null ? ` · ID ${contract.display_id}` : ''}</div>
    </div>
  )
}

// «Другая папка…»: поиск по папкам объекта договора (сервер отдаёт только папки этого объекта и его охвата).
function FolderSearch({ contractId, onPick, onCancel, onDirty }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState({ items: [], next: null, loading: true, error: '' })
  const seq = useRef(0)
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const run = useCallback(async (query, after) => {
    const mine = ++seq.current
    setList((l) => ({ ...l, loading: true, error: '' }))
    try {
      const res = await signal.folders(contractId, { q: query.trim(), after })
      if (mine !== seq.current) return
      setList((l) => ({ items: after ? [...l.items, ...(res.items || [])] : (res.items || []), next: res.next || null, loading: false, error: '' }))
    } catch (err) {
      if (mine !== seq.current) return
      setList((l) => ({ ...l, loading: false, error: err.message || 'Не удалось найти папки' }))
    }
  }, [contractId])
  useEffect(() => {
    const t = setTimeout(() => run(q, null), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, run])
  useEffect(() => { onDirty?.(!!q.trim()); return () => onDirty?.(false) }, [q, onDirty])
  useEffect(() => () => { seq.current++ }, [])
  return (
    <div className="srd-panel" role="group" aria-label="Другая папка">
      <label className="srd-field">
        <span className="srd-k">Поиск папки объекта договора</span>
        <input
          ref={inputRef}
          type="text"
          className="srd-input"
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Название или путь папки"
          spellCheck={false}
        />
      </label>
      {list.error && <div className="srd-msg is-error" role="alert">{list.error}</div>}
      {!list.error && !list.loading && list.items.length === 0 && <p className="srd-muted">Папок не найдено</p>}
      {list.items.length > 0 && (
        <ul className="srd-folders">
          {list.items.map((f) => (
            <li key={f.nodeId}>
              <button type="button" className="srd-folder" onClick={() => onPick(f)}>
                <span className="srd-path">{f.path}</span>
                {f.files != null && <span className="srd-muted">{f.files} {plural(f.files, 'файл', 'файла', 'файлов')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="srd-panel-actions">
        {list.next && <button type="button" className="srd-btn" disabled={list.loading} onClick={() => run(q, list.next)}>Показать ещё</button>}
        {list.loading && <span className="srd-muted" role="status">Поиск…</span>}
        <button type="button" className="srd-btn is-quiet" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  )
}

export default function SignalReviewDialog({ contractId, contract: contractProp = null, anchor = null, returnFocus = null, onClose, onChanged }) {
  const isPhone = useIsPhone()
  const asPopover = !!anchor && anchor.isConnected && !isPhone
  const titleId = useId()
  const titleRef = useRef(null)
  const modalRef = useRef(null)
  const openerRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  const keysRef = useRef(null)
  if (!keysRef.current) keysRef.current = attemptKeys(() => signal.newKey())

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [fetchedContract, setFetchedContract] = useState(null)
  const [dsCount, setDsCount] = useState(0)
  const [chosenId, setChosenId] = useState(null)
  const [picked, setPicked] = useState(null)
  const [declined, setDeclined] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchDirty, setSearchDirty] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [remember, setRemember] = useState(false)
  const [aliasText, setAliasText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const seq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const contract = contractProp || fetchedContract

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const d = await signal.contract(contractId)
      if (mine !== seq.current || !mounted.current) return
      setData(d)
      setLoadError('')
      const open = (d.candidates || []).filter((c) => !c.status || c.status === 'open')
      setChosenId(open[0]?.nodeId || null)
      setPicked(null)
      setDeclined(false)
      setSearching(false)
      setSearchDirty(false)
      setRejecting(false)
      setRemember(false)
    } catch (err) {
      if (mine !== seq.current || !mounted.current) return
      setLoadError(err.message || 'Не удалось загрузить сверку')
    } finally {
      if (mine === seq.current && mounted.current) setLoading(false)
    }
  }, [contractId])
  useEffect(() => { load() }, [load])

  // Договор слева: строку страницы не требуем (окно открывают и по contractId, без строки в DOM).
  useEffect(() => {
    if (contractProp) return undefined
    let cancelled = false
    db.from('contracts')
      .select('id, display_id, record_type, contract_number, contract_date, objects(name), counterparties(id, name), contract_counterparties(sort_order, counterparties(id, name))')
      .eq('id', contractId)
      .maybeSingle()
      .then(({ data: row }) => { if (!cancelled && row) setFetchedContract(row) }, () => {})
    return () => { cancelled = true }
  }, [contractId, contractProp])
  const isDp = !!contract && (contract.record_type || DOC_TYPE.CONTRACT) === DOC_TYPE.CONTRACT
  useEffect(() => {
    if (!isDp) { setDsCount(0); return undefined }
    let cancelled = false
    db.from('contracts')
      .select('id', { count: 'exact', head: true })
      .eq('root_contract_id', contractId)
      .is('deleted_at', null)
      .then(({ count }) => { if (!cancelled) setDsCount(Number(count) || 0) }, () => {})
    return () => { cancelled = true }
  }, [contractId, isDp])

  const candidates = useMemo(() => (data?.candidates || []).filter((c) => !c.status || c.status === 'open'), [data])
  const chosen = declined ? null : (picked || candidates.find((c) => c.nodeId === chosenId) || null)
  const link = String(data?.signalLink || '').trim()
  const current = data?.node || null
  const isCurrentChosen = !!chosen && !!current && chosen.nodeId === current.nodeId
  const needsReplace = !!chosen && !!link && !isCurrentChosen
  const canEditHere = !!data?.canEdit
  const confirmAvailable = data?.confirmAvailable !== false
  const hardState = WARN_STATES.includes(data?.state)
  // Подтвердить можно папку, которой ещё нет в ссылке; текущую папку с противоречием, пропавшую или удалённую — нельзя.
  // Папку, у которой не определена папка договора ДС (флаг family_unknown), подтвердить и заменить на неё нельзя — сервер откажет.
  const blocked = !!chosen && isUnconfirmable(chosen)
  const canConfirm = canEditHere && !!chosen && !blocked && !needsReplace && !(isCurrentChosen && hardState)
  const canReplace = canEditHere && needsReplace && !blocked
  // Отклоняется предложение сервера (пара «договор — папка»), а не папка, найденная поиском или текущая.
  const canReject = canEditHere && !!chosen && !picked && !isCurrentChosen && candidates.some((c) => c.nodeId === chosen.nodeId)
  // Объект в пути папки назван иначе (у предложенной папки нет признака object_name) — предлагаем запомнить это название.
  const showAlias = canEditHere && !!chosen && !picked && !blocked && suggestsAlias(chosen)
  const aliasOk = aliasText.trim().length >= 2
  const objectName = contract?.objects?.name || ''

  // Текст синонима — по выбранной папке.
  const chosenNodeId = chosen?.nodeId || null
  useEffect(() => { setAliasText(aliasGuess(chosen)); setRemember(false) }, [chosenNodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = (rejecting && !!note.trim()) || (remember && aliasOk) || searchDirty
  const canClose = () => !busy && !dirty

  const focusTarget = () => {
    const back = typeof returnFocus === 'function' ? returnFocus() : returnFocus
    if (back?.isConnected) return back
    if (anchor?.isConnected) return anchor
    return openerRef.current?.isConnected ? openerRef.current : null
  }
  // Фокус возвращается после перерисовки (кнопка, с которой открыли окно, могла исчезнуть вместе с сообщением).
  const close = () => {
    onClose?.()
    setTimeout(() => { focusTarget()?.focus() }, 0)
  }

  // Фокус — в заголовок окна: экранный диктор читает его сразу, Tab ведёт к кнопкам.
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }) }, [])

  // Самостоятельное окно: Escape и Tab по кругу. У окна у значка Escape и возврат фокуса — в AnchoredPopover.
  useEffect(() => {
    if (asPopover) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!busy) close()
        return
      }
      if (e.key !== 'Tab' || !modalRef.current) return
      const items = [...modalRef.current.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }) // обработчик берёт свежие busy и close — переподписка на каждый рендер дешёвая

  const act = async (kind) => {
    if (busy || !data || !chosen) return
    setBusy(true)
    setMessage(null)
    try {
      let res
      if (kind === 'reject') {
        res = await signal.reject(contractId, {
          nodeId: chosen.nodeId,
          ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}),
          expectedStateVersion: data.stateVersion,
          idempotencyKey: keysRef.current.keyFor('reject', chosen.nodeId),
        })
      } else {
        res = await signal.confirm(contractId, {
          nodeId: chosen.nodeId,
          replace: kind === 'replace',
          ...(remember && aliasOk && showAlias ? { rememberAlias: aliasText.trim().slice(0, 120) } : {}),
          expectedSignalLink: link || null,
          expectedStateVersion: data.stateVersion,
          idempotencyKey: keysRef.current.keyFor(kind, chosen.nodeId),
        })
      }
      onChanged?.({
        contractId,
        action: kind,
        state: res.state,
        stateVersion: res.stateVersion,
        ...(kind === 'reject' ? {} : { signalLink: res.signalLink ?? null }),
      })
      if (kind === 'reject' && res.state === 'suggested') {
        // Остались другие предложения: окно показывает следующее; новое действие — новый ключ.
        keysRef.current.reset()
        setNote('')
        setMessage({ kind: 'ok', text: 'Предложение отклонено — осталось другое' })
        await load()
      } else {
        close()
      }
    } catch (err) {
      if (err?.status === 409) {
        setMessage({ kind: 'error', text: err.isStale || err.code === 'stale_state' ? STALE_TEXT : (err.message || STALE_TEXT) })
        if (err.code !== 'alias_taken') await load()
      } else {
        setMessage({ kind: 'error', text: err?.message || 'Не удалось сохранить решение' })
      }
    } finally {
      setBusy(false)
    }
  }

  // ── Разметка ───────────────────────────────────────────────────────────────────────────────────────────────────
  const chips = []
  if (chosen) {
    for (const r of chosen.reasons || []) chips.push({ kind: 'ok', text: candidateReasonText(r) })
    for (const f of chosen.flags || []) chips.push({ kind: 'warn', text: candidateFlagText(f) })
  }
  if (data && hardState && (!chosen || isCurrentChosen)) {
    chips.push({ kind: data.state === 'conflict' ? 'bad' : 'warn', text: reasonText(data.reason) || STATE_LABEL[data.state].replace(/^Signal: /, '') })
  }
  if (data?.pending) chips.push({ kind: 'info', text: reasonText('pending') })

  const files = current ? (data.files || []) : []
  const lastModified = files.map((f) => f.modifiedAt).filter(Boolean).sort().pop()
  const filesLine = current && files.length > 0
    ? `${files.length}${data.more ? '+' : ''} ${plural(files.length, 'файл', 'файла', 'файлов')}${lastModified ? ` · последний ${ruDate(lastModified)}` : ''}`
    : ''

  const body = (
    <div className="srd" aria-busy={loading || busy}>
      <div className="srd-head">
        <h3 id={titleId} ref={titleRef} tabIndex={-1} className="srd-title">Сверка с Signal</h3>
        <button type="button" className="srd-x" aria-label="Закрыть" onClick={close} disabled={busy}>×</button>
      </div>

      {message && <div className={`srd-msg is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}

      {!data && loading && <p className="srd-muted" role="status">Загрузка…</p>}
      {!data && !loading && loadError && (
        <div className="srd-msg is-error" role="alert">
          {loadError}
          <button type="button" className="srd-btn" onClick={load}>Повторить</button>
        </div>
      )}

      {data && (
        <>
          <div className="srd-grid">
            <section className="srd-col" aria-label="Договор">
              <h4 className="srd-cap">Договор</h4>
              <ContractSide contract={contract} dsCount={dsCount} />
            </section>
            <section className="srd-col" aria-label="Папка в Signal">
              <h4 className="srd-cap">Папка в Signal</h4>
              {needsReplace ? (
                <div className="srd-replace">
                  <div className="srd-row">
                    <span className="srd-k">Сейчас</span>
                    <span className="srd-v">
                      {isWebUrl(link)
                        ? <a href={link} target="_blank" rel="noopener noreferrer" className="srd-url">{link}</a>
                        : <span className="srd-url">{link}</span>}
                      {current?.path && <span className="srd-path">{current.path}</span>}
                    </span>
                  </div>
                  <div className="srd-row">
                    <span className="srd-k">Предложено</span>
                    <span className="srd-v"><span className="srd-path">{chosen.path}</span></span>
                  </div>
                </div>
              ) : chosen ? (
                <div className="srd-card">
                  <div className="srd-path srd-main">{chosen.path}</div>
                  {isCurrentChosen && filesLine && <div className="srd-sub">{filesLine}</div>}
                  {picked && <div className="srd-sub">Выбрана вручную</div>}
                </div>
              ) : current || link ? (
                <div className="srd-card">
                  {current?.path
                    ? <div className="srd-path srd-main">{current.path}</div>
                    : <div className="srd-line">Папка не найдена в данных Signal</div>}
                  {filesLine && <div className="srd-sub">{filesLine}</div>}
                  {link && (
                    <div className="srd-line">
                      {isWebUrl(link)
                        ? <a href={link} target="_blank" rel="noopener noreferrer" className="srd-url">{link}</a>
                        : <span className="srd-url">{link}</span>}
                    </div>
                  )}
                  {data.dataAt && current?.observed === false && <div className="srd-sub">Не видна в последнем обходе</div>}
                </div>
              ) : (
                <div className="srd-card"><div className="srd-line srd-muted">Папка не выбрана</div></div>
              )}
              {candidates.length > 1 && (
                <fieldset className="srd-cands">
                  <legend className="srd-k">Предложено папок: {candidates.length}</legend>
                  {candidates.map((c) => (
                    <label key={c.nodeId} className="srd-cand">
                      <input
                        type="radio"
                        name={`srd-cand-${titleId}`}
                        checked={!picked && !declined && chosen?.nodeId === c.nodeId}
                        onChange={() => { setPicked(null); setDeclined(false); setChosenId(c.nodeId) }}
                        disabled={busy}
                      />
                      <span className="srd-path">{c.path}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </section>
          </div>

          {chips.length > 0 && (
            <ul className="srd-chips" aria-label="Причины">
              {chips.map((c, i) => (
                <li key={`${c.kind}-${i}`} className={`srd-chip is-${c.kind}`}><ChipIcon kind={c.kind} /><span>{c.text}</span></li>
              ))}
            </ul>
          )}

          {showAlias && (
            <div className="srd-alias">
              <label className="srd-check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
                <span>Запомнить «{aliasText.trim() || '…'}» как название объекта{objectName ? ` ${objectName}` : ''}</span>
              </label>
              {remember && (
                <input
                  type="text"
                  className="srd-input"
                  aria-label="Название объекта в Signal"
                  value={aliasText}
                  maxLength={120}
                  onChange={(e) => setAliasText(e.target.value)}
                  disabled={busy}
                  spellCheck={false}
                />
              )}
            </div>
          )}

          {searching && (
            <FolderSearch
              contractId={contractId}
              onDirty={setSearchDirty}
              onCancel={() => setSearching(false)}
              onPick={(f) => { setPicked({ nodeId: f.nodeId, path: f.path, reasons: [], flags: [] }); setDeclined(false); setSearching(false) }}
            />
          )}

          {rejecting && canReject && (
            <div className="srd-panel" role="group" aria-label="Отклонить предложение">
              <label className="srd-field">
                <span className="srd-k">Причина (необязательно)</span>
                <textarea
                  className="srd-input srd-note"
                  rows={2}
                  maxLength={300}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="srd-panel-actions">
                <button type="button" className="srd-btn is-danger" disabled={busy} onClick={() => act('reject')}>Отклонить предложение</button>
                <button type="button" className="srd-btn is-quiet" disabled={busy} onClick={() => setRejecting(false)}>Отмена</button>
              </div>
            </div>
          )}

          {!canEditHere && <p className="srd-muted">Только просмотр: решения принимает сотрудник с правом правки «Договоров».</p>}
          {canEditHere && !confirmAvailable && (canConfirm || canReplace) && (
            <p className="srd-muted">Подтверждение пока недоступно: на сервере не настроен адрес папок Signal.</p>
          )}

          <div className="srd-actions">
            {needsReplace && canEditHere && (
              <>
                {canReplace && (
                  <button type="button" className="srd-btn is-primary" disabled={busy || !confirmAvailable} onClick={() => act('replace')}>Заменить на предложенную</button>
                )}
                <button type="button" className="srd-btn" disabled={busy} onClick={() => { setDeclined(true); setPicked(null) }}>Оставить текущую</button>
              </>
            )}
            {canConfirm && (
              <button type="button" className="srd-btn is-primary" disabled={busy || !confirmAvailable} onClick={() => act('confirm')}>Подтвердить</button>
            )}
            {canEditHere && (
              <button type="button" className="srd-btn" disabled={busy} aria-expanded={searching} onClick={() => { setSearching((v) => !v); setRejecting(false) }}>Другая папка…</button>
            )}
            {canReject && (
              <button type="button" className="srd-btn" disabled={busy} aria-expanded={rejecting} onClick={() => { setRejecting((v) => !v); setSearching(false) }}>Отклонить</button>
            )}
            <span className="srd-spacer" />
            <button type="button" className="srd-btn is-quiet" disabled={busy} onClick={close}>Позже</button>
          </div>

          {data.dataAt && <div className="srd-foot">Данные Signal на {ruDateTime(data.dataAt)}</div>}
        </>
      )}
    </div>
  )

  if (asPopover) {
    return (
      <AnchoredPopover anchor={anchor} onClose={close} canClose={canClose} label="Сверка с Signal" className="srd-pop">
        {body}
      </AnchoredPopover>
    )
  }
  return createPortal(
    <div
      className="srd-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget && canClose()) close() }}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={modalRef} className="srd-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>,
    document.body,
  )
}
