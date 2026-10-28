import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import {
  createDepartment, deleteDepartment, fetchDepartments, saveDepartmentContacts, saveDepartmentOrder, updateDepartment,
} from '../services/companyDepartments'
import {
  DEPARTMENTS_MIGRATION_HINT, MAX_CONTACTS, formatPhone, groupDepartments, isOspDepartment, matchesDepartment,
  moveDepartment, numberDepartments, parseContactsList, phoneHref,
} from '../utils/companyDepartments'
import { fetchCostPlanEconomists, fetchEconomistObjects } from '../services/costPlanEconomists'
import { groupByEconomist } from '../utils/costPlanEconomists'
import { IconPencil, IconTrash } from '../components/icons/ActionIcons'
import '../components/GeneralInfo.css'
import './DepartmentsPage.css'

// «Общая информация» → «Отделы»: какие отделы есть в компании, за что отвечают, кто руководитель и как
// с ним связаться. Видят все сотрудники; правит администратор — карточка отдела (блок, название, функции,
// примечание, руководители и контакты), порядок стрелками и «Руководители списком» — много контактов разом.
// Данные — company_departments (миграция 20261104); ФИО и телефоны в коде не хранятся.
// Под «Отделом по сопровождению подрядчиков» — экономисты ОСП по объектам (cost_plan_economists): только просмотр,
// назначают в «Планах затрат» → «Документы». Перечитываются при возврате на вкладку браузера — так правка там видна
// здесь без перезагрузки.

const arrowProps = {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
}
const IconUp = () => <svg {...arrowProps}><path d="m18 15-6-6-6 6" /></svg>
const IconDown = () => <svg {...arrowProps}><path d="m6 9 6 6 6-6" /></svg>
const IconPhone = () => (
  <svg {...arrowProps} width={13} height={13} strokeWidth={1.8}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
)

const EMPTY_FORM = { block: '', name: '', duties: '', note: '', contacts: [] }
const EMPTY_CONTACT = { name: '', position: '', phone: '' }

function DepartmentContacts({ dept }) {
  const contacts = dept.contacts || []
  if (!contacts.length && !dept.note) return <span className="dp-muted">Руководитель не указан</span>
  return (
    <>
      {dept.note && <div className="dp-note-line">{dept.note}</div>}
      {contacts.map((c, i) => {
        const href = phoneHref(c.phone)
        return (
          <div key={i} className="dp-contact">
            {c.name && <span className="dp-contact-name">{c.name}</span>}
            {c.position && <span className="dp-contact-pos">{c.position}</span>}
            {c.phone && (href
              ? <a className="dp-contact-phone" href={href}><IconPhone />{formatPhone(c.phone)}</a>
              : <span className="dp-contact-phone">{c.phone}</span>)}
          </div>
        )
      })}
    </>
  )
}

function OspEconomists({ groups }) {
  return (
    <div role="cell" className="dp-econ" aria-label="Экономисты ОСП">
      <div className="dp-econ-title">Экономисты ОСП — ответственные за планы затрат</div>
      <ul className="dp-econ-list">
        {groups.map(g => {
          const href = phoneHref(g.contact.phone)
          return (
            <li key={g.contact.id || g.contact.full_name} className="dp-econ-item">
              <span className="dp-contact-name">{g.contact.full_name}</span>
              {g.contact.phone && (href
                ? <a className="dp-contact-phone" href={href}><IconPhone />{formatPhone(g.contact.phone)}</a>
                : <span className="dp-contact-phone">{g.contact.phone}</span>)}
              <span className="dp-econ-objects">{g.objects.map(o => o.name).join(', ')}</span>
            </li>
          )
        })}
      </ul>
      <div className="dp-econ-note">
        Назначает администратор в <Link to="/cost-plans">«Планах затрат»</Link> → «Документы».
      </div>
    </div>
  )
}

function DepartmentModal({ initial, blocks, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    ...initial,
    note: initial?.note || '',
    contacts: initial?.contacts?.length ? initial.contacts.map(c => ({ ...EMPTY_CONTACT, ...c })) : [{ ...EMPTY_CONTACT }],
  }))
  const [saving, setSaving] = useState(false)
  const set = (field, value) => setForm(prev => ({ ...prev, [field]: value }))
  const setContact = (idx, field, value) => setForm(prev => ({
    ...prev,
    contacts: prev.contacts.map((c, i) => (i === idx ? { ...c, [field]: value } : c)),
  }))

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    try {
      await onSave(form)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal dp-modal" role="dialog" aria-modal="true" aria-labelledby="dp-modal-title">
        <div className="modal-header">
          <h3 id="dp-modal-title">{initial?.id ? 'Отдел' : 'Новый отдел'}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <form onSubmit={submit}>
          <div className="form-grid">
            <div className="form-group full-width">
              <label htmlFor="dp-name">Название отдела *</label>
              <input id="dp-name" type="text" value={form.name} required autoFocus maxLength={300}
                onChange={(e) => set('name', e.target.value)} />
            </div>
            <div className="form-group full-width">
              <label htmlFor="dp-block">Блок</label>
              <input id="dp-block" type="text" value={form.block} list="dp-blocks" maxLength={200}
                placeholder="Например, Тендеры или Финансы" onChange={(e) => set('block', e.target.value)} />
              <datalist id="dp-blocks">{blocks.map(b => <option key={b} value={b} />)}</datalist>
            </div>
            <div className="form-group full-width">
              <label htmlFor="dp-duties">Основные функции</label>
              <textarea id="dp-duties" rows={4} value={form.duties} maxLength={4000}
                onChange={(e) => set('duties', e.target.value)} />
            </div>
            <div className="form-group full-width">
              <label htmlFor="dp-note">Примечание к руководителю</label>
              <input id="dp-note" type="text" value={form.note} maxLength={1000}
                placeholder="Например, Руководитель отсутствует" onChange={(e) => set('note', e.target.value)} />
            </div>
            <fieldset className="form-group full-width dp-contacts-edit">
              <legend>Руководители и контакты</legend>
              {form.contacts.map((c, idx) => (
                <div key={idx} className="dp-contact-edit">
                  <input type="text" value={c.name} placeholder="ФИО" aria-label={`ФИО, контакт ${idx + 1}`} maxLength={200}
                    onChange={(e) => setContact(idx, 'name', e.target.value)} />
                  <input type="text" value={c.position} placeholder="Должность или за что отвечает"
                    aria-label={`Должность, контакт ${idx + 1}`} maxLength={300}
                    onChange={(e) => setContact(idx, 'position', e.target.value)} />
                  <input type="tel" value={c.phone} placeholder="+7 900 000-00-00" aria-label={`Телефон, контакт ${idx + 1}`}
                    maxLength={100} onChange={(e) => setContact(idx, 'phone', e.target.value)} />
                  <button type="button" className="dp-icon-btn" aria-label={`Убрать контакт ${idx + 1}`}
                    onClick={() => set('contacts', form.contacts.filter((_, i) => i !== idx))}>×</button>
                </div>
              ))}
              {form.contacts.length < MAX_CONTACTS && (
                <button type="button" className="btn-secondary dp-add-contact"
                  onClick={() => set('contacts', [...form.contacts, { ...EMPTY_CONTACT }])}>+ Контакт</button>
              )}
            </fieldset>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving || !form.name.trim()}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ContactsListModal({ departments, onClose, onSave }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const parsed = useMemo(() => parseContactsList(text, departments), [text, departments])
  const canSave = parsed.lines.length > 0 && parsed.errors.length === 0 && !saving

  const save = async () => {
    setSaving(true)
    try {
      await onSave(parsed.updates)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal dp-modal dp-modal-wide" role="dialog" aria-modal="true" aria-labelledby="dp-list-title">
        <div className="modal-header">
          <h3 id="dp-list-title">Руководители списком</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="dp-list-body">
          <p className="dp-list-help">
            По строке на человека: <code>№ отдела | ФИО | должность | телефон</code>. Вместо номера можно написать
            название отдела; должность и телефон — по желанию. Можно вставить столбцы из Excel. Отделы из списка
            получат ровно эти контакты, остальные не изменятся.
          </p>
          <textarea className="dp-list-text" rows={10} value={text} onChange={(e) => setText(e.target.value)}
            aria-label="Список руководителей" placeholder={'1 | Иванов Иван Иванович | Руководитель | +7 900 000-00-00'} />
          {parsed.errors.length > 0 && (
            <ul className="dp-list-errors" role="alert">
              {parsed.errors.map(err => <li key={err.line}>Строка {err.line}: {err.reason} — «{err.text}»</li>)}
            </ul>
          )}
          {parsed.lines.length > 0 && (
            <>
              <div className="dp-list-summary">
                Контактов: {parsed.lines.length}, отделов: {parsed.updates.size}
              </div>
              <div className="dp-list-preview">
                <table className="data-table">
                  <thead>
                    <tr><th>Отдел</th><th>ФИО</th><th>Должность</th><th>Телефон</th></tr>
                  </thead>
                  <tbody>
                    {parsed.lines.map(l => (
                      <tr key={l.line}>
                        <td>{l.department.name}</td>
                        <td>{l.contact.name || '—'}</td>
                        <td>{l.contact.position || '—'}</td>
                        <td className="dp-nowrap">{l.contact.phone || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer dp-list-footer">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="button" className="btn-primary" onClick={save} disabled={!canSave}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DepartmentsPage() {
  const { isAdmin } = useRole()
  const [rows, setRows] = useState([])
  const [supported, setSupported] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null) // null | {} (новый) | строка
  const [showList, setShowList] = useState(false)
  // Экономисты ОСП: [{ contact, objects }]; пусто — не назначены, нет таблицы или не загрузились.
  const [economists, setEconomists] = useState([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetchDepartments()
      setRows(res.rows)
      setSupported(res.supported)
      setError(null)
    } catch (err) {
      console.error('Ошибка загрузки отделов:', err.message)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Экономисты — отдельно от отделов: их нет (миграция 20261110 не применена) — страница как раньше.
  useEffect(() => {
    let alive = true
    // «Фокус» и «вкладка видна» приходят вместе: пока идёт чтение, второе не начинаем, а повторяем одно — после
    // него (иначе событие во время чтения терялось бы вместе с правкой, сделанной до него).
    let inFlight = false
    let again = false
    const loadEconomists = async () => {
      if (inFlight) { again = true; return }
      inFlight = true
      try {
        do {
          again = false
          const [assigned, objects] = await Promise.all([fetchCostPlanEconomists(), fetchEconomistObjects()])
          if (alive) setEconomists(groupByEconomist(assigned.rows, objects).groups)
        } while (again && alive)
      } catch (err) {
        console.error('Экономисты ОСП не загрузились:', err.message)
      } finally {
        inFlight = false
      }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') loadEconomists() }
    loadEconomists()
    window.addEventListener('focus', loadEconomists)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.removeEventListener('focus', loadEconomists)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const numbered = useMemo(() => numberDepartments(rows), [rows])
  // Экономисты ОСП ищутся вместе с отделом: «Базаркин» или «ЗИЛ» находит отдел по сопровождению подрядчиков.
  const groups = useMemo(() => {
    const econContacts = economists.map(g => ({
      name: g.contact.full_name, position: g.objects.map(o => o.name).join(' '), phone: g.contact.phone,
    }))
    const searchable = (r) => (isOspDepartment(r) && econContacts.length
      ? { ...r, contacts: [...(r.contacts || []), ...econContacts] } : r)
    return groupDepartments(numbered.filter(r => matchesDepartment(searchable(r), search)))
  }, [numbered, search, economists])
  const blocks = useMemo(() => [...new Set(rows.map(r => r.block).filter(Boolean))], [rows])
  const found = groups.reduce((n, g) => n + g.items.length, 0)
  const canManage = isAdmin && supported

  const run = async (action, failText) => {
    setBusy(true)
    try {
      await action()
      await load()
      return true
    } catch (err) {
      alert(`${failText}: ${err.message || err}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (form) => {
    const ok = await run(async () => {
      if (editing?.id) await updateDepartment(editing.id, form)
      else await createDepartment(form, (rows.reduce((m, r) => Math.max(m, r.sort_order || 0), 0)) + 10)
    }, 'Не удалось сохранить отдел')
    if (ok) setEditing(null)
  }

  const handleDelete = (dept) => {
    if (!window.confirm(`Удалить отдел «${dept.name}» вместе с его контактами?`)) return
    run(() => deleteDepartment(dept.id), 'Не удалось удалить отдел')
  }

  const handleMove = (dept, delta) => {
    const updates = moveDepartment(rows, dept.id, delta)
    if (!updates) return
    run(() => saveDepartmentOrder(updates), 'Не удалось изменить порядок')
  }

  const handleSaveList = async (updates) => {
    const ok = await run(() => saveDepartmentContacts(updates), 'Не удалось сохранить контакты')
    if (ok) setShowList(false)
  }

  return (
    <div className={`general-info departments-page${canManage ? ' dp-can-manage' : ''}`}>
      <div className="general-info-header dp-header">
        <div>
          <div className="dp-crumbs"><Link to="/general">Общая информация</Link></div>
          <h2>Отделы</h2>
          <div className="dp-subtitle">За что отвечает каждый отдел компании и к кому обращаться</div>
        </div>
        {canManage && (
          <div className="dp-header-actions">
            <button type="button" className="btn-secondary" onClick={() => setShowList(true)} disabled={busy || !rows.length}>
              Руководители списком
            </button>
            <button type="button" className="btn-primary" onClick={() => setEditing({})} disabled={busy}>+ Добавить отдел</button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : error ? (
        <div className="dp-empty">Не удалось загрузить отделы: {error}</div>
      ) : !supported ? (
        <div className="dp-empty">{DEPARTMENTS_MIGRATION_HINT}</div>
      ) : (
        <>
          <div className="dp-toolbar">
            <input
              type="search"
              className="dp-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск: отдел, функции, ФИО, телефон"
              aria-label="Поиск по отделам"
            />
            <span className="dp-count">
              {search.trim() ? `найдено ${found} из ${rows.length}` : `${rows.length} отд.`}
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="dp-empty">Отделов пока нет.{canManage ? ' Добавьте первый.' : ''}</div>
          ) : found === 0 ? (
            <div className="dp-empty">Ничего не найдено.</div>
          ) : groups.map(g => (
            <section key={g.block} className="dp-block" aria-label={g.block}>
              <h3 className="dp-block-title">{g.block}</h3>
              <div className="dp-table" role="table" aria-label={`Отделы: ${g.block}`}>
                <div className="dp-row dp-row-head" role="row">
                  <span role="columnheader" className="dp-num">№</span>
                  <span role="columnheader">Отдел и основные функции</span>
                  <span role="columnheader">Руководитель и контакты</span>
                  {canManage && <span role="columnheader" className="dp-sr-only">Действия</span>}
                </div>
                {g.items.map(dept => {
                  const idx = rows.findIndex(r => r.id === dept.id)
                  return (
                    <div key={dept.id} className="dp-row" role="row" data-dept-id={dept.id}>
                      <span role="cell" className="dp-num">{dept.number}</span>
                      <div role="cell" className="dp-main">
                        <div className="dp-name">{dept.name}</div>
                        {dept.duties && <p className="dp-duties">{dept.duties}</p>}
                      </div>
                      <div role="cell" className="dp-contacts"><DepartmentContacts dept={dept} /></div>
                      {canManage && (
                        <div role="cell" className="dp-actions">
                          <button type="button" className="dp-icon-btn" onClick={() => handleMove(dept, -1)}
                            disabled={busy || idx <= 0} aria-label={`Выше: ${dept.name}`} title="Выше"><IconUp /></button>
                          <button type="button" className="dp-icon-btn" onClick={() => handleMove(dept, 1)}
                            disabled={busy || idx >= rows.length - 1} aria-label={`Ниже: ${dept.name}`} title="Ниже"><IconDown /></button>
                          <button type="button" className="dp-icon-btn" onClick={() => setEditing(dept)}
                            disabled={busy} aria-label={`Изменить: ${dept.name}`} title="Изменить"><IconPencil size={15} /></button>
                          <button type="button" className="dp-icon-btn dp-icon-danger" onClick={() => handleDelete(dept)}
                            disabled={busy} aria-label={`Удалить: ${dept.name}`} title="Удалить"><IconTrash size={15} /></button>
                        </div>
                      )}
                      {economists.length > 0 && isOspDepartment(dept) && <OspEconomists groups={economists} />}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </>
      )}

      {editing && (
        <DepartmentModal initial={editing} blocks={blocks} onClose={() => setEditing(null)} onSave={handleSave} />
      )}
      {showList && (
        <ContactsListModal departments={rows} onClose={() => setShowList(false)} onSave={handleSaveList} />
      )}

    </div>
  )
}

export default DepartmentsPage
