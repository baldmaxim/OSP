import { useCallback, useEffect, useMemo, useState } from 'react'
import { VOR_DIVISIONS } from '../utils/vorDivisions'
import {
  pickSiteContact, phoneHref, telegramHref, telegramLabel, validateSiteContact, SITE_CONTACT_LIMITS,
} from '../utils/siteContacts'
import {
  fetchSiteContacts, fetchObjectManagers, saveSiteContact, deleteSiteContact, SITE_CONTACTS_MIGRATION_HINT,
} from '../services/siteContacts'
import { describeSupabaseError } from '../utils/supabaseError'
import { IconPencil, IconTrash } from './icons/ActionIcons'

// «Документы раздела» → «Контакт площадки» (только «Тендеры — Основное строительство»):
// по выбранному объекту — список подразделений ВОР и кто встречает подрядчика на площадке
// (ФИО, телефон, Telegram). Назначает администратор; остальные видят. ФИО и телефон
// подставляются в письмо подрядчикам по объекту и подразделению тендера (TendersPage).
//
// Подразделение без своего контакта временно закрывает руководитель строительства объекта
// («Общая информация → Объекты») — с пометкой «временно, требуется заполнение». Нет и его —
// красным: письмо всё равно формируется, но контакт инженер впишет сам.

// Последний выбранный объект — удобство одного браузера, не данные.
const OBJECT_KEY = 'tender-site-contacts:object'
const EMPTY_DRAFT = { full_name: '', phone: '', telegram: '' }

function readSavedObject() {
  try { return localStorage.getItem(OBJECT_KEY) || null } catch { return null }
}

function PersonLine({ person, showTelegram = true }) {
  const telHref = phoneHref(person.phone)
  const tgHref = telegramHref(person.telegram)
  const phone = String(person.phone || '').trim()
  return (
    <div className="tdm-site-person-item">
      <span className="tdm-person">{person.full_name}</span>
      <span className="tdm-site-meta">
        {phone
          ? (telHref ? <a href={telHref}>{phone}</a> : phone)
          : <span className="tdm-site-warn-text">телефон не указан</span>}
        {showTelegram && person.telegram && (
          <>
            <span aria-hidden> · </span>
            {tgHref
              ? <a href={tgHref} target="_blank" rel="noopener noreferrer">Telegram: {telegramLabel(person.telegram)}</a>
              : <span>Telegram: {person.telegram}</span>}
          </>
        )}
      </span>
    </div>
  )
}

export default function SiteContactsTab({ objects = [], canEdit = false, initialObjectId = null }) {
  const [state, setState] = useState({ loading: true, rows: [], supported: true, error: null })
  // Руководители строительства: Map<object_id, [{ full_name, phone }]>; null — не загрузились.
  const [managers, setManagers] = useState(null)
  const [managersError, setManagersError] = useState(null)
  const [objectId, setObjectId] = useState(() => initialObjectId || readSavedObject())
  const [editing, setEditing] = useState(null) // { division, full_name, phone, telegram }
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }))
    setManagersError(null)
    const [contacts, staff] = await Promise.allSettled([fetchSiteContacts(), fetchObjectManagers()])
    if (contacts.status === 'fulfilled') {
      setState({ loading: false, rows: contacts.value.rows, supported: contacts.value.supported, error: null })
    } else {
      setState({ loading: false, rows: [], supported: true, error: describeSupabaseError(contacts.reason) })
    }
    if (staff.status === 'fulfilled') setManagers(staff.value)
    else { setManagers(null); setManagersError(describeSupabaseError(staff.reason)) }
  }, [])

  useEffect(() => { load() }, [load])

  // Объекты приходят со страницы позже окна — выбранный проверяем, когда список есть.
  const selectedId = objects.some(o => o.id === objectId) ? objectId : (objects[0]?.id || null)
  const selectedObject = objects.find(o => o.id === selectedId) || null

  const byObject = useMemo(() => {
    const map = new Map()
    for (const r of state.rows) {
      if (!map.has(r.object_id)) map.set(r.object_id, new Map())
      map.get(r.object_id).set(r.division, r)
    }
    return map
  }, [state.rows])
  const contactsOf = (id) => byObject.get(id) || new Map()
  const managersOf = (id) => managers?.get(id) || []
  // Руководители не загрузились — «нет руководителя» не утверждаем.
  const hasNoManager = (id) => managers !== null && managersOf(id).length === 0

  const chooseObject = (id) => {
    setObjectId(id)
    setEditing(null)
    setFormError(null)
    try { localStorage.setItem(OBJECT_KEY, id) } catch { /* noop */ }
  }

  const startEdit = (division) => {
    const current = contactsOf(selectedId).get(division)
    setEditing({
      division,
      full_name: current?.full_name || EMPTY_DRAFT.full_name,
      phone: current?.phone || EMPTY_DRAFT.phone,
      telegram: current?.telegram || EMPTY_DRAFT.telegram,
    })
    setFormError(null)
  }
  const cancelEdit = () => { setEditing(null); setFormError(null) }

  const submit = async (e) => {
    e.preventDefault()
    if (!editing || !selectedId || busy) return
    const { value, error } = validateSiteContact(editing)
    if (error) { setFormError(error); return }
    setBusy(true)
    setFormError(null)
    try {
      const saved = await saveSiteContact(selectedId, editing.division, value)
      setState(prev => ({
        ...prev,
        rows: [...prev.rows.filter(r => !(r.object_id === saved.object_id && r.division === saved.division)), saved],
      }))
      setEditing(null)
    } catch (err) {
      setFormError(err?.code === '42501'
        ? 'Назначать контакты площадки может только администратор.'
        : 'Не удалось сохранить: ' + describeSupabaseError(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (division, label) => {
    const current = contactsOf(selectedId).get(division)
    if (!current || busy) return
    const ok = window.confirm(
      `Убрать контакт площадки «${label}» на объекте «${selectedObject?.name || ''}»?\n\n`
      + 'Пока не назначат новый, в письмо подрядчикам по тендерам этого подразделения на объекте пойдёт '
      + 'руководитель строительства объекта.',
    )
    if (!ok) return
    setBusy(true)
    try {
      await deleteSiteContact(current.id)
      setState(prev => ({ ...prev, rows: prev.rows.filter(r => r.id !== current.id) }))
      if (editing?.division === division) setEditing(null)
    } catch (err) {
      alert('Не удалось убрать контакт: ' + describeSupabaseError(err))
    } finally {
      setBusy(false)
    }
  }

  const field = (key) => ({
    value: editing?.[key] || '',
    maxLength: SITE_CONTACT_LIMITS[key],
    onChange: (e) => setEditing(prev => ({ ...prev, [key]: e.target.value })),
  })

  // Назначать можно, только когда таблица есть (миграция 20261030 применена).
  const editable = canEdit && state.supported
  const own = contactsOf(selectedId)
  const tempCount = VOR_DIVISIONS.filter(d => !own.has(d.value)).length
  const objectHref = selectedId ? `/general/objects/${selectedId}` : null

  return (
    <div className="tdm-body tdm-site">
      <p className="tdm-lead">
        Кто встречает подрядчика на объекте, если потребуется выезд. ФИО и телефон подставляются
        в письмо подрядчикам по объекту и подразделению тендера. Пока ответственный подразделения
        не назначен, в письмо идёт руководитель строительства объекта.
        {!canEdit && ' Назначает администратор.'}
      </p>

      {!state.supported && <p className="tdm-note">{SITE_CONTACTS_MIGRATION_HINT}</p>}
      {state.error && (
        <p className="tdm-note">
          Не удалось загрузить контакты: {state.error}{' '}
          <button type="button" className="tdm-site-link" onClick={load}>Повторить</button>
        </p>
      )}
      {managersError && (
        <p className="tdm-note">
          Не удалось загрузить руководителей строительства: {managersError}{' '}
          <button type="button" className="tdm-site-link" onClick={load}>Повторить</button>
        </p>
      )}

      {!state.error && (objects.length === 0 ? (
        <p className="tdm-site-empty-state">Нет объектов основного строительства.</p>
      ) : (
        <>
          <label className="tdm-site-object">
            <span className="tdm-site-object-label">Объект</span>
            <select
              value={selectedId || ''}
              onChange={(e) => chooseObject(e.target.value)}
              disabled={busy}
            >
              {objects.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {state.loading ? '' : ` — назначено ${contactsOf(o.id).size} из ${VOR_DIVISIONS.length}`}
                  {!state.loading && hasNoManager(o.id) ? ' · нет руководителя строительства' : ''}
                </option>
              ))}
            </select>
          </label>

          {!state.loading && managers !== null && tempCount > 0 && (hasNoManager(selectedId) ? (
            <p className="tdm-site-alert is-error" role="alert">
              <b>Требуется заполнение.</b> Подразделений без ответственного: {tempCount} из {VOR_DIVISIONS.length},
              а в карточке объекта не указан руководитель строительства — в письмо по этим подразделениям
              контакт не подставится, инженер впишет его вручную. Укажите руководителя в{' '}
              <a href={objectHref} target="_blank" rel="noopener noreferrer">«Общая информация → Объекты»</a>
              {editable ? ' или назначьте ответственных ниже.' : '.'}
            </p>
          ) : (
            <p className="tdm-site-alert is-temp">
              <b>Временное решение.</b> Подразделений без ответственного: {tempCount} из {VOR_DIVISIONS.length} — у них
              указан руководитель строительства объекта. Требуется назначить ответственных подразделений.
            </p>
          ))}

          {state.loading ? (
            <p className="tdm-site-empty-state">Загрузка…</p>
          ) : (
            <ul className="tdm-site-list" aria-label={`Контакты площадки: ${selectedObject?.name || ''}`}>
              {VOR_DIVISIONS.map(d => {
                const contact = own.get(d.value) || null
                const pick = pickSiteContact(contact, managersOf(selectedId))
                const isEditing = editing?.division === d.value
                const missing = pick.source === 'none' && managers !== null
                const rowClass = contact ? '' : (missing ? ' is-missing' : ' is-temp')
                return (
                  <li key={d.value} className={`tdm-site-row${rowClass}${isEditing ? ' is-editing' : ''}`} data-division={d.value}>
                    <div className="tdm-site-div">{d.label}</div>
                    {isEditing ? (
                      <form
                        className="tdm-site-form"
                        onSubmit={submit}
                        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelEdit() } }}
                      >
                        <label>
                          <span>ФИО</span>
                          <input type="text" autoFocus required placeholder="Фамилия Имя Отчество" {...field('full_name')} />
                        </label>
                        <label>
                          <span>Телефон</span>
                          <input type="tel" required placeholder="+7 777 123-45-67" {...field('phone')} />
                        </label>
                        <label>
                          <span>Telegram</span>
                          <input type="text" placeholder="@имя или ссылка t.me" {...field('telegram')} />
                        </label>
                        {formError && <p className="tdm-site-error" role="alert">{formError}</p>}
                        <div className="tdm-site-form-actions">
                          <button type="button" className="btn-secondary" onClick={cancelEdit} disabled={busy}>Отмена</button>
                          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        {contact ? (
                          <div className="tdm-site-person">
                            <PersonLine person={contact} />
                          </div>
                        ) : pick.source === 'manager' ? (
                          <div className="tdm-site-person">
                            <span className="tdm-site-badge is-temp">Временно</span>
                            {pick.people.map((p, i) => <PersonLine key={i} person={p} showTelegram={false} />)}
                            <span className="tdm-site-hint">Руководитель строительства объекта — требуется назначить ответственного подразделения</span>
                          </div>
                        ) : (
                          <div className="tdm-site-person">
                            <span className="tdm-site-badge is-missing">{missing ? 'Требуется заполнение' : 'Не назначен'}</span>
                            <span className="tdm-site-hint is-missing">
                              {missing ? 'Не назначен, нет и руководителя строительства' : 'Не назначен'}
                            </span>
                          </div>
                        )}
                        {editable && (
                          <div className="tdm-site-actions">
                            {contact ? (
                              <>
                                <button
                                  type="button"
                                  className="btn-icon btn-edit"
                                  onClick={() => startEdit(d.value)}
                                  disabled={busy}
                                  title="Изменить контакт"
                                  aria-label={`Изменить контакт: ${d.label}`}
                                ><IconPencil size={14} /></button>
                                <button
                                  type="button"
                                  className="btn-icon btn-delete"
                                  onClick={() => remove(d.value, d.label)}
                                  disabled={busy}
                                  title="Убрать контакт"
                                  aria-label={`Убрать контакт: ${d.label}`}
                                ><IconTrash size={14} /></button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn-secondary tdm-site-assign"
                                onClick={() => startEdit(d.value)}
                                disabled={busy}
                                aria-label={`Назначить контакт: ${d.label}`}
                              >Назначить</button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ))}
    </div>
  )
}
