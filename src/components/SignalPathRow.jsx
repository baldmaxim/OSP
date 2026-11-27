import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { signal } from '../api'
import SignalReviewDialog from './SignalReviewDialog'
import { aliasesForObject, fileMeta, filesSummary, hasReviewWork, isWebUrl, rowState, ruDate } from '../utils/signalPathRow'
import './SignalPathRow.css'

// «Путь к Signal» в карточке договора при включённой сверке (23.11.2026, интеграция с SIGNAL; без неё карточка показывает
// прежний SignalLinkCell — ContractDetailPage передаёт его в fallback).
//   <SignalPathRow contractId contract canEdit fallback onLinkChanged />
// Строка: ссылка (путь папки так, как его отдаёт сервер — он уже от границы объекта, С-21: клиент путь не собирает и имя корня или
// проекта не дописывает; нет пути — исходная ссылка), состояние текстом («сверено 23.11.2026», «ссылка принята, номер в папке не
// найден», «ссылка не сверялась — данные на …», «противоречие: …», «папка не видна в Signal», «файл не виден в Signal», «файл
// удалён в Signal», «корпус, очередь или секция не совпали — проверьте», «предложена папка …» — последнее только при праве
// правки), действия «Сверить…» (окно сверки по contractId) и «Отвязать» — только при праве правки.
// Запомненные названия объекта договора (синонимы, С-2) — компактно под состоянием, только при праве правки: сотрудник видит и
// удаляет свои (сервер отдаёт ему только его), администратор — все, конфликтующие помечены (С-6).
// Под строкой — список файлов папки (свёрнут): имя, версия, дата версии и «↗» в SIGNAL, только если сервер прислал url. Файл
// через портал не скачивается и не открывается порталом: «↗» — обычная ссылка в новой вкладке. Подпапки раскрываются
// отдельным запросом (signal.contract(id, { nodeId })). Метаданные и права проверяет сервер; сбой сервиса — строка как раньше.
// onLinkChanged — после решения человека, меняющего ссылку (подтвердили, заменили, отвязали): карточка перечитывает договор.

const STALE_TEXT = 'Данные изменились — обновите'

const Svg = ({ children, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconCloud = () => <Svg><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></Svg>
const IconChevron = ({ open }) => <Svg size={12}><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></Svg>
const IconOut = () => <Svg size={13}><path d="M7 17L17 7M9 7h8v8" /></Svg>
const IconFolder = () => <Svg size={13}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Svg>

// Ссылка «↗» в SIGNAL: только http(s) и только если сервер прислал адрес (шаблон SIGNAL_UI_FILE_URL).
function OutLink({ url, name }) {
  if (!isWebUrl(url)) return <span className="spr-out-gap" aria-hidden="true" />
  return (
    <a className="spr-out" href={url} target="_blank" rel="noopener noreferrer" title="Открыть в Signal" aria-label={`Открыть в Signal: ${name}`}>
      <IconOut />
    </a>
  )
}

function FileLine({ file }) {
  const meta = fileMeta(file)
  return (
    <li className={`spr-file${file.deleted ? ' is-deleted' : ''}`}>
      <span className="spr-file-name">{file.name || 'Без названия'}</span>
      <span className="spr-file-meta">{file.deleted ? 'удалён в Signal' : meta}</span>
      {file.deleted ? <span className="spr-out-gap" aria-hidden="true" /> : <OutLink url={file.url} name={file.name || 'файл'} />}
    </li>
  )
}

// Список: подпапки раскрываются по клику отдельным запросом, результат хранится по nodeId.
function FileList({ contractId, files, more, depth = 0 }) {
  const [kids, setKids] = useState({}) // nodeId → { open, loading, error, files, more }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadKids = async (folder) => {
    setKids((k) => ({ ...k, [folder.nodeId]: { open: true, loading: true, error: '', files: null, more: false } }))
    try {
      const d = await signal.contract(contractId, { nodeId: folder.nodeId })
      if (!alive.current) return
      setKids((k) => ({ ...k, [folder.nodeId]: { open: true, loading: false, error: '', files: d.files || [], more: d.more || false } }))
    } catch (err) {
      if (!alive.current) return
      setKids((k) => ({ ...k, [folder.nodeId]: { open: true, loading: false, error: err.message || 'Не удалось открыть папку', files: null, more: false } }))
    }
  }
  const toggle = (folder) => {
    const cur = kids[folder.nodeId]
    if (cur?.open) setKids((k) => ({ ...k, [folder.nodeId]: { ...cur, open: false } }))
    else if (cur?.files) setKids((k) => ({ ...k, [folder.nodeId]: { ...cur, open: true } }))
    else loadKids(folder)
  }

  return (
    <ul className="spr-list" data-depth={depth}>
      {files.map((f) => {
        if (f.kind !== 'folder') return <FileLine key={f.nodeId} file={f} />
        const k = kids[f.nodeId]
        return (
          <li key={f.nodeId} className="spr-folder">
            <div className="spr-folder-line">
              <button type="button" className="spr-folder-btn" aria-expanded={!!k?.open} onClick={() => toggle(f)}>
                <IconChevron open={!!k?.open} />
                <IconFolder />
                <span className="spr-file-name">{f.name || 'Без названия'}</span>
              </button>
              <OutLink url={f.url} name={f.name || 'папка'} />
            </div>
            {k?.open && (
              <div className="spr-kids">
                {k.loading && <p className="spr-muted" role="status">Загрузка…</p>}
                {k.error && <p className="spr-msg is-error" role="alert">{k.error} <button type="button" className="spr-link" onClick={() => loadKids(f)}>Повторить</button></p>}
                {k.files && (k.files.length > 0
                  ? <FileList contractId={contractId} files={k.files} more={k.more} depth={depth + 1} />
                  : <p className="spr-muted">В папке пусто</p>)}
              </div>
            )}
          </li>
        )
      })}
      {more && <li className="spr-more">{typeof more === 'number' ? `Ещё ${more} — в Signal` : 'Показаны не все — остальное в Signal'}</li>}
    </ul>
  )
}

export default function SignalPathRow({ contractId, contract = null, canEdit: canEditPage = false, fallback = null, onLinkChanged }) {
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [review, setReview] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null) // { kind: 'error'|'stale', text }
  const seq = useRef(0)
  const mounted = useRef(true)
  const keyRef = useRef(null)
  const reviewBtn = useRef(null)
  const unlinkBtn = useRef(null)
  const filesId = useId()
  const aliasesId = useId()
  const [aliases, setAliases] = useState(null) // null — не загружены или нет доступа (блока нет)
  const [aliasesOpen, setAliasesOpen] = useState(false)
  const [aliasAsk, setAliasAsk] = useState(null) // синоним, у которого спрашиваем подтверждение удаления
  const [aliasBusy, setAliasBusy] = useState(false)
  const pageLink = String(contract?.signal_link || '').trim()
  const objectId = contract?.object_id || null
  const aliasesWanted = canEditPage && data?.canEdit === true && !!objectId
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const d = await signal.contract(contractId)
      if (mine !== seq.current || !mounted.current) return
      setData(d)
      setFailed(false)
    } catch {
      // Сбой сервиса или нет доступа: строка как без сверки, без ошибки на всю страницу.
      if (mine !== seq.current || !mounted.current) return
      setFailed(true)
    }
  }, [contractId])
  // Ссылку у договора могли поменять окно путей или другой человек — данные Signal перечитываются.
  useEffect(() => { load() }, [load, pageLink])

  // Запомненные названия объекта договора (С-2): только при праве правки; нет доступа или сбой — блока нет, строка работает как прежде.
  const loadAliases = useCallback(async () => {
    if (!aliasesWanted) { setAliases(null); return }
    try {
      const r = await signal.aliases.list()
      if (mounted.current) setAliases(aliasesForObject(r?.items, objectId))
    } catch {
      if (mounted.current) setAliases(null)
    }
  }, [aliasesWanted, objectId])
  useEffect(() => { loadAliases() }, [loadAliases])

  if (!data || failed) return fallback || <span className="spr-empty">—</span>

  const canEdit = canEditPage && data.canEdit === true
  const link = String(data.signalLink || '').trim()
  const state = rowState(data, { canEdit })
  const path = String(data.node?.path || '').trim()
  const showPath = !!link && !!path
  const files = Array.isArray(data.files) ? data.files : []
  const showFiles = !!link && !!data.node && (files.length > 0 || data.more)
  const canReview = canEdit && hasReviewWork(data)
  const canUnlink = canEdit && !!link

  if (!link && !state) return fallback || <span className="spr-empty">—</span>

  const changed = (info) => { onLinkChanged?.(info) }

  const askUnlink = () => {
    keyRef.current = signal.newKey()
    setMessage(null)
    setConfirming(true)
  }
  const cancelUnlink = () => {
    setConfirming(false)
    setTimeout(() => unlinkBtn.current?.focus(), 0)
  }
  const doUnlink = async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await signal.unlink(contractId, {
        expectedSignalLink: link,
        expectedStateVersion: data.stateVersion,
        idempotencyKey: keyRef.current || signal.newKey(),
      })
      setConfirming(false)
      changed({ contractId, action: 'unlink', state: res?.state ?? 'none', signalLink: null })
      await load()
    } catch (err) {
      setConfirming(false)
      if (err.status === 409 && (!err.code || err.code === 'stale_state')) setMessage({ kind: 'stale', text: STALE_TEXT })
      else setMessage({ kind: 'error', text: err.message || 'Не удалось отвязать' })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const refresh = async () => {
    setMessage(null)
    await load()
    changed({ contractId, action: 'refresh' })
  }
  const doRemoveAlias = async () => {
    const a = aliasAsk
    if (!a || aliasBusy) return
    setAliasBusy(true)
    setMessage(null)
    try {
      await signal.aliases.remove(a.id)
      setAliasAsk(null)
      setAliases((list) => (list || []).filter((x) => x.id !== a.id))
      await load() // без названия сверка договора пересчитается — состояние перечитываем
    } catch (err) {
      setAliasAsk(null)
      setMessage({ kind: 'error', text: err.message || 'Не удалось удалить название' })
    } finally {
      if (mounted.current) setAliasBusy(false)
    }
  }

  const linkView = link
    ? (showPath
      ? (isWebUrl(link)
        ? <a className="spr-path" href={link} target="_blank" rel="noopener noreferrer" title={link}>{path}</a>
        : <span className="spr-path" title={link}>{path}</span>)
      : (fallback || <span className="spr-path">{link}</span>))
    : null

  return (
    <div className="spr">
      {linkView && (
        <div className="spr-main">
          {showPath && <span className="spr-icon"><IconCloud /></span>}
          {linkView}
        </div>
      )}
      <div className="spr-state">
        {state && <span className={`spr-badge is-${state.tone}`}>{state.text}</span>}
        {state?.why && <span className="spr-why">{state.why}</span>}
        {(canReview || canUnlink) && (
          <span className="spr-actions">
            {canReview && <button type="button" className="spr-btn" ref={reviewBtn} onClick={() => setReview(true)}>Сверить…</button>}
            {canUnlink && <button type="button" className="spr-btn is-danger" ref={unlinkBtn} onClick={askUnlink} disabled={busy || confirming}>Отвязать</button>}
          </span>
        )}
      </div>
      {confirming && (
        <div className="spr-confirm" role="group" aria-label="Подтверждение: отвязать папку Signal">
          <span>Отвязать папку Signal от договора? Ссылка у договора будет очищена; в Signal ничего не меняется.</span>
          <span className="spr-actions">
            <button type="button" className="spr-btn is-danger" onClick={doUnlink} disabled={busy} autoFocus>Да, отвязать</button>
            <button type="button" className="spr-btn" onClick={cancelUnlink} disabled={busy}>Отмена</button>
          </span>
        </div>
      )}
      {message && (
        <p className={`spr-msg ${message.kind === 'stale' ? 'is-stale' : 'is-error'}`} role="alert">
          {message.text}
          {message.kind === 'stale' && <> <button type="button" className="spr-link" onClick={refresh}>Обновить</button></>}
        </p>
      )}
      {canEdit && aliases && aliases.length > 0 && (
        <div className="spr-aliases">
          <button type="button" className="spr-files-toggle" aria-expanded={aliasesOpen} aria-controls={aliasesId} onClick={() => setAliasesOpen((v) => !v)}>
            <IconChevron open={aliasesOpen} />
            <span>Запомненные названия объекта: {aliases.length}</span>
          </button>
          <div id={aliasesId} hidden={!aliasesOpen}>
            {aliasesOpen && (
              <ul className="spr-alias-list">
                {aliases.map((a) => (
                  <li key={a.id} className={`spr-alias${a.conflict ? ' is-conflict' : ''}`}>
                    <span className="spr-alias-text" title={[a.author, ruDate(a.createdAt)].filter(Boolean).join(' · ') || undefined}>{a.text}</span>
                    {a.conflict && <span className="spr-badge is-warn" title="Совпало с названием или кодом другого объекта — при сверке не используется">конфликт</span>}
                    <button type="button" className="spr-btn is-danger" disabled={aliasBusy} onClick={() => setAliasAsk(a)} aria-label={`Удалить название ${a.text}`}>Удалить</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {aliasAsk && (
            <div className="spr-confirm" role="group" aria-label="Подтверждение: удалить запомненное название объекта">
              <span>Удалить название «{aliasAsk.text}»? Сверка договоров этого объекта пересчитается без него.</span>
              <span className="spr-actions">
                <button type="button" className="spr-btn is-danger" onClick={doRemoveAlias} disabled={aliasBusy} autoFocus>Да, удалить</button>
                <button type="button" className="spr-btn" onClick={() => setAliasAsk(null)} disabled={aliasBusy}>Отмена</button>
              </span>
            </div>
          )}
        </div>
      )}
      {showFiles && (
        <div className="spr-files">
          <button type="button" className="spr-files-toggle" aria-expanded={filesOpen} aria-controls={filesId} onClick={() => setFilesOpen((v) => !v)}>
            <IconChevron open={filesOpen} />
            <span>{filesSummary(files, { more: !!data.more, dataAt: data.dataAt })}</span>
          </button>
          <div id={filesId} hidden={!filesOpen}>
            {filesOpen && (files.length > 0
              ? <FileList contractId={contractId} files={files} more={data.more || false} />
              : <p className="spr-muted">Содержимое не показано — откройте папку в Signal</p>)}
          </div>
        </div>
      )}
      {review && (
        <SignalReviewDialog
          contractId={contractId}
          contract={contract}
          returnFocus={() => reviewBtn.current}
          onClose={() => setReview(false)}
          onChanged={(info) => { load(); loadAliases(); changed(info) }}
        />
      )}
    </div>
  )
}
