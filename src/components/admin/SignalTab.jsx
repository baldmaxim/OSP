import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db, signal } from '../../api'
import { fetchAllRows } from '../../utils/fetchAllRows'
import { useIsPhone } from '../../hooks/useMediaQuery'
import {
  DAY_MODE_TEXT, RUN_INITIATOR_TEXT, acceptHeldCommand, alertView, disabledView, rootStatusChips, runCounts, runKindText, runOutcome,
  runningOf, ruDateTime, staleText, stuckText,
} from '../../utils/signalPathRow'
import { BindDialog, BindingsList, FolderTree, UnassignedFolders } from './SignalTab.Folders'
import { Chip, Modal, copyText } from './SignalTab.Parts'
import './SignalTab.css'

// «Администрирование» → «Signal» (server/osp-api/src/routes/signal.js). Подключение к SIGNAL, корни обхода, синхронизация, журнал
// прогонов, синонимы объектов и разметка папок многообъектных корней (интеграция с SIGNAL, 23.11.2026; волна исправлений 24.11.2026).
// В SIGNAL браузер не ходит и ничего туда не пишет: вкладка управляет тем, какие корни читает сервер и к каким объектам портала
// они относятся.
//   • Корень без объекта закрыт: сотрудники не видят его папки и файлы. Объекты корня выбирает администратор при добавлении
//     («Объекты корня») и позже кнопкой «Объекты…».
//   • Многообъектный корень размечают по папкам любой глубины (В-6): «Папки без объекта», дерево с поиском и «Привязать к объекту…»
//     (с проверкой до записи), «Привязки папок» со «Снять» — SignalTab.Folders.jsx.
//   • Оповещения сервера (status.alerts: сбой корня, отложенный или зависший прогон, устаревшие данные) — баннером наверху вкладки и
//     числом на ярлыке вкладки (AdminPage); у корня — сбой с даты и число проблемных подпапок; отложенный прогон — готовая команда
//     accept-held (С-50); зависший прогон не блокирует «Синхронизировать» (С-48).
//   • Сверка выключена по причине (В-8: ошибка настройки и т.п.) — вкладка показывает только причину (имена переменных, без значений).
//   • На телефоне — только просмотр состояния (кнопок изменений нет). Права проверяет сервер, вкладку показывает AdminPage.
const MAX_OBJECTS = 20

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

export default function SignalTab({ notify, onStatus }) {
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
  const [binding, setBinding] = useState(null) // { source, node } — окно «Привязать к объекту…»
  const [busyKey, setBusyKey] = useState(null)
  const [syncMsg, setSyncMsg] = useState(null) // { kind: 'ok'|'error', text }
  const [copied, setCopied] = useState(false)
  const [epoch, setEpoch] = useState(0) // растёт после правок корней и привязок: списки папок перечитываются
  const mounted = useRef(true)
  const inflight = useRef(false)
  const onStatusRef = useRef(onStatus)
  const copiedTimer = useRef(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(copiedTimer.current) } }, [])
  useEffect(() => { onStatusRef.current = onStatus }, [onStatus])

  // light — опрос во время обхода: только состояние и журнал (без синонимов).
  const load = useCallback(async ({ light = false } = {}) => {
    if (light && inflight.current) return
    inflight.current = true
    try {
      const st = await signal.status()
      if (!mounted.current) return
      setStatus(st)
      onStatusRef.current?.(st)
      setError('')
      if (st.enabled && st.isAdmin) {
        const [r, a] = await Promise.all([
          signal.admin.runs({ limit: 20 }).catch(() => null),
          light ? null : signal.aliases.list().catch(() => null),
        ])
        if (!mounted.current) return
        setRuns(r?.items || st.lastRuns || [])
        if (!light) setAliases(a?.items || [])
      }
    } catch (err) {
      if (mounted.current) setError(err.message || 'Не удалось загрузить состояние Signal')
    } finally {
      inflight.current = false
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
  // Идущий прогон — по ответу сервера (status.running; у «зависшего» stuck: true, С-48), у сервера без поля — по журналу.
  const running = useMemo(() => runningOf(status, runs), [status, runs])
  const live = !!running && !running.stuck

  // Идёт живой обход — состояние и журнал обновляются сами. Зависший прогон не опрашиваем: сам он не закончится.
  useEffect(() => {
    if (!live) return undefined
    const t = setInterval(() => load({ light: true }), 5000)
    return () => clearInterval(t)
  }, [live, load])

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

  // Привязка выполнена в окне «Привязать к объекту…»: списки папок перечитываются.
  const bound = ({ objectName }) => {
    setBinding(null)
    notify?.('ok', `Папка привязана к объекту «${objectName}»`)
    setEpoch((e) => e + 1)
    load({ light: true })
  }
  // «Снять» привязку: папка и вложенные снова без объекта (или с объектом привязки выше).
  const unbind = async (source, b) => {
    const name = b.objectName || 'объект'
    if (!window.confirm(`Снять привязку папки «${b.path}» к объекту «${name}»?\n\nПапка и вложенные снова станут «без объекта» (или получат объект привязки выше): их договоры перестанут сверяться, пока папку не привяжут заново.`)) return
    setBusyKey(`unbind-${b.nodeId}`)
    try {
      await signal.admin.unbind({ sourceId: source.id, nodeId: b.nodeId })
      notify?.('ok', 'Привязка снята')
      setEpoch((e) => e + 1)
    } catch (err) {
      notify?.('err', err.message || 'Не удалось снять привязку')
    } finally {
      if (mounted.current) setBusyKey(null)
    }
  }

  const heldCommand = status?.held ? acceptHeldCommand(status.held) : ''
  const copyCommand = async () => {
    const ok = await copyText(heldCommand)
    if (!mounted.current) return
    setCopied(ok)
    clearTimeout(copiedTimer.current)
    if (ok) copiedTimer.current = setTimeout(() => { if (mounted.current) setCopied(false) }, 2500)
  }

  if (loading) return <div className="sg-tab"><p className="sg-muted">Загрузка…</p></div>
  if (error) return <div className="sg-tab"><p className="sg-error">{error} <button type="button" className="btn-soft" onClick={() => load()}>Повторить</button></p></div>
  if (!status?.enabled) {
    // В-8: сверка выключена по причине — администратору она видна (имена переменных настройки, без значений); остального нет.
    const why = disabledView(status)
    if (why) {
      return (
        <div className="sg-tab">
          <section className="sg-block sg-disabled" aria-label="Сверка Signal выключена">
            <h4 className="sg-title">{why.title}</h4>
            <p className={why.tone === 'bad' ? 'sg-error' : 'sg-warn'} role="alert">{why.text}</p>
            <p className="sg-hint">{why.hint}</p>
          </section>
        </div>
      )
    }
    return <div className="sg-tab"><p className="sg-muted">Сверка Signal на этом сервере не включена.</p></div>
  }
  if (!status.isAdmin) return <div className="sg-tab"><p className="sg-muted">Вкладка доступна только администратору.</p></div>

  const configured = status.connection === 'configured'
  const multi = sources.filter((s) => (s.objects || []).length > 1)
  const alertList = (status.alerts || []).filter((a) => a?.kind !== 'data_stale')
    .map((a) => ({ key: `${a.kind}-${a.sourceId ?? ''}`, ...alertView(a, sources) })).filter((a) => a.text)
  const showStale = status.stale === true || (status.alerts || []).some((a) => a?.kind === 'data_stale')
  const hasConflict = aliases.some((a) => a.conflict)

  return (
    <div className="sg-tab">
      {phone && <p className="sg-note">На телефоне — только просмотр состояния. Менять корни, объекты, привязки папок и запускать обход можно с компьютера.</p>}

      {alertList.length > 0 && (
        <section className="sg-alerts" aria-label="Оповещения Signal">
          <ul>
            {alertList.map((a) => <li key={a.key} className={`is-${a.tone}`}>{a.text}</li>)}
          </ul>
        </section>
      )}
      {showStale && <p className="sg-stale" role="status">{staleText(status.dataAt)}</p>}

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
                  const chips = rootStatusChips(s)
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
                      <td data-label="Ошибка">
                        {chips.length > 0
                          ? <span className="sg-objs">{chips.map((c) => <Chip key={c.key} tone={c.tone} title={c.title}>{c.text}</Chip>)}</span>
                          : '—'}
                      </td>
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
          {!phone && <button type="button" className="btn-secondary" onClick={sync} disabled={busyKey === 'sync' || live}>{live ? 'Обход идёт…' : 'Синхронизировать'}</button>}
        </div>
        {live && <p className="sg-note" role="status">Идёт обход — журнал обновляется сам.</p>}
        {running?.stuck && <p className="sg-warn sg-stuck" role="alert">{stuckText(running)}</p>}
        {syncMsg && <p className={syncMsg.kind === 'error' ? 'sg-error' : 'sg-note'} role={syncMsg.kind === 'error' ? 'alert' : 'status'}>{syncMsg.text}</p>}
        <p className="sg-hint">Обход по расписанию: ночной около 05:00, дневные — по будням с 08:00 до 20:00 раз в час. Ручной запуск — не чаще раза в минуту.</p>
      </section>

      <section className="sg-block" aria-label="Журнал прогонов">
        <h4 className="sg-title">Журнал прогонов</h4>
        {runs.length === 0 ? <p className="sg-muted">Прогонов ещё не было.</p> : (
          <div className="sg-table-wrap">
            <table className="sg-table sg-runs">
              <thead>
                <tr><th className="sg-num">№</th><th>Дата</th><th>Кто</th><th>Вид</th><th>Итог</th><th className="sg-num">Папок</th><th className="sg-num">Элементов</th></tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((r) => {
                  const dead = running?.stuck && running.runId === r.id
                  const out = dead ? { tone: 'warn', text: 'не отвечает' } : runOutcome(r)
                  const counts = runCounts(r)
                  return (
                    <tr key={r.id}>
                      <td className="sg-num" data-label="№">{r.id}</td>
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
        {status.held && (
          <div className="sg-held" role="group" aria-label="Отложенный прогон">
            <p className="sg-note">
              <strong>Прогон № {status.held.runId} отложен</strong> · поколение данных {status.held.generation}. Снимок папок не заменён, пока данные не проверят.
              {heldCommand && ' Принять их можно на сервере командой:'}
            </p>
            {heldCommand && (
              <div className="sg-cmd">
                <code className="sg-code">{heldCommand}</code>
                {!phone && <button type="button" className="btn-soft" onClick={copyCommand}>{copied ? 'Скопировано' : 'Копировать'}</button>}
              </div>
            )}
            <p className="sg-hint">Вместо «…» впишите причину решения. Номер прогона и поколение берите только отсюда: у более старых отложенных прогонов принимать уже нечего.</p>
          </div>
        )}
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
                  <tr key={a.id} className={a.conflict ? 'is-conflict' : undefined}>
                    <td data-label="Текст">
                      <span className="sg-name">{a.text}</span>
                      {a.conflict && <> <Chip tone="warn" title="Название совпало с названием или кодом другого объекта — при сверке не используется">конфликт</Chip></>}
                    </td>
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
        {hasConflict && <p className="sg-hint">«Конфликт» — название совпало с названием или кодом другого объекта: при сверке оно не используется, пока его не удалят или объект не переименуют.</p>}
      </section>

      {multi.length > 0 && (
        <section className="sg-block" aria-label="Папки без объекта">
          <h4 className="sg-title">Папки без объекта</h4>
          <p className="sg-hint">У корней с несколькими объектами часть папок не относится ни к одному из них, пока их не привязали. Договоры таких папок не сверяются. Папку можно привязать целиком или найти нужную глубже — в дереве ниже.</p>
          {multi.map((s) => <UnassignedFolders key={s.id} source={s} epoch={epoch} phone={phone} onBind={(src, node) => setBinding({ source: src, node })} />)}
        </section>
      )}

      {multi.length > 0 && !phone && (
        <section className="sg-block" aria-label="Дерево папок">
          <h4 className="sg-title">Дерево папок</h4>
          <p className="sg-hint">Папки раскрываются по клику, нужную можно найти поиском. У папки — объект: своя привязка или унаследованный от папки выше. Привязка папки действует на все вложенные, кроме тех, у которых своя.</p>
          {multi.map((s) => <FolderTree key={s.id} source={s} epoch={epoch} phone={phone} onBind={(src, node) => setBinding({ source: src, node })} />)}
        </section>
      )}

      {multi.length > 0 && (
        <section className="sg-block" aria-label="Привязки папок">
          <h4 className="sg-title">Привязки папок</h4>
          <p className="sg-hint">Папки, которые привязаны к объекту вручную. «Снять» возвращает папку и вложенные в «Папки без объекта» (или под привязку выше).</p>
          {multi.map((s) => <BindingsList key={s.id} source={s} epoch={epoch} phone={phone} busyKey={busyKey} onUnbind={unbind} />)}
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
      {binding && <BindDialog source={binding.source} node={binding.node} onClose={() => setBinding(null)} onBound={bound} />}
    </div>
  )
}
