import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../../api'
import { useRole, SECTIONS } from '../../contexts/RoleContext'
import FilterDropdown from '../FilterDropdown'
import { IconPencil, IconTrash } from '../icons/ActionIcons'
import { IconObject, IconUser } from '../icons/ToolbarIcons'
import { roleKeyFromLabel, sameRoleLabel } from '../../utils/roleKey'

// «Администрирование» → «Права доступа» (03.11, решение пользователя): одна вкладка вместо трёх — «Роли», «Права доступа» и
// «Просмотр от имени роли». Всё про выбранную роль — рядом с её выбором:
//   • добавить роль — только название, служебный ключ выдаётся сам (roleKeyFromLabel); переименовать и удалить — у
//     заведённых администратором, системные не меняются;
//   • права по разделам — как раньше, сохраняются сразу;
//   • посмотреть от имени роли — в том числе подрядчика: у него нет разделов с галочками, только кабинет, поэтому вместо
//     таблицы — выбор организации, под которую кабинет фильтруется.

const ADMIN = 'admin'
const CONTRACTOR = 'contractor'
const sectionKeys = Object.keys(SECTIONS)

export default function AccessRightsTab({ objects, counterparties, onNeedCounterparties }) {
  const navigate = useNavigate()
  const {
    availableRoles, roleLabels, refreshAvailableRoles,
    canPreviewRoles, previewActive, previewInfo, startRolePreview, stopRolePreview,
  } = useRole()

  const [permissions, setPermissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('engineer')
  const [feedback, setFeedback] = useState(null)
  // Открытая строка под выбором роли: добавление или переименование — { mode: 'add' | 'rename', value }.
  const [editor, setEditor] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewObjects, setPreviewObjects] = useState([])
  const [previewCounterparty, setPreviewCounterparty] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)

  // «Подрядчик» — системная роль, но и в базе без неё просмотр кабинета должен быть доступен.
  const hasContractor = availableRoles.some(r => r.key === CONTRACTOR)
  const employeeRoles = availableRoles.filter(r => r.key !== CONTRACTOR)
  const role = availableRoles.find(r => r.key === selected)
  const custom = !!role && !role.is_system
  const isContractor = selected === CONTRACTOR
  const label = roleLabels[selected] || selected
  const showPreview = canPreviewRoles && (isContractor || previewOpen)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { data, error } = await db.from('role_permissions').select('*').order('role')
        if (error) throw error
        if (!cancelled) setPermissions(data || [])
      } catch (err) {
        console.error('Ошибка загрузки прав:', err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Контрагентов — тысячи: только когда выбрали подрядчика.
  useEffect(() => { if (isContractor) onNeedCounterparties() }, [isContractor, onNeedCounterparties])

  const show = (kind, text) => {
    setFeedback({ kind, text })
    setTimeout(() => setFeedback(null), kind === 'ok' ? 1800 : 5000)
  }

  const selectRole = (key) => {
    setSelected(key)
    setEditor(null)
    setPreviewOpen(false)
    setPreviewError('')
  }

  // ── Роли ────────────────────────────────────────────────────────────────
  const submitEditor = async (e) => {
    e.preventDefault()
    const value = editor.value.trim()
    if (!value) { show('err', 'Укажите название роли'); return }
    const others = availableRoles.filter(r => editor.mode === 'add' || r.key !== selected)
    if (others.some(r => sameRoleLabel(r.label, value))) { show('err', 'Роль с таким названием уже есть'); return }
    try {
      if (editor.mode === 'add') {
        const key = roleKeyFromLabel(value, availableRoles.map(r => r.key))
        const { error } = await db.from('roles').insert([{ key, label: value, is_system: false }])
        if (error) throw error
        await refreshAvailableRoles()
        setSelected(key)
        show('ok', 'Роль добавлена — отметьте её права')
      } else {
        const { error } = await db.from('roles').update({ label: value }).eq('key', selected)
        if (error) throw error
        await refreshAvailableRoles()
        show('ok', 'Сохранено')
      }
      setEditor(null)
    } catch (err) {
      if (err.code === '23505') show('err', 'Такая роль уже есть')
      else if (/relation .* does not exist/i.test(err.message)) show('err', 'Таблица roles не создана. Примените миграцию 20260507_roles_table.sql.')
      else show('err', 'Ошибка: ' + err.message)
    }
  }

  const deleteRole = async () => {
    if (!window.confirm(`Удалить роль «${label}»? Её права удалятся, пользователи с этой ролью станут «Инженером ОСП».`)) return
    try {
      await db.from('role_permissions').delete().eq('role', selected)
      await db.from('user_roles').update({ role: 'engineer' }).eq('role', selected)
      const { error } = await db.from('roles').delete().eq('key', selected).eq('is_system', false)
      if (error) throw error
      await refreshAvailableRoles()
      setPermissions(prev => prev.filter(p => p.role !== selected))
      selectRole('engineer')
      show('ok', 'Роль удалена')
    } catch (err) {
      show('err', 'Ошибка: ' + err.message)
    }
  }

  // ── Права ───────────────────────────────────────────────────────────────
  const togglePermission = async (section, field) => {
    const existing = permissions.find(p => p.role === selected && p.section === section)
    const currentView = existing?.can_view ?? false
    const currentEdit = existing?.can_edit ?? false
    const next = { can_view: currentView, can_edit: currentEdit }
    if (field === 'can_view') { next.can_view = !currentView; if (!next.can_view) next.can_edit = false }
    else { next.can_edit = !currentEdit; if (next.can_edit) next.can_view = true }
    try {
      if (existing) {
        const { error } = await db.from('role_permissions').update(next).eq('id', existing.id)
        if (error) throw error
        setPermissions(prev => prev.map(p => (p.id === existing.id ? { ...p, ...next } : p)))
      } else {
        const { data, error } = await db.from('role_permissions').insert([{ role: selected, section, ...next }]).select().single()
        if (error) throw error
        if (data) setPermissions(prev => [...prev, data])
      }
      show('ok', 'Сохранено')
    } catch (err) {
      if (/valid_perm_role|check constraint/i.test(err.message)) show('err', `Ошибка: роль «${label}» отсутствует в CHECK-constraint таблицы role_permissions. Примените миграцию для этой роли.`)
      else show('err', 'Ошибка: ' + err.message)
    }
  }

  // ── Просмотр от имени роли ──────────────────────────────────────────────
  const startPreview = async () => {
    setPreviewError('')
    // Кабинет подрядчика фильтруется по организации — без неё показывать нечего.
    if (isContractor && !previewCounterparty) {
      setPreviewError('Выберите организацию: кабинет подрядчика показывает её тендеры и договоры.')
      return
    }
    setPreviewBusy(true)
    try {
      const cp = counterparties.find(c => c.id === previewCounterparty)
      await startRolePreview(selected, {
        objectIds: isContractor ? [] : previewObjects,
        counterparty: isContractor && cp ? { id: cp.id, name: cp.name } : null,
      })
      navigate(isContractor ? '/contractor' : '/general')
    } catch (err) {
      setPreviewError(err.message || String(err))
    } finally {
      setPreviewBusy(false)
    }
  }

  return (
    <div className="permissions-pane">
      <div className="perm-bar">
        <label htmlFor="perm-role-select">Роль</label>
        <select id="perm-role-select" value={selected} onChange={(e) => selectRole(e.target.value)}>
          <optgroup label="Сотрудники">
            {employeeRoles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </optgroup>
          <optgroup label="Внешние пользователи">
            <option value={CONTRACTOR}>{roleLabels[CONTRACTOR] || 'Подрядчик'}{hasContractor ? '' : ' (нет в справочнике)'}</option>
          </optgroup>
        </select>
        {custom && (
          <>
            <button
              type="button"
              className="adm-iconbtn"
              title="Переименовать роль"
              aria-label={`Переименовать роль «${label}»`}
              onClick={() => setEditor({ mode: 'rename', value: role.label })}
            ><IconPencil size={15} /></button>
            <button
              type="button"
              className="adm-iconbtn adm-iconbtn-danger"
              title="Удалить роль"
              aria-label={`Удалить роль «${label}»`}
              onClick={deleteRole}
            ><IconTrash size={15} /></button>
          </>
        )}
        <button type="button" className="btn-soft" onClick={() => setEditor({ mode: 'add', value: '' })}>+ Добавить роль</button>
        {feedback && <span className={`perm-feedback ${feedback.kind}`} role="status">{feedback.text}</span>}
        {canPreviewRoles && !isContractor && !previewActive && (
          <button
            type="button"
            className={`btn-soft perm-bar-end${previewOpen ? ' is-active' : ''}`}
            aria-expanded={previewOpen}
            onClick={() => { setPreviewOpen(v => !v); setPreviewError('') }}
          >Посмотреть от имени роли</button>
        )}
      </div>

      {editor && (
        <form className="perm-editor" onSubmit={submitEditor}>
          <label htmlFor="perm-role-name">{editor.mode === 'add' ? 'Название новой роли' : `Новое название роли «${label}»`}</label>
          <input
            id="perm-role-name"
            type="text"
            autoFocus
            maxLength={80}
            value={editor.value}
            onChange={(e) => setEditor({ ...editor, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditor(null) }}
            placeholder="Например: Прораб"
          />
          <button type="submit" className="btn-primary">{editor.mode === 'add' ? 'Добавить' : 'Сохранить'}</button>
          <button type="button" className="btn-soft" onClick={() => setEditor(null)}>Отмена</button>
        </form>
      )}

      {previewActive && (
        <div className="perm-preview-active">
          <span>
            Сейчас включён просмотр: <strong>{roleLabels[previewInfo.role] || previewInfo.role}</strong>
            {previewInfo.counterparty?.name && <> · {previewInfo.counterparty.name}</>}
          </span>
          <button type="button" className="btn-primary" onClick={stopRolePreview}>Вернуться к своей роли</button>
        </div>
      )}

      {isContractor && (
        <div className="perm-admin-notice">
          У подрядчика нет разделов с галочками: он работает только в своём кабинете — тендеры, расценка, анкета и договоры
          своей организации.
        </div>
      )}

      {showPreview && !previewActive && (
        <div className="perm-preview">
          <div className="perm-preview-fields">
            {isContractor ? (
              <div className="perm-preview-field">
                <span className="perm-preview-label">Организация подрядчика</span>
                <FilterDropdown
                  label=""
                  searchable
                  searchPlaceholder="Поиск организации…"
                  allLabel="Выберите организацию"
                  icon={<IconUser size={15} />}
                  value={previewCounterparty}
                  onChange={(v) => setPreviewCounterparty(v || '')}
                  options={counterparties.map(c => ({ value: c.id, label: c.name }))}
                />
              </div>
            ) : (
              <div className="perm-preview-field">
                <span className="perm-preview-label">Привязка к объектам</span>
                <FilterDropdown
                  label=""
                  multiple
                  searchable
                  searchPlaceholder="Поиск объекта…"
                  allLabel="Все объекты (офисный сотрудник)"
                  icon={<IconObject size={15} />}
                  value={previewObjects}
                  onChange={setPreviewObjects}
                  options={objects.map(o => ({ value: o.id, label: o.name }))}
                />
              </div>
            )}
            <button type="button" className="btn-primary" onClick={startPreview} disabled={previewBusy}>
              {previewBusy ? 'Включение…' : isContractor ? 'Посмотреть как подрядчик' : `Посмотреть как «${label}»`}
            </button>
          </div>
          {previewError && <div className="perm-preview-error" role="alert">{previewError}</div>}
          <p className="perm-preview-note">
            Показывается интерфейс роли: меню, разделы и кнопки. Запросы идут под вашей учётной записью, поэтому ограничения самой
            базы остаются вашими, а изменения сохранятся от вашего имени.
          </p>
        </div>
      )}

      {selected === ADMIN ? (
        <div className="perm-admin-notice">Права администратора изменять нельзя — у роли «Администратор» полный доступ ко всем разделам.</div>
      ) : !isContractor && (
        loading ? <div className="admin-loading">Загрузка...</div> : (
          <>
            <table className="admin-table permissions-list-table">
              <thead><tr><th className="section-header">Раздел</th><th className="perm-col">Просмотр</th><th className="perm-col">Редактирование</th></tr></thead>
              <tbody>
                {sectionKeys.map(section => {
                  const perm = permissions.find(p => p.role === selected && p.section === section)
                  return (
                    <tr key={section}>
                      <td className="section-name">{SECTIONS[section]}</td>
                      <td className="perm-cell"><input type="checkbox" aria-label={`${SECTIONS[section]}: просмотр`} checked={perm?.can_view ?? false} onChange={() => togglePermission(section, 'can_view')} /></td>
                      <td className="perm-cell"><input type="checkbox" aria-label={`${SECTIONS[section]}: редактирование`} checked={perm?.can_edit ?? false} onChange={() => togglePermission(section, 'can_edit')} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="permissions-legend">
              <span>Просмотр — открывать раздел</span>
              <span>Редактирование — менять данные</span>
              <span>Изменения сохраняются автоматически</span>
            </div>
          </>
        )
      )}
    </div>
  )
}
