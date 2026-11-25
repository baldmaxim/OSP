import { useCallback, useEffect, useRef, useState } from 'react'
import { signal } from '../../api'
import { bindAffectedText, bindWarningText, folderObjectView, ruDate } from '../../utils/signalPathRow'
import { Chip, Modal } from './SignalTab.Parts'

// Разметка папок многообъектного корня (В-6, К-7): «Папки без объекта», дерево папок любой глубины с поиском, привязки с «Снять» и
// окно «Привязать к объекту…» с проверкой до записи. Маршруты — только администратору (server/osp-api/src/routes/signal.js):
//   GET /tree, GET /unassigned, GET /bindings, POST /bindings/preview, POST /bindings. В SIGNAL ничего не пишется — привязка
//   хранится в портале и решает, к какому объекту относятся папки корня. Администратор видит полные имена папок (это допустимо).
// Каждый список перечитывается, когда растёт epoch (после привязки, «Снять», смены объектов корня). На телефоне — только просмотр.

const Chevron = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
  </svg>
)

// ── «Привязать к объекту…» ────────────────────────────────────────────────────────────────────────────────────────────────────
// Сначала проверка (POST /bindings/preview): если внутри папки есть номера договоров другого объекта корня — предупреждение с числом
// папок и тем, сколько папок и файлов заденет привязка, и подтверждение; иначе привязка выполняется сразу. Отказ проверки — ошибка в
// окне, без записи.
export function BindDialog({ source, node, onClose, onBound }) {
  const objects = source.objects || []
  const [objectId, setObjectId] = useState('')
  const [phase, setPhase] = useState('choose') // choose | checking | confirm | saving
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const nameOf = (id) => objects.find((o) => o.id === id)?.name || 'объект'
  const busy = phase === 'checking' || phase === 'saving'

  const save = async (checked) => {
    const from = phase
    setPhase('saving')
    setError('')
    try {
      await signal.admin.bind({ sourceId: source.id, nodeId: node.nodeId, objectId })
      if (mounted.current) onBound({ objectName: nameOf(objectId), affected: checked?.affected || null })
    } catch (err) {
      if (!mounted.current) return
      setError(err.message || 'Не удалось привязать папку')
      setPhase(from === 'confirm' ? 'confirm' : 'choose')
    }
  }
  const check = async () => {
    if (!objectId) return
    setPhase('checking')
    setError('')
    try {
      const p = await signal.admin.bindingPreview({ sourceId: source.id, nodeId: node.nodeId, objectId })
      if (!mounted.current) return
      const warnings = Array.isArray(p?.warnings) ? p.warnings : []
      if (warnings.length === 0) { await save(p); return }
      setPreview({ warnings, affected: p?.affected || null })
      setPhase('confirm')
    } catch (err) {
      if (!mounted.current) return
      setError(err.message || 'Не удалось проверить папку')
      setPhase('choose')
    }
  }

  return (
    <Modal title="Привязать папку к объекту" onClose={onClose} busy={busy}>
      <div className="sg-form">
        <p className="sg-path" data-testid="bind-path">{node.path}</p>
        {phase === 'confirm' && preview ? (
          <>
            <div className="sg-warn" role="alert">
              <ul className="sg-warn-list">
                {preview.warnings.map((w) => <li key={w.objectId || w.objectName}>{bindWarningText(w)}</li>)}
              </ul>
              <p className="sg-warn-text">
                Если привязать папку к объекту «{nameOf(objectId)}», эти папки тоже получат его: договоры другого объекта в них сверяться не будут,
                а сотрудники объекта «{nameOf(objectId)}» увидят их папки и файлы.
              </p>
              {preview.affected && <p className="sg-warn-text"><strong>{bindAffectedText(preview.affected)}.</strong></p>}
            </div>
            {error && <p className="sg-error" role="alert">{error}</p>}
            <div className="sg-dialog-actions">
              <button type="button" className="btn-primary" disabled={busy} onClick={() => save(preview)}>{busy ? 'Привязываем…' : 'Привязать всё равно'}</button>
              <button type="button" className="btn-soft" disabled={busy} onClick={() => { setPhase('choose'); setError('') }}>Назад</button>
              <button type="button" className="btn-soft" disabled={busy} onClick={onClose}>Отмена</button>
            </div>
          </>
        ) : (
          <>
            <label className="sg-field">
              <span className="sg-label">Объект корня</span>
              <select className="sg-input" aria-label={`Объект для папки ${node.path}`} value={objectId} disabled={busy} onChange={(e) => setObjectId(e.target.value)}>
                <option value="">Выберите объект…</option>
                {objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
            <p className="sg-hint">Папка и все вложенные получат этот объект, кроме частей, у которых своя привязка. Перед записью портал проверит, нет ли внутри номеров договоров другого объекта.</p>
            {error && <p className="sg-error" role="alert">{error}</p>}
            <div className="sg-dialog-actions">
              <button type="button" className="btn-primary" disabled={!objectId || busy} onClick={check}>{phase === 'checking' ? 'Проверяем…' : phase === 'saving' ? 'Привязываем…' : 'Привязать'}</button>
              <button type="button" className="btn-soft" disabled={busy} onClick={onClose}>Отмена</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// ── «Папки без объекта» ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Верхние папки корня, у которых нет объекта (постранично, «Показать ещё»). После привязки или «Снять» список перечитывается.
export function UnassignedFolders({ source, epoch, phone, onBind }) {
  const [state, setState] = useState({ items: [], next: null, loading: true, error: '' })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async (after) => {
    setState((u) => ({ items: after ? u.items : [], next: null, loading: true, error: '' }))
    try {
      const r = await signal.admin.unassigned({ sourceId: source.id, after, limit: 50 })
      if (!mounted.current) return
      setState((u) => ({ items: [...(after ? u.items : []), ...(r.items || [])], next: r.next || null, loading: false, error: '' }))
    } catch (err) {
      if (!mounted.current) return
      setState((u) => ({ items: after ? u.items : [], next: null, loading: false, error: err.message || 'Не удалось загрузить папки' }))
    }
  }, [source.id])
  useEffect(() => { load(null) }, [load, epoch])

  const u = state
  return (
    <div className="sg-unassigned" data-source={source.id}>
      <h5 className="sg-subtitle">{source.projectName} → {source.rootPath}</h5>
      {u.error && <p className="sg-error" role="alert">{u.error} <button type="button" className="btn-soft" onClick={() => load(null)}>Повторить</button></p>}
      {!u.loading && !u.error && u.items.length === 0 && <p className="sg-muted">Все папки корня связаны с объектами.</p>}
      {u.items.length > 0 && (
        <div className="sg-table-wrap">
          <table className="sg-table sg-unassigned-table">
            <thead><tr><th>Папка</th><th className="sg-num">Элементов</th>{!phone && <th className="sg-actions-col">Действия</th>}</tr></thead>
            <tbody>
              {u.items.map((n) => (
                <tr key={n.nodeId}>
                  <td data-label="Папка"><span className="sg-name">{n.path}</span></td>
                  <td className="sg-num" data-label="Элементов">{n.items ?? 0}</td>
                  {!phone && (
                    <td>
                      <button type="button" className="btn-soft" onClick={() => onBind(source, { nodeId: n.nodeId, path: n.path, objectId: null })}>Привязать к объекту…</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {u.loading && <p className="sg-muted" role="status">Загрузка…</p>}
      {u.next && !u.loading && <button type="button" className="btn-soft" onClick={() => load(u.next)}>Показать ещё</button>}
      {u.items.length > 0 && <p className="sg-hint">Показано папок: {u.items.length}{u.next ? ' — это не все' : ''}</p>}
    </div>
  )
}

// ── Привязки корня ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Что и к какому объекту привязано (GET /bindings), «Снять» — с подтверждением (в SignalTab). После «Снять» папка снова без объекта
// (или получает объект привязки выше).
export function BindingsList({ source, epoch, phone, busyKey, onUnbind }) {
  const [state, setState] = useState({ items: [], loading: true, error: '' })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }))
    try {
      const r = await signal.admin.bindings(source.id)
      if (!mounted.current) return
      setState({ items: r?.items || [], loading: false, error: '' })
    } catch (err) {
      if (!mounted.current) return
      setState((s) => ({ ...s, loading: false, error: err.message || 'Не удалось загрузить привязки' }))
    }
  }, [source.id])
  useEffect(() => { load() }, [load, epoch])

  const s = state
  return (
    <div className="sg-bindings" data-source={source.id}>
      <h5 className="sg-subtitle">{source.projectName} → {source.rootPath}</h5>
      {s.error && <p className="sg-error" role="alert">{s.error} <button type="button" className="btn-soft" onClick={load}>Повторить</button></p>}
      {!s.loading && !s.error && s.items.length === 0 && <p className="sg-muted">Привязок папок нет: объект папок определяется объектами корня.</p>}
      {s.items.length > 0 && (
        <div className="sg-table-wrap">
          <table className="sg-table sg-bindings-table">
            <thead><tr><th>Папка</th><th>Объект</th><th>Когда</th>{!phone && <th className="sg-actions-col" />}</tr></thead>
            <tbody>
              {s.items.map((b) => (
                <tr key={b.nodeId}>
                  <td data-label="Папка">
                    <span className="sg-name">{b.path}</span>
                    {b.observed === false && <> <Chip tone="warn" title="Папки нет в последнем обходе Signal — привязка сохранена">не видна в обходе</Chip></>}
                  </td>
                  <td data-label="Объект">{b.objectName || '—'}</td>
                  <td data-label="Когда">{ruDate(b.createdAt) || '—'}</td>
                  {!phone && (
                    <td>
                      <button type="button" className="btn-soft sg-danger" disabled={busyKey === `unbind-${b.nodeId}`} onClick={() => onUnbind(source, b)}>Снять</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.loading && <p className="sg-muted" role="status">Загрузка…</p>}
    </div>
  )
}

// ── Дерево папок ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Дети раскрываются по клику отдельным запросом (GET /tree?parentId=…), «Показать ещё» — по курсору next. Поиск по названию —
// по всему корню (GET /tree?q=…): плоский список с полными путями. У папки — объект: своя привязка или унаследованный.
function ObjectChip({ node }) {
  const v = folderObjectView(node)
  return <Chip tone={v.tone} title={v.title}>{v.text}</Chip>
}

export function FolderTree({ source, epoch, phone, onBind }) {
  const [levels, setLevels] = useState({}) // 'root' | nodeId → { items, next, loading, error }
  const [open, setOpen] = useState(() => new Set())
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const [found, setFound] = useState({ items: [], next: null, loading: false, error: '' })
  const mounted = useRef(true)
  const openRef = useRef(open)
  const seq = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { openRef.current = open }, [open])

  const loadLevel = useCallback(async (parentId, after) => {
    const key = parentId || 'root'
    setLevels((l) => ({ ...l, [key]: { items: l[key]?.items || [], next: null, loading: true, error: '' } }))
    try {
      const r = await signal.admin.tree({ sourceId: source.id, parentId: parentId || undefined, after: after || undefined })
      if (!mounted.current) return
      setLevels((l) => ({ ...l, [key]: { items: [...(after ? (l[key]?.items || []) : []), ...(r.items || [])], next: r.next || null, loading: false, error: '' } }))
    } catch (err) {
      if (!mounted.current) return
      setLevels((l) => ({ ...l, [key]: { items: l[key]?.items || [], next: null, loading: false, error: err.message || 'Не удалось загрузить папки' } }))
    }
  }, [source.id])

  // Первая загрузка и перечитывание после привязки: корень и все раскрытые папки (первые страницы).
  useEffect(() => {
    loadLevel(null)
    for (const id of openRef.current) loadLevel(id)
  }, [loadLevel, epoch])

  useEffect(() => {
    const t = setTimeout(() => setApplied(q.trim().slice(0, 100)), 300)
    return () => clearTimeout(t)
  }, [q])

  const search = useCallback(async (text, after) => {
    const mine = ++seq.current
    setFound((f) => ({ items: after ? f.items : [], next: null, loading: true, error: '' }))
    try {
      const r = await signal.admin.tree({ sourceId: source.id, q: text, after: after || undefined })
      if (!mounted.current || mine !== seq.current) return
      setFound((f) => ({ items: [...(after ? f.items : []), ...(r.items || [])], next: r.next || null, loading: false, error: '' }))
    } catch (err) {
      if (!mounted.current || mine !== seq.current) return
      setFound((f) => ({ items: after ? f.items : [], next: null, loading: false, error: err.message || 'Не удалось найти папки' }))
    }
  }, [source.id])
  useEffect(() => {
    if (applied) search(applied, null)
    else seq.current++
  }, [applied, epoch, search])

  const toggle = (n) => {
    const isOpen = open.has(n.nodeId)
    setOpen((s) => { const x = new Set(s); if (isOpen) x.delete(n.nodeId); else x.add(n.nodeId); return x })
    if (!isOpen && !levels[n.nodeId]) loadLevel(n.nodeId)
  }

  const action = (n) => (!phone && (
    <button type="button" className="btn-soft sg-tree-act" aria-label={`Привязать к объекту: ${n.name || n.path}`} onClick={() => onBind(source, n)}>Привязать к объекту…</button>
  ))

  const renderLevel = (parentId, depth) => {
    const key = parentId || 'root'
    const lv = levels[key]
    if (!lv) return <p className="sg-muted" role="status">Загрузка…</p>
    return (
      <>
        {lv.error && <p className="sg-error" role="alert">{lv.error} <button type="button" className="btn-soft" onClick={() => loadLevel(parentId)}>Повторить</button></p>}
        {!lv.loading && !lv.error && lv.items.length === 0 && <p className="sg-muted">{parentId ? 'Вложенных папок нет' : 'В корне нет папок — данные появятся после обхода'}</p>}
        {lv.items.length > 0 && (
          <ul className="sg-tree" data-depth={depth}>
            {lv.items.map((n) => {
              const isOpen = open.has(n.nodeId)
              return (
                <li key={n.nodeId} className="sg-tree-item" data-node={n.nodeId}>
                  <div className="sg-tree-row">
                    {n.hasChildren
                      ? (
                        <button type="button" className="sg-tree-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Свернуть' : 'Раскрыть'} папку ${n.name}`} onClick={() => toggle(n)}>
                          <Chevron open={isOpen} />
                        </button>
                      )
                      : <span className="sg-tree-gap" aria-hidden="true" />}
                    <span className="sg-tree-name" title={n.path}>{n.name}</span>
                    <ObjectChip node={n} />
                    <span className="sg-tree-count" title="Элементов в папке">{n.items ?? 0} эл.</span>
                    {action(n)}
                  </div>
                  {isOpen && <div className="sg-tree-kids">{renderLevel(n.nodeId, depth + 1)}</div>}
                </li>
              )
            })}
          </ul>
        )}
        {lv.loading && lv.items.length > 0 && <p className="sg-muted" role="status">Загрузка…</p>}
        {lv.next && !lv.loading && <button type="button" className="btn-soft sg-tree-more" onClick={() => loadLevel(parentId, lv.next)}>Показать ещё</button>}
      </>
    )
  }

  return (
    <div className="sg-tree-box" data-source={source.id}>
      <h5 className="sg-subtitle">{source.projectName} → {source.rootPath}</h5>
      <input
        className="sg-input sg-tree-search" type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)}
        placeholder="Найти папку по названию" aria-label={`Поиск папки: ${source.projectName} → ${source.rootPath}`}
      />
      {applied ? (
        <div className="sg-found" aria-label="Найденные папки">
          {found.error && <p className="sg-error" role="alert">{found.error} <button type="button" className="btn-soft" onClick={() => search(applied, null)}>Повторить</button></p>}
          {found.loading && found.items.length === 0 && <p className="sg-muted" role="status">Ищем…</p>}
          {!found.loading && !found.error && found.items.length === 0 && <p className="sg-muted">Папок с таким названием не нашлось.</p>}
          {found.items.length > 0 && (
            <ul className="sg-tree sg-tree-flat">
              {found.items.map((n) => (
                <li key={n.nodeId} className="sg-tree-item" data-node={n.nodeId}>
                  <div className="sg-tree-row">
                    <span className="sg-tree-name sg-tree-path">{n.path}</span>
                    <ObjectChip node={n} />
                    <span className="sg-tree-count" title="Элементов в папке">{n.items ?? 0} эл.</span>
                    {action(n)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {found.next && !found.loading && <button type="button" className="btn-soft sg-tree-more" onClick={() => search(applied, found.next)}>Показать ещё</button>}
        </div>
      ) : renderLevel(null, 0)}
    </div>
  )
}
