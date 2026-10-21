import { useState, useEffect, useRef, useId } from 'react'
import {
  createVorRdSet, updateVorRdSet, deleteVorRdSet, isMissingVorRdSetsTable, VOR_RD_SETS_MIGRATION_HINT,
} from '../services/vorRdSets'
import { isValidRdLink } from '../utils/vorRdSets'
import { copyToClipboard } from '../utils/clipboard'
import { IconLink, IconPencil, IconTrash, IconCheck } from './icons/ActionIcons'
import './VorRdSetsPanel.css'

// Комплекты РД тендера или заявки на ВОР — список под строкой «ВОРов и РД»
// (раскрывается нажатием на строку). Столбцы: № п/п (порядковый номер, не
// хранится), комплект РД, ВОР готов, срок выдачи ВОРа, ссылка на РД и ВОР,
// примечание. Каждое поле сохраняется само: текст — при уходе из поля или по
// Enter, «ВОР готов» — по нажатию, дата — только полная (неполную дату поле
// присылает на каждую цифру года, запись с ней сбивала ввод).
//
// Данные держит страница (sets — комплекты этого владельца по порядку), панель
// пишет в базу и сообщает результат через onAdded / onChanged / onRemoved.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const isFullDate = (v) => {
  const m = ISO_DATE.exec(v || '')
  return !!m && Number(m[1]) >= 2000 && Number(m[1]) <= 2100
}
const formatDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '')

// Сегодня по часам компьютера (toISOString дал бы дату по Гринвичу — до 5 утра
// по Алматы это ещё «вчера»).
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const daysFromToday = (iso) => Math.round((Date.parse(iso) - Date.parse(localToday())) / 86400000)

function errorText(err) {
  if (isMissingVorRdSetsTable(err)) return VOR_RD_SETS_MIGRATION_HINT
  if (err?.code === '42501' || /row-level security/i.test(err?.message || '')) {
    return 'Нет права менять комплекты РД: нужна правка «Тендеров» или «ВОРов и РД».'
  }
  // .single() без строки: комплект удалили, пока его правили, или права нет.
  if (err?.code === 'PGRST116') return 'Комплект РД не найден — возможно, его удалили. Обновите страницу.'
  if (err?.code === '23514') {
    return 'База не приняла значение: ссылка — адрес http(s)://… или сетевой путь \\\\сервер\\папка, '
      + 'комплект РД — до 500 знаков, примечание — до 4000.'
  }
  return 'Не удалось сохранить: ' + (err?.message || err)
}

// Текстовое поле с черновиком: пишет в базу при уходе из поля (Enter — то же,
// Esc — вернуть сохранённое). Пока набранное не записано, значение из базы
// (после записи или от соседнего поля) черновик не перетирает; не записалось —
// черновик остаётся, поле подсвечено.
function DraftField({ multiline = false, value, onSave, label, placeholder, maxLength, autoFocus }) {
  const saved = value || ''
  const [draft, setDraft] = useState(saved)
  const [dirty, setDirty] = useState(false)
  const [state, setState] = useState('idle') // 'idle' | 'saving' | 'error'
  // Уход из поля по Esc случается в том же обработчике, до перерисовки, — запись
  // смотрит в refs, а не в состояние прошлой отрисовки (иначе Esc сохранял черновик).
  const draftRef = useRef(saved)
  const dirtyRef = useRef(false)

  useEffect(() => { if (!dirty) setDraft(saved) }, [saved, dirty])

  const markDirty = (next) => { dirtyRef.current = next; setDirty(next) }

  const commit = async () => {
    if (!dirtyRef.current) return
    const next = draftRef.current.trim()
    if (next === saved.trim()) { markDirty(false); setState('idle'); return }
    setState('saving')
    try {
      await onSave(next)
      setState('idle')
      // Пока шла запись, могли набрать ещё — тогда поле остаётся «в работе».
      if (draftRef.current.trim() === next) markDirty(false)
    } catch {
      setState('error')
    }
  }
  const revert = (el) => {
    draftRef.current = saved
    setDraft(saved)
    markDirty(false)
    setState('idle')
    el.blur()
  }

  const props = {
    className: `vrs-field${multiline ? ' is-multiline' : ''}${state === 'error' ? ' is-error' : ''}${state === 'saving' ? ' is-saving' : ''}`,
    value: draft,
    placeholder,
    maxLength,
    autoFocus,
    'aria-label': label,
    'aria-invalid': state === 'error' || undefined,
    title: state === 'error' ? 'Не сохранено. Исправьте значение или нажмите Esc, чтобы вернуть прежнее.' : undefined,
    onChange: (e) => { draftRef.current = e.target.value; setDraft(e.target.value); markDirty(true) },
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); revert(e.currentTarget); return }
      // В примечании Enter — новая строка, сохранить — Ctrl+Enter или уйти из поля.
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur() }
    },
  }
  return multiline ? <textarea rows={1} {...props} /> : <input type="text" {...props} />
}

// «ВОР готов»: два положения, выбранное подсвечено — понятно без подсказки.
function ReadyToggle({ value, canEdit, onSave, label }) {
  const [saving, setSaving] = useState(false)
  if (!canEdit) {
    return <span className={`vrs-ready-chip${value ? ' is-yes' : ''}`}>{value ? 'Да' : 'Нет'}</span>
  }
  const choose = async (next) => {
    if (next === value || saving) return
    setSaving(true)
    try { await onSave(next) } catch { /* сообщение уже показано */ } finally { setSaving(false) }
  }
  return (
    <div className="vrs-ready" role="group" aria-label={label}>
      <button type="button" className={`vrs-ready-opt is-yes${value ? ' is-on' : ''}`}
        aria-pressed={value} disabled={saving} onClick={() => choose(true)}>Да</button>
      <button type="button" className={`vrs-ready-opt is-no${value ? '' : ' is-on'}`}
        aria-pressed={!value} disabled={saving} onClick={() => choose(false)}>Нет</button>
    </div>
  )
}

// Срок выдачи ВОРа. Пишется только полная дата или пустое поле; неполная
// (набирают год) при уходе из поля возвращается к сохранённой.
function DueDateField({ value, ready, canEdit, onSave, label }) {
  const saved = value || ''
  const [draft, setDraft] = useState(saved)
  const [dirty, setDirty] = useState(false)
  const [state, setState] = useState('idle')

  useEffect(() => { if (!dirty) setDraft(saved) }, [saved, dirty])

  const commit = async (el) => {
    if (!dirty) return
    // badInput — дата набрана не до конца: поле отдаёт '' и это не «очистить».
    if (el.validity?.badInput || (draft !== '' && !isFullDate(draft))) {
      setDraft(saved); setDirty(false); setState('idle'); return
    }
    if (draft === saved) { setDirty(false); setState('idle'); return }
    setState('saving')
    try {
      await onSave(draft || null)
      setDirty(false)
      setState('idle')
    } catch {
      setState('error')
    }
  }

  // Отсчёт — пока ВОР не готов: просрочено — красным, 0–3 дня — янтарным.
  const shown = dirty ? draft : saved
  const days = shown && !ready && isFullDate(shown) ? daysFromToday(shown) : null
  const overdue = days !== null && days < 0
  let hint = null
  if (overdue) hint = <div className="vrs-due-hint is-overdue">просрочено на {-days} дн.</div>
  else if (days === 0) hint = <div className="vrs-due-hint is-soon">сегодня</div>
  else if (days !== null && days <= 3) hint = <div className="vrs-due-hint is-soon">осталось {days} дн.</div>

  if (!canEdit) {
    return (
      <>
        <span className="vrs-date-text">{shown ? formatDate(shown) : '—'}</span>
        {hint}
      </>
    )
  }
  return (
    <>
      <input
        type="date"
        className={`vrs-field vrs-date${state === 'error' ? ' is-error' : ''}${overdue ? ' is-overdue' : ''}`}
        value={draft}
        min="2000-01-01"
        max="2100-12-31"
        aria-label={label}
        aria-invalid={state === 'error' || undefined}
        onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
          if (e.key === 'Escape') { e.preventDefault(); setDraft(saved); setDirty(false); setState('idle') }
        }}
      />
      {hint}
    </>
  )
}

// Ссылка на РД и ВОР: адрес http(s) открывается в новой вкладке, сетевой путь
// (\\сервер\папка) браузер открыть не может — его копируют. В href попадает
// только http(s): значение вводит человек, и javascript:… выполнился бы по клику.
function LinkField({ value, canEdit, onSave, label }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const errorId = useId()

  const start = () => { setDraft(value || ''); setError(''); setEditing(true) }
  const save = async () => {
    const next = draft.trim()
    if (next === (value || '')) { setEditing(false); return }
    if (next && !isValidRdLink(next)) {
      setError('Нужен адрес https://… или сетевой путь \\\\сервер\\папка.')
      return
    }
    setSaving(true)
    try {
      await onSave(next || null)
      setEditing(false)
    } catch {
      // Сообщение показано; поле остаётся открытым, чтобы набранное не пропало.
    } finally {
      setSaving(false)
    }
  }
  const copy = async () => {
    if (!(await copyToClipboard(value))) { alert('Не удалось скопировать. Выделите путь и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (editing) {
    return (
      <div className="vrs-link-edit">
        <input
          type="text"
          className={`vrs-field${error ? ' is-error' : ''}`}
          autoFocus
          value={draft}
          placeholder="https://… или \\сервер\папка"
          aria-label={label}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={saving}
          onChange={(e) => { setDraft(e.target.value); setError('') }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save() }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
          }}
        />
        <div className="vrs-link-actions">
          <button type="button" className="vrs-btn is-primary" onClick={save} disabled={saving}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button type="button" className="vrs-btn" onClick={() => setEditing(false)} disabled={saving}>Отмена</button>
        </div>
        {error && <div id={errorId} className="vrs-field-error" role="alert">{error}</div>}
      </div>
    )
  }

  if (!value) {
    return canEdit
      ? <button type="button" className="vrs-add-link" onClick={start}>+ ссылка</button>
      : <span className="vrs-empty">—</span>
  }
  const web = /^https?:\/\//i.test(value)
  return (
    <div className="vrs-link">
      {web ? (
        <a className="vrs-link-open" href={value} target="_blank" rel="noopener noreferrer" title={value}>
          <IconLink size={14} /> Открыть
        </a>
      ) : (
        <button type="button" className="vrs-link-open" onClick={copy} title={value}>
          {copied ? <><IconCheck size={14} /> Скопировано</> : 'Скопировать путь'}
        </button>
      )}
      {canEdit && (
        <button type="button" className="vrs-icon-btn" onClick={start} title="Изменить ссылку" aria-label={`Изменить: ${label}`}>
          <IconPencil size={14} />
        </button>
      )}
    </div>
  )
}

export default function VorRdSetsPanel({
  owner,          // { kind: 'tender' | 'request', id }
  ownerLabel,     // «тендер № 200» / «заявка № 5» — для подписей таблицы
  sets,           // комплекты владельца по порядку
  status,         // 'loading' | 'ok' | 'missing' | 'error'
  canEdit,
  onAdded,
  onChanged,
  onRemoved,
}) {
  const [adding, setAdding] = useState(false)
  // Новая строка — сразу курсор в «Комплект РД».
  const [focusId, setFocusId] = useState(null)
  const readyCount = sets.filter(s => s.vor_ready).length

  const save = async (set, patch) => {
    try {
      onChanged(await updateVorRdSet(set.id, patch))
    } catch (err) {
      console.error('Ошибка сохранения комплекта РД:', err.message)
      alert(errorText(err))
      throw err
    }
  }

  const add = async () => {
    setAdding(true)
    try {
      const row = await createVorRdSet(owner, sets)
      onAdded(row)
      setFocusId(row.id)
    } catch (err) {
      console.error('Ошибка добавления комплекта РД:', err.message)
      alert(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  const remove = async (set, n) => {
    const name = set.rd_set ? ` «${set.rd_set}»` : ''
    if (!window.confirm(`Удалить комплект РД № ${n}${name}?`)) return
    try {
      await deleteVorRdSet(set.id)
      onRemoved(set.id)
    } catch (err) {
      console.error('Ошибка удаления комплекта РД:', err.message)
      alert(errorText(err))
    }
  }

  const addButton = canEdit && status === 'ok' && (
    <button type="button" className="vrs-add" onClick={add} disabled={adding}>
      {adding ? 'Добавляем…' : '+ Комплект РД'}
    </button>
  )

  let body
  if (status === 'loading') body = <p className="vrs-note">Загрузка…</p>
  else if (status === 'missing') body = <p className="vrs-note">{VOR_RD_SETS_MIGRATION_HINT}</p>
  else if (status === 'error') body = <p className="vrs-note is-error">Не удалось загрузить комплекты РД. Обновите страницу.</p>
  else if (sets.length === 0) {
    body = <p className="vrs-note">Комплектов РД пока нет.{canEdit ? ' Добавьте первый кнопкой ниже.' : ''}</p>
  } else {
    body = (
      <div className="vrs-table-wrap">
        <table className={`vrs-table${canEdit ? '' : ' is-readonly'}`} aria-label={`Комплекты РД — ${ownerLabel}`}>
          <colgroup>
            <col className="vrs-col-num" />
            <col className="vrs-col-name" />
            <col className="vrs-col-ready" />
            <col className="vrs-col-due" />
            <col className="vrs-col-link" />
            <col className="vrs-col-note" />
            {canEdit && <col className="vrs-col-act" />}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="vrs-num">№ п/п</th>
              <th scope="col">Комплект РД</th>
              <th scope="col">ВОР готов</th>
              <th scope="col">Срок выдачи ВОРа</th>
              <th scope="col">Ссылка на РД и ВОР</th>
              <th scope="col">Примечание</th>
              {canEdit && <th scope="col"><span className="vr-sr-only">Действия</span></th>}
            </tr>
          </thead>
          <tbody>
            {sets.map((s, i) => {
              const n = i + 1
              const rowLabel = `комплект № ${n}`
              return (
                <tr key={s.id} className={s.vor_ready ? 'is-ready' : undefined}>
                  <td className="vrs-num">{n}</td>
                  <td>
                    {canEdit ? (
                      <DraftField
                        value={s.rd_set}
                        label={`Комплект РД, ${rowLabel}`}
                        placeholder="Название комплекта"
                        maxLength={500}
                        autoFocus={focusId === s.id}
                        onSave={(v) => save(s, { rd_set: v })}
                      />
                    ) : (s.rd_set || <span className="vrs-empty">—</span>)}
                  </td>
                  <td>
                    <ReadyToggle
                      value={!!s.vor_ready}
                      canEdit={canEdit}
                      label={`ВОР готов, ${rowLabel}`}
                      onSave={(v) => save(s, { vor_ready: v })}
                    />
                  </td>
                  <td>
                    <DueDateField
                      value={s.vor_due_date}
                      ready={!!s.vor_ready}
                      canEdit={canEdit}
                      label={`Срок выдачи ВОРа, ${rowLabel}`}
                      onSave={(v) => save(s, { vor_due_date: v })}
                    />
                  </td>
                  <td>
                    <LinkField
                      value={s.link}
                      canEdit={canEdit}
                      label={`Ссылка на РД и ВОР, ${rowLabel}`}
                      onSave={(v) => save(s, { link: v })}
                    />
                  </td>
                  <td>
                    {canEdit ? (
                      <DraftField
                        multiline
                        value={s.note}
                        label={`Примечание, ${rowLabel}`}
                        placeholder="Примечание"
                        maxLength={4000}
                        onSave={(v) => save(s, { note: v || null })}
                      />
                    ) : (s.note ? <span className="vrs-note-text">{s.note}</span> : <span className="vrs-empty">—</span>)}
                  </td>
                  {canEdit && (
                    <td className="vrs-act">
                      <button
                        type="button"
                        className="vrs-icon-btn is-danger"
                        onClick={() => remove(s, n)}
                        title="Удалить комплект"
                        aria-label={`Удалить ${rowLabel}`}
                      >
                        <IconTrash size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="vrs-panel">
      <div className="vrs-head">
        <span className="vrs-title">Комплекты РД</span>
        {status === 'ok' && sets.length > 0 && (
          <span className={`vrs-sum${readyCount === sets.length ? ' is-done' : ''}`}>
            ВОР готов: {readyCount} из {sets.length}
          </span>
        )}
      </div>
      {body}
      {addButton && <div className="vrs-foot">{addButton}</div>}
    </div>
  )
}
