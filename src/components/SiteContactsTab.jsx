import { useCallback, useEffect, useMemo, useState } from 'react'
import { VOR_DIVISIONS } from '../utils/vorDivisions'
import { formatSiteContact, phoneHref, telegramHref, telegramLabel, validateSiteContact, SITE_CONTACT_LIMITS } from '../utils/siteContacts'
import {
  fetchSiteContacts, saveSiteContact, deleteSiteContact, SITE_CONTACTS_MIGRATION_HINT,
} from '../services/siteContacts'
import { describeSupabaseError } from '../utils/supabaseError'
import { IconPencil, IconTrash } from './icons/ActionIcons'

// «Документы раздела» → «Контакт площадки» (только «Тендеры — Основное строительство»):
// по выбранному объекту — список подразделений ВОР и кто встречает подрядчика на площадке
// (ФИО, телефон, Telegram). Назначает администратор; остальные видят. Контакт
// подставляется в письмо подрядчикам по объекту и подразделению тендера, и без него
// письмо не формируется (TendersPage).

// Последний выбранный объект — удобство одного браузера, не данные.
const OBJECT_KEY = 'tender-site-contacts:object'
const EMPTY_DRAFT = { full_name: '', phone: '', telegram: '' }

function readSavedObject() {
  try { return localStorage.getItem(OBJECT_KEY) || null } catch { return null }
}

export default function SiteContactsTab({ objects = [], canEdit = false, initialObjectId = null }) {
  const [state, setState] = useState({ loading: true, rows: [], supported: true, error: null })
  const [objectId, setObjectId] = useState(() => initialObjectId || readSavedObject())
  const [editing, setEditing] = useState(null) // { division, full_name, phone, telegram }
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const { rows, supported } = await fetchSiteContacts()
      setState({ loading: false, rows, supported, error: null })
    } catch (err) {
      setState({ loading: false, rows: [], supported: true, error: describeSupabaseError(err) })
    }
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
      + 'Пока не назначат новый, письмо подрядчикам по тендерам этого подразделения на объекте не сформируется.',
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

  return (
    <div className="tdm-body tdm-site">
      <p className="tdm-lead">
        Кто встречает подрядчика на объекте, если потребуется выезд. Контакт подставляется
        в письмо подрядчикам по объекту и подразделению тендера — без него письмо не формируется.
        {!canEdit && ' Назначает администратор.'}
      </p>

      {!state.supported && <p className="tdm-note">{SITE_CONTACTS_MIGRATION_HINT}</p>}
      {state.error && (
        <p className="tdm-note">
          Не удалось загрузить контакты: {state.error}{' '}
          <button type="button" className="tdm-site-link" onClick={load}>Повторить</button>
        </p>
      )}

      {state.supported && !state.error && (objects.length === 0 ? (
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
                  {o.name}{state.loading ? '' : ` — назначено ${contactsOf(o.id).size} из ${VOR_DIVISIONS.length}`}
                </option>
              ))}
            </select>
          </label>

          {state.loading ? (
            <p className="tdm-site-empty-state">Загрузка…</p>
          ) : (
            <ul className="tdm-site-list" aria-label={`Контакты площадки: ${selectedObject?.name || ''}`}>
              {VOR_DIVISIONS.map(d => {
                const contact = contactsOf(selectedId).get(d.value)
                const isEditing = editing?.division === d.value
                const tgHref = telegramHref(contact?.telegram)
                const telHref = phoneHref(contact?.phone)
                return (
                  <li key={d.value} className={`tdm-site-row${contact ? '' : ' is-empty'}${isEditing ? ' is-editing' : ''}`} data-division={d.value}>
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
                          <div className="tdm-site-person" title={formatSiteContact(contact)}>
                            <span className="tdm-person">{contact.full_name}</span>
                            <span className="tdm-site-meta">
                              {telHref ? <a href={telHref}>{contact.phone}</a> : contact.phone}
                              {contact.telegram && (
                                <>
                                  <span aria-hidden> · </span>
                                  {tgHref
                                    ? <a href={tgHref} target="_blank" rel="noopener noreferrer">Telegram: {telegramLabel(contact.telegram)}</a>
                                    : <span>Telegram: {contact.telegram}</span>}
                                </>
                              )}
                            </span>
                          </div>
                        ) : (
                          <span className="tdm-site-none">Не назначен</span>
                        )}
                        {canEdit && (
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
