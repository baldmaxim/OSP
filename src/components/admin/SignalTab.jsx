import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { db, signal } from '../../api'
import { fetchAllRows } from '../../utils/fetchAllRows'
import { useIsPhone } from '../../hooks/useMediaQuery'
import {
  DAY_MODE_TEXT, RUN_INITIATOR_TEXT, isRunning, runCounts, runKindText, runOutcome, runReasonText, ruDateTime,
} from '../../utils/signalPathRow'
import './SignalTab.css'

// «Администрирование» → «Signal» (server/osp-api/src/routes/signal.js, маршруты 1, 9, 11–17). Подключение к SIGNAL, корни обхода,
// синхронизация, журнал прогонов, синонимы объектов и папки без объекта (23.11.2026, интеграция с SIGNAL). В SIGNAL браузер не
// ходит и ничего туда не пишет: вкладка управляет тем, какие корни читает сервер и к каким объектам портала они относятся.
//   • Корень без объекта закрыт: сотрудники не видят его папки и файлы. Объекты корня выбирает администратор при добавлении
//     («Объекты корня») и позже кнопкой «Объекты…».
//   • «Папки без объекта» — только у многообъектных корней: часть дерева связывают с одним из объектов корня вручную.
//   • На телефоне — только просмотр состояния (кнопок изменений нет). Права проверяет сервер, вкладку показывает AdminPage.
const MAX_OBJECTS = 20

function Chip({ tone = '', children, title }) {
  return <span className={`sg-chip${tone ? ` is-${tone}` : ''}`} title={title}>{children}</span>
}

// Окно: поверх страницы, Escape закрывает (пока не идёт запрос), фокус — на первое поле.
function Modal({ title, onClose, busy = false, children, wide = false }) {
  const titleId = useId()
  const ref = useRef(null)
  useEffect(() => {
    const first = ref.current?.querySelector('input:not([type=checkbox]), select, textarea')
    ;(first || ref.current)?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])
  return (
    <div className="sg-overlay">
      <div className={`sg-dialog${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="sg-dialog-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="sg-close" onClick={onClose} disabled={busy} aria-label="Закрыть">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// Множественный выбор объектов корня: поиск и флажки. Не больше MAX_OBJECTS (предел сервера).
function ObjectsPicker({ objects, selected, onToggle, loading, error }) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? objects.filter((o) => String(o.name || '').toLowerCase().includes(s)) : objects
  }, [objects, q])
  const full = selected.size >= MAX_OBJECTS
  return (
    <div className="sg-picker">
      <input className="sg-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти объект" aria-label="Поиск объекта" />
      {loading ? <p className="sg-muted">Загрузка объектов…</p>
        : error ? <p className="sg-error">{error}</p>
          : (
            <ul className="sg-pick-list" aria-label="Объекты корня">
              {shown.map((o) => {
                const on = selected.has(o.id)
                return (
                  <li key={o.id}>
                    <label className="sg-check">
                      <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onToggle(o.id)} />
                      <span>{o.name || 'Без названия'}</span>
                    </label>
                  </li>
                )
              })}
              {shown.length === 0 && <li className="sg-muted">Объектов не нашлось</li>}
            </ul>
          )}
      <p className="sg-hint">Выбрано: {selected.size}{full ? ` (предел — ${MAX_OBJECTS})` : ''}</p>
    </div>
  )
}

const NO_OBJECT_WARNING = 'Объект не выбран: корень будет закрыт — сотрудники не увидят его папки и файлы, пока не назначен хотя бы один объект.'

// «Добавить корень»: шаг 1 — ссылка на папку в Signal, шаг 2 — обязательный выбор объектов корня.
function AddRootDialog({ objects, objectsLoading, objectsError, onClose, onAdded }) {
  const [step, setStep] = useState(1)
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const urlOk = /^https:\/\/\S+$/i.test(url.trim()) && url.trim().length <= 2000

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await signal.admin.addSource(url.trim(), [...selected])
      onAdded(r, selected.size)
    } catch (err) {
      setError(err.message || 'Не удалось добавить корень')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Добавить корень" onClose={onClose} busy={busy}>
      <p className="sg-hint">Шаг {step} из 2</p>
      {step === 1 ? (
        <form className="sg-form" onSubmit={(e) => { e.preventDefault(); if (urlOk) { setError(''); setStep(2) } }}>
          <label className="sg-field">
            <span className="sg-label">Ссылка на папку в Signal</span>
            <input className="sg-input" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
          </label>
          <p className="sg-hint">Папка, с которой начинается обход (например, «Договора подряда» проекта). Ссылка только разбирается — в Signal ничего не пишется.</p>
          {error && <p className="sg-error" role="alert">{error}</p>}
          <div className="sg-dialog-actions">
            <button type="submit" className="btn-primary" disabled={!urlOk}>Далее</button>
            <button type="button" className="btn-soft" onClick={onClose}>Отмена</button>
          </div>
        </form>
      ) : (
        <div className="sg-form">
          <h4 className="sg-subtitle">Объекты корня</h4>
          <p className="sg-hint">Объекты портала, к которым относятся папки этого корня. Сотрудник видит папку и файлы только у договоров своего объекта.</p>
          <ObjectsPicker objects={objects} selected={selected} onToggle={toggle} loading={objectsLoading} error={objectsError} />
          {selected.size === 0 && <p className="sg-warn" role="alert">{NO_OBJECT_WARNING}</p>}
          {selected.size > 1 && <p className="sg-hint">Объектов несколько: папки без явной привязки останутся «без объекта» — их связывают ниже, в «Папках без объекта».</p>}
          {error && <p className="sg-error" role="alert">{error}</p>}
          <div className="sg-dialog-actions">
            <button type="button" className="btn-primary" disabled={busy} onClick={submit}>{busy ? 'Добавляем…' : 'Добавить корень'}</button>
            <button type="button" className="btn-soft" disabled={busy} onClick={() => { setError(''); setStep(1) }}>Назад</button>
            <button type="button" className="btn-soft" disabled={busy} onClick={onClose}>Отмена</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// «Объекты…» у корня.
function RootObjectsDialog({ source, objects, objectsLoading, objectsError, onClose, onSaved }) {
  const initial = useMemo(() => new Set((source.objects || []).map((o) => o.id)), [source])
  const [selected, setSelected] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const changed = selected.size !== initial.size || [...selected].some((id) => !initial.has(id))
  // Объекты, которых нет в справочнике (удалены), в выборе остаются видимыми по названию из корня.
  const known = new Set(objects.map((o) => o.id))
  const extra = (source.objects || []).filter((o) => !known.has(o.id))
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await signal.admin.updateSource(source.id, { objectIds: [...selected] })
      onSaved(selected.size)
    } catch (err) {
      setError(err.message || 'Не удалось сохранить объекты')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`Объекты корня: ${source.projectName} → ${source.rootPath}`} onClose={onClose} busy={busy}>
      <div className="sg-form">
        <ObjectsPicker objects={[...extra, ...objects]} selected={selected} onToggle={toggle} loading={objectsLoading} error={objectsError} />
        {selected.size === 0 && <p className="sg-warn" role="alert">{NO_OBJECT_WARNING}</p>}
        <p className="sg-hint">Сменить объекты можно в любой момент: границы папок и сверка договоров пересчитаются. Привязки папок к убранным объектам снимаются.</p>
        {error && <p className="sg-error" role="alert">{error}</p>}
        <div className="sg-dialog-actions">
          <button type="button" className="btn-primary" disabled={busy || !changed} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
          <button type="button" className="btn-soft" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  )
}

export default function SignalTab({ notify }) {
  const phone = useIsPhone()
  const [status, setStatus] = useState(null)
  const [runs, setRuns] = useState([])
  const [aliases, setAliases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [objects, setObjects] = useState([])
  const [objectsState, setObjectsState] = useState({ loading: true, error: '' })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null) // корень, у которого меняют объекты
  const [busyKey, setBusyKey] = useState(null)
  const [syncMsg, setSyncMsg] = useState(null) // { kind: 'ok'|'error', text }
  const [unassigned, setUnassigned] = useState({}) // sourceId → { items, next, loading, error }
  const [bindFor, setBindFor] = useState(null) // { sourceId, nodeId, objectId }
  const [epoch, setEpoch] = useState(0) // растёт после правок корней: папки без объекта перечитываются
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const load = useCallback(async () => {
    try {
      const st = await signal.status()
      if (!mounted.current) return
      setStatus(st)
      setError('')
      if (st.enabled && st.isAdmin) {
        const [r, a] = await Promise.all([
          signal.admin.runs({ limit: 20 }).catch(() => null),
          signal.aliases.list().catch(() => null),
        ])
        if (!mounted.current) return
        setRuns(r?.items || st.lastRuns || [])
        setAliases(a?.items || [])
      }
    } catch (err) {
      if (mounted.current) setError(err.message || 'Не удалось загрузить состояние Signal')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  // Объекты портала — для выбора объектов корня (читаются постранично: PostgREST отдаёт не больше 1000 строк).
  useEffect(() => {
    let alive = true
    fetchAllRows((from, to) => db.from('objects').select('id, name').order('name', { ascending: true }).order('id', { ascending: true }).range(from, to))
      .then((rows) => { if (alive) { setObjects(rows || []); setObjectsState({ loading: false, error: '' }) } })
      .catch(() => { if (alive) setObjectsState({ loading: false, error: 'Не удалось загрузить список объектов' }) })
    return () => { alive = false }
  }, [])

  const sources = useMemo(() => status?.sources || [], [status])
  const running = isRunning(runs)

  // Идёт обход — журнал обновляется сам.
  useEffect(() => {
    if (!running) return undefined
    const t = setTimeout(() => load(), 5000)
    return () => clearTimeout(t)
  }, [running, runs, load])

  // Папки без объекта — у корней с несколькими объектами.
  const multiKey = sources.filter((s) => (s.objects || []).length > 1).map((s) => String(s.id)).join(',')
  const loadUnassigned = useCallback(async (sourceId, after) => {
    setUnassigned((u) => ({ ...u, [sourceId]: { items: after ? (u[sourceId]?.items || []) : [], next: null, loading: true, error: '' } }))
    try {
      const r = await signal.admin.unassigned({ sourceId, after, limit: 50 })
      if (!mounted.current) return
      setUnassigned((u) => ({ ...u, [sourceId]: { items: [...(after ? (u[sourceId]?.items || []) : []), ...(r.items || [])], next: r.next || null, loading: false, error: '' } }))
    } catch (err) {
      if (!mounted.current) return
      setUnassigned((u) => ({ ...u, [sourceId]: { items: after ? (u[sourceId]?.items || []) : [], next: null, loading: false, error: err.message || 'Не удалось загрузить папки' } }))
    }
  }, [])
  useEffect(() => {
    for (const id of multiKey ? multiKey.split(',') : []) loadUnassigned(id, null)
  }, [multiKey, epoch, loadUnassigned])

  const act = async (key, fn, okText) => {
    setBusyKey(key)
    try {
      const r = await fn()
      notify?.('ok', typeof okText === 'function' ? okText(r) : okText)
      setEpoch((e) => e + 1)
      await load()
      return true
    } catch (err) {
      notify?.('err', err.message || 'Не удалось выполнить действие')
      return false
    } finally {
      if (mounted.current) setBusyKey(null)
    }
  }

  const toggleEnabled = (s) => {
    if (s.enabled && !window.confirm(`Выключить корень «${s.projectName} → ${s.rootPath}»?\n\nСотрудники перестанут видеть его папки и файлы, а сверка договоров с ним остановится, пока корень не включат и не завершится обход.`)) return
    act(`src-${s.id}`, () => signal.admin.updateSource(s.id, { enabled: !s.enabled }), s.enabled ? 'Корень выключен' : 'Корень включён — данные появятся после обхода')
  }

  const sync = async () => {
    setBusyKey('sync')
    setSyncMsg(null)
    try {
      await signal.admin.sync()
      setSyncMsg({ kind: 'ok', text: 'Обход запущен — результат появится в журнале прогонов.' })
      notify?.('ok', 'Обход запущен')
      await load()
    } catch (err) {
      const text = err.status === 409 && err.code === 'not_configured'
        ? 'Подключение к Signal не настроено на сервере — обход запустить нельзя.'
        : err.status === 409
          ? 'Обход уже идёт — дождитесь его завершения, журнал обновится сам.'
          : (err.message || 'Не удалось запустить обход')
      setSyncMsg({ kind: 'error', text })
    } finally {
      if (mounted.current) setBusyKey(null)
    }
  }

  const removeAlias = (a) => {
    if (!window.confirm(`Удалить название «${a.text}»? Сверка договоров этого объекта пересчитается без него.`)) return
    act(`alias-${a.id}`, () => signal.aliases.remove(a.id), 'Название удалено')
  }

  const bind = async () => {
    if (!bindFor?.objectId) return
    const { sourceId, nodeId, objectId } = bindFor
    const src = sources.find((s) => s.id === sourceId)
    const name = (src?.objects || []).find((o) => o.id === objectId)?.name || 'объект'
    setBusyKey(`bind-${nodeId}`)
    try {
      await signal.admin.bind({ sourceId, nodeId, objectId })
      notify?.('ok', `Папка связана с объектом «${name}»`)
      setBindFor(null)
      await loadUnassigned(sourceId, null)
      await load()
    } catch (err) {
      notify?.('err', err.message || 'Не удалось связать папку')
    } finally {
      if (mounted.current) setBusyKey(null)
    }
  }

  if (loading) return <div className="sg-tab"><p className="sg-muted">Загрузка…</p></div>
  if (error) return <div className="sg-tab"><p className="sg-error">{error} <button type="button" className="btn-soft" onClick={load}>Повторить</button></p></div>
  if (!status?.enabled) return <div className="sg-tab"><p className="sg-muted">Сверка Signal на этом сервере не включена.</p></div>
  if (!status.isAdmin) return <div className="sg-tab"><p className="sg-muted">Вкладка доступна только администратору.</p></div>

  const configured = status.connection === 'configured'
  const multi = sources.filter((s) => (s.objects || []).length > 1)

  return (
    <div className="sg-tab">
      {phone && <p className="sg-note">На телефоне — только просмотр состояния. Менять корни, объекты и запускать обход можно с компьютера.</p>}

      <section className="sg-block" aria-label="Подключение">
        <p className="sg-conn">
          Подключение: <Chip tone={configured ? 'ok' : 'warn'}>{configured ? 'настроено' : 'не настроено'}</Chip>
          {status.dayMode && <span className="sg-muted"> · дневной обход: {DAY_MODE_TEXT[status.dayMode] || status.dayMode}</span>}
          {status.dataAt && <span className="sg-muted"> · данные Signal на {ruDateTime(status.dataAt)}</span>}
        </p>
        {!configured && <p className="sg-hint">Ключ и адрес Signal на сервере не заданы — обход не запускается, сверка договоров работает по последним данным.</p>}
      </section>

      <section className="sg-block" aria-label="Корни">
        <div className="sg-head">
          <h4 className="sg-title">Корни</h4>
          {!phone && <button type="button" className="btn-primary" onClick={() => setAdding(true)} disabled={!configured}>Добавить корень</button>}
        </div>
        {sources.length === 0 ? <p className="sg-muted">Корней пока нет. Добавьте папку Signal, с которой начинается обход.</p> : (
          <div className="sg-table-wrap">
            <table className="sg-table sg-roots">
              <thead>
                <tr>
                  <th>Проект → путь</th>
                  <th>Состояние</th>
                  <th>Объекты корня</th>
                  <th>Последний обход</th>
                  <th>Ночной обход</th>
                  <th className="sg-num">Папок / элементов</th>
                  <th>Ошибка</th>
                  {!phone && <th className="sg-actions-col">Действия</th>}
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const objs = s.objects || []
                  const busy = busyKey === `src-${s.id}`
                  return (
                    <tr key={s.id} data-source={s.id}>
                      <td data-label="Корень"><span className="sg-name">{s.projectName} → {s.rootPath}</span></td>
                      <td data-label="Состояние">
                        <Chip tone={s.enabled ? 'ok' : ''}>{s.enabled ? 'вкл.' : 'выкл.'}</Chip>
                        {s.enabled && !s.ready && <Chip tone="warn">ждёт первого обхода</Chip>}
                      </td>
                      <td data-label="Объекты корня">
                        {objs.length === 0
                          ? <Chip tone="warn">нет объекта — корень закрыт для сотрудников</Chip>
                          : <span className="sg-objs">{objs.map((o) => <Chip key={o.id}>{o.name}</Chip>)}</span>}
                      </td>
                      <td data-label="Последний обход">{ruDateTime(s.lastOkAt) || 'ещё не было'}</td>
                      <td data-label="Ночной обход">{ruDateTime(s.lastNightOkAt) || 'ещё не было'}</td>
                      <td className="sg-num" data-label="Папок / элементов">{s.ready ? `${s.folders ?? 0} / ${s.items ?? 0}` : '—'}</td>
                      <td data-label="Ошибка">{s.lastError ? <Chip tone="bad" title={s.lastError}>{runReasonText(s.lastError)}</Chip> : '—'}</td>
                      {!phone && (
                        <td>
                          <div className="sg-actions">
                            <button type="button" className={`btn-soft${s.enabled ? ' sg-danger' : ''}`} disabled={busy} onClick={() => toggleEnabled(s)}>{s.enabled ? 'Выключить' : 'Включить'}</button>
                            <button type="button" className="btn-soft" disabled={busy} onClick={() => setEditing(s)}>Объекты…</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="sg-block" aria-label="Синхронизация">
        <div className="sg-head">
          <h4 className="sg-title">Синхронизация</h4>
          {!phone && <button type="button" className="btn-secondary" onClick={sync} disabled={busyKey === 'sync' || running}>{running ? 'Обход идёт…' : 'Синхронизировать'}</button>}
        </div>
        {running && <p className="sg-note" role="status">Идёт обход — журнал обновляется сам.</p>}
        {syncMsg && <p className={syncMsg.kind === 'error' ? 'sg-error' : 'sg-note'} role={syncMsg.kind === 'error' ? 'alert' : 'status'}>{syncMsg.text}</p>}
        <p className="sg-hint">Обход по расписанию: ночной около 05:00, дневные — по будням с 08:00 до 20:00 раз в час. Ручной запуск — не чаще раза в минуту.</p>
      </section>

      <section className="sg-block" aria-label="Журнал прогонов">
        <h4 className="sg-title">Журнал прогонов</h4>
        {runs.length === 0 ? <p className="sg-muted">Прогонов ещё не было.</p> : (
          <div className="sg-table-wrap">
            <table className="sg-table sg-runs">
              <thead>
                <tr><th>Дата</th><th>Кто</th><th>Вид</th><th>Итог</th><th className="sg-num">Папок</th><th className="sg-num">Элементов</th></tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((r) => {
                  const out = runOutcome(r)
                  const counts = runCounts(r)
                  return (
                    <tr key={r.id}>
                      <td data-label="Дата">{ruDateTime(r.startedAt) || '—'}</td>
                      <td data-label="Кто">{RUN_INITIATOR_TEXT[r.initiator] || '—'}</td>
                      <td data-label="Вид">{runKindText(r)}</td>
                      <td data-label="Итог"><Chip tone={out.tone}>{out.text}</Chip></td>
                      <td className="sg-num" data-label="Папок">{counts ? counts.folders : '—'}</td>
                      <td className="sg-num" data-label="Элементов">{counts ? counts.items : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {runs.some((r) => r.status === 'held') && <p className="sg-hint">«Отложен» — снимок папок не заменён, пока данные не проверят; принять их можно на сервере командой signal-cli accept-held.</p>}
      </section>

      <section className="sg-block" aria-label="Синонимы объектов">
        <h4 className="sg-title">Синонимы объектов</h4>
        {aliases.length === 0 ? <p className="sg-muted">Синонимов нет. Их запоминают в окне сверки договора, когда объект найден по тексту в названии папки.</p> : (
          <div className="sg-table-wrap">
            <table className="sg-table sg-aliases">
              <thead>
                <tr><th>Текст</th><th>Объект</th><th>Кто</th><th>Когда</th>{!phone && <th className="sg-actions-col" />}</tr>
              </thead>
              <tbody>
                {aliases.map((a) => (
                  <tr key={a.id}>
                    <td data-label="Текст"><span className="sg-name">{a.text}</span></td>
                    <td data-label="Объект">{a.objectName || '—'}</td>
                    <td data-label="Кто">{a.author || '—'}</td>
                    <td data-label="Когда">{ruDateTime(a.createdAt) || '—'}</td>
                    {!phone && <td><button type="button" className="btn-soft sg-danger" disabled={busyKey === `alias-${a.id}`} onClick={() => removeAlias(a)}>Удалить</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {multi.length > 0 && (
        <section className="sg-block" aria-label="Папки без объекта">
          <h4 className="sg-title">Папки без объекта</h4>
          <p className="sg-hint">У корней с несколькими объектами часть папок не относится ни к одному из них, пока их не связали. Договоры таких папок не сверяются.</p>
          {multi.map((s) => {
            const u = unassigned[s.id]
            return (
              <div key={s.id} className="sg-unassigned" data-source={s.id}>
                <h5 className="sg-subtitle">{s.projectName} → {s.rootPath}</h5>
                {u?.error && <p className="sg-error" role="alert">{u.error} <button type="button" className="btn-soft" onClick={() => loadUnassigned(s.id, null)}>Повторить</button></p>}
                {u && !u.loading && !u.error && u.items.length === 0 && <p className="sg-muted">Все папки корня связаны с объектами.</p>}
                {u?.items.length > 0 && (
                  <div className="sg-table-wrap">
                    <table className="sg-table sg-unassigned-table">
                      <thead><tr><th>Папка</th><th className="sg-num">Элементов</th>{!phone && <th className="sg-actions-col">Действия</th>}</tr></thead>
                      <tbody>
                        {u.items.map((n) => {
                          const binding = bindFor?.nodeId === n.nodeId
                          return (
                            <tr key={n.nodeId}>
                              <td data-label="Папка"><span className="sg-name">{n.path}</span></td>
                              <td className="sg-num" data-label="Элементов">{n.items ?? 0}</td>
                              {!phone && (
                                <td>
                                  {binding ? (
                                    <div className="sg-bind">
                                      <select className="sg-input" aria-label={`Объект для папки ${n.path}`} value={bindFor.objectId} onChange={(e) => setBindFor({ ...bindFor, objectId: e.target.value })}>
                                        <option value="">Выберите объект…</option>
                                        {(s.objects || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                                      </select>
                                      <button type="button" className="btn-primary" disabled={!bindFor.objectId || busyKey === `bind-${n.nodeId}`} onClick={bind}>Связать</button>
                                      <button type="button" className="btn-soft" onClick={() => setBindFor(null)}>Отмена</button>
                                    </div>
                                  ) : (
                                    <button type="button" className="btn-soft" onClick={() => setBindFor({ sourceId: s.id, nodeId: n.nodeId, objectId: '' })}>Связать с объектом…</button>
                                  )}
                                </td>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {u?.loading && <p className="sg-muted" role="status">Загрузка…</p>}
                {u?.next && !u.loading && <button type="button" className="btn-soft" onClick={() => loadUnassigned(s.id, u.next)}>Показать ещё</button>}
                {u?.items.length > 0 && <p className="sg-hint">Показано папок: {u.items.length}{u.next ? ' — это не все' : ''}</p>}
              </div>
            )
          })}
        </section>
      )}

      {adding && (
        <AddRootDialog
          objects={objects} objectsLoading={objectsState.loading} objectsError={objectsState.error}
          onClose={() => setAdding(false)}
          onAdded={async (r, count) => {
            setAdding(false)
            notify?.('ok', `Корень добавлен: ${r.projectName} → ${r.rootPath}${count === 0 ? ' — закрыт для сотрудников, пока не назначен объект' : ''}. Данные появятся после обхода`)
            await load()
          }}
        />
      )}
      {editing && (
        <RootObjectsDialog
          source={editing} objects={objects} objectsLoading={objectsState.loading} objectsError={objectsState.error}
          onClose={() => setEditing(null)}
          onSaved={async (count) => {
            setEditing(null)
            notify?.('ok', count === 0 ? 'Объекты сняты — корень закрыт для сотрудников' : 'Объекты корня сохранены — сверка договоров пересчитается')
            setEpoch((e) => e + 1)
            await load()
          }}
        />
      )}
    </div>
  )
}
