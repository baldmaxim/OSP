import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRole, SECTIONS } from '../contexts/RoleContext'
import './AdminPage.css'

function AdminPage() {
  const { isAdmin, availableRoles, roleLabels, refreshAvailableRoles } = useRole()
  const [activeTab, setActiveTab] = useState('users')

  // Список ролей-сотрудников (для селектов в users / permissions / form): всё кроме contractor
  const employeeRoleKeys = availableRoles
    .filter(r => r.key !== 'contractor')
    .map(r => r.key)

  // --- Users ---
  const [userRoles, setUserRoles] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [objectsList, setObjectsList] = useState([])

  // --- Permissions ---
  const [permissions, setPermissions] = useState([])
  const [loadingPerms, setLoadingPerms] = useState(true)
  const [selectedPermRole, setSelectedPermRole] = useState('engineer')
  const [permFeedback, setPermFeedback] = useState(null) // { kind: 'ok'|'err', text }

  // --- Roles (управление справочником) ---
  const [newRoleKey, setNewRoleKey] = useState('')
  const [newRoleLabel, setNewRoleLabel] = useState('')
  const [roleFeedback, setRoleFeedback] = useState(null)

  useEffect(() => {
    if (activeTab === 'users') {
      fetchUsers()
      fetchObjectsList()
    }
    else if (activeTab === 'permissions') fetchPermissions()
  }, [activeTab])

  const fetchObjectsList = async () => {
    try {
      const { data, error } = await supabase
        .from('objects')
        .select('id, name')
        .order('name', { ascending: true })
      if (error) throw error
      setObjectsList(data || [])
    } catch (err) {
      console.warn('Не удалось загрузить список объектов:', err.message)
    }
  }

  const fetchUsers = async () => {
    setLoadingUsers(true)
    try {
      // Загружаем роли из user_roles
      const { data: roles, error: rolesError } = await supabase
        .from('user_roles')
        .select('*')
        .order('is_approved', { ascending: true })
        .order('created_at', { ascending: true })

      if (rolesError) throw rolesError

      // Загружаем всех пользователей из auth.users через RPC
      const { data: authUsers, error: authError } = await supabase.rpc('get_auth_users')

      if (authError) {
        console.warn('Не удалось загрузить auth.users:', authError.message)
        setUserRoles(roles || [])
        setLoadingUsers(false)
        return
      }

      // Объединяем: для каждого auth-пользователя находим запись в user_roles
      const rolesMap = new Map((roles || []).map(r => [r.user_id, r]))
      const merged = (authUsers || []).map(au => {
        const roleRecord = rolesMap.get(au.id)
        return {
          id: roleRecord?.id || null,
          user_id: au.id,
          email: au.email,
          role: roleRecord?.role || null,
          is_approved: roleRecord?.is_approved ?? false,
          full_name: roleRecord?.full_name || '',
          work_phone: roleRecord?.work_phone || '',
          work_email: roleRecord?.work_email || '',
          object_id: roleRecord?.object_id || null,
          has_role: !!roleRecord,
          created_at: au.created_at,
          last_sign_in_at: au.last_sign_in_at,
          last_login_at: roleRecord?.last_login_at || null
        }
      })

      setUserRoles(merged)
    } catch (err) {
      console.error('Ошибка загрузки пользователей:', err.message)
    } finally {
      setLoadingUsers(false)
    }
  }

  const fetchPermissions = async () => {
    setLoadingPerms(true)
    try {
      const { data, error } = await supabase
        .from('role_permissions')
        .select('*')
        .order('role')

      if (error) throw error
      setPermissions(data || [])
    } catch (err) {
      console.error('Ошибка загрузки прав:', err.message)
    } finally {
      setLoadingPerms(false)
    }
  }

  // Подтвердить пользователя
  const handleApprove = async (user) => {
    try {
      if (!user.has_role) {
        // Создаём запись с подтверждением
        const { error } = await supabase
          .from('user_roles')
          .insert([{ user_id: user.user_id, email: user.email, role: user.role || 'engineer', is_approved: true }])
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('user_roles')
          .update({ is_approved: true })
          .eq('id', user.id)
        if (error) throw error
      }
      fetchUsers()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  // Заблокировать (снять подтверждение)
  const handleBlock = async (id) => {
    try {
      const { error } = await supabase
        .from('user_roles')
        .update({ is_approved: false })
        .eq('id', id)
      if (error) throw error
      fetchUsers()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const handleObjectChange = async (userId, newObjectId) => {
    try {
      const value = newObjectId || null
      const existing = userRoles.find(u => u.user_id === userId)
      if (!existing?.has_role) return // не меняем у пользователей без роли
      const { error } = await supabase
        .from('user_roles')
        .update({ object_id: value })
        .eq('user_id', userId)
      if (error) throw error
      setUserRoles(prev => prev.map(u => u.user_id === userId ? { ...u, object_id: value } : u))
    } catch (err) {
      if (/column .*object_id.* does not exist/i.test(err.message)) {
        alert('Колонка user_roles.object_id не создана. Примените миграцию 20260507_add_object_id_to_user_roles.sql.')
      } else {
        alert('Ошибка: ' + err.message)
      }
    }
  }

  const handleRoleChange = async (userId, newRole, userEmail) => {
    try {
      const existing = userRoles.find(u => u.user_id === userId)
      if (existing?.has_role === false) {
        // Нет записи в user_roles — создаём
        const { error } = await supabase
          .from('user_roles')
          .insert([{ user_id: userId, role: newRole, email: userEmail, is_approved: false }])
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('user_roles')
          .update({ role: newRole })
          .eq('user_id', userId)
        if (error) throw error
      }
      fetchUsers()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const handleDeleteUser = async (userId, email) => {
    if (!userId) return
    if (!window.confirm(`Полностью удалить пользователя ${email || ''}? Это действие необратимо: пользователь будет удалён из системы и больше не сможет войти.`)) return
    try {
      const { error } = await supabase.rpc('admin_delete_user', { target_user_id: userId })
      if (error) {
        // Фоллбэк: если RPC ещё не создан — удаляем хотя бы запись в user_roles
        if (/function .* does not exist/i.test(error.message)) {
          alert('RPC admin_delete_user не найдена в БД. Применяю частичное удаление: убирается роль (запись в user_roles), но запись в auth.users останется. Чтобы удалять полностью — примените миграцию 20260507_admin_delete_user_function.sql.')
          const { error: delError } = await supabase.from('user_roles').delete().eq('user_id', userId)
          if (delError) throw delError
        } else {
          throw error
        }
      }
      fetchUsers()
    } catch (err) {
      alert('Ошибка удаления: ' + err.message)
    }
  }

  const showRoleFeedback = (kind, text) => {
    setRoleFeedback({ kind, text })
    setTimeout(() => setRoleFeedback(null), kind === 'ok' ? 1800 : 5000)
  }

  const handleAddRole = async (e) => {
    e.preventDefault()
    const key = newRoleKey.trim().toLowerCase()
    const label = newRoleLabel.trim()
    if (!key || !label) {
      showRoleFeedback('err', 'Заполните машинный ключ и название роли')
      return
    }
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      showRoleFeedback('err', 'Ключ должен начинаться с латинской буквы и содержать только латиницу, цифры и нижнее подчёркивание')
      return
    }
    try {
      const { error } = await supabase
        .from('roles')
        .insert([{ key, label, is_system: false }])
      if (error) throw error
      setNewRoleKey('')
      setNewRoleLabel('')
      await refreshAvailableRoles()
      showRoleFeedback('ok', 'Роль добавлена')
    } catch (err) {
      console.error('Ошибка добавления роли:', err)
      if (err.code === '23505') {
        showRoleFeedback('err', 'Роль с таким ключом уже существует')
      } else if (/relation .* does not exist/i.test(err.message)) {
        showRoleFeedback('err', 'Таблица roles не создана. Примените миграцию 20260507_roles_table.sql.')
      } else {
        showRoleFeedback('err', 'Ошибка: ' + err.message)
      }
    }
  }

  const handleRenameRole = async (key, newLabel) => {
    const label = (newLabel || '').trim()
    if (!label) return
    try {
      const { error } = await supabase
        .from('roles')
        .update({ label })
        .eq('key', key)
      if (error) throw error
      await refreshAvailableRoles()
      showRoleFeedback('ok', 'Сохранено')
    } catch (err) {
      showRoleFeedback('err', 'Ошибка: ' + err.message)
    }
  }

  const handleDeleteRole = async (key, label) => {
    if (!window.confirm(`Удалить роль «${label}»? Пользователи с этой ролью потеряют её, права в role_permissions останутся как сироты.`)) return
    try {
      // Сначала чистим связанные permissions
      await supabase.from('role_permissions').delete().eq('role', key)
      // Сбрасываем у пользователей
      await supabase.from('user_roles').update({ role: 'engineer' }).eq('role', key)
      const { error } = await supabase.from('roles').delete().eq('key', key).eq('is_system', false)
      if (error) throw error
      await refreshAvailableRoles()
      showRoleFeedback('ok', 'Роль удалена')
    } catch (err) {
      showRoleFeedback('err', 'Ошибка: ' + err.message)
    }
  }

  const showPermFeedback = (kind, text) => {
    setPermFeedback({ kind, text })
    setTimeout(() => setPermFeedback(null), kind === 'ok' ? 1800 : 5000)
  }

  const handlePermissionToggle = async (role, section, field) => {
    const existing = permissions.find(p => p.role === role && p.section === section)

    const currentView = existing?.can_view ?? false
    const currentEdit = existing?.can_edit ?? false

    const next = { can_view: currentView, can_edit: currentEdit }
    if (field === 'can_view') {
      next.can_view = !currentView
      if (!next.can_view) next.can_edit = false
    } else {
      next.can_edit = !currentEdit
      if (next.can_edit) next.can_view = true
    }

    try {
      if (existing) {
        const { error } = await supabase
          .from('role_permissions')
          .update(next)
          .eq('id', existing.id)
        if (error) throw error
        setPermissions(prev => prev.map(p => p.id === existing.id ? { ...p, ...next } : p))
      } else {
        const { data, error } = await supabase
          .from('role_permissions')
          .insert([{ role, section, ...next }])
          .select()
          .single()
        if (error) throw error
        if (data) setPermissions(prev => [...prev, data])
      }
      showPermFeedback('ok', 'Сохранено')
    } catch (err) {
      console.error('Ошибка изменения прав:', err)
      // Подсказка про CHECK-constraint, если миграция роли не применена
      if (/valid_perm_role|check constraint/i.test(err.message)) {
        showPermFeedback('err', `Ошибка: роль «${roleLabels[role] || role}» отсутствует в CHECK-constraint таблицы role_permissions. Примените миграцию для этой роли.`)
      } else {
        showPermFeedback('err', 'Ошибка: ' + err.message)
      }
    }
  }

  if (!isAdmin) {
    return (
      <div className="admin-page">
        <div className="admin-denied">Доступ запрещён. Только для администраторов.</div>
      </div>
    )
  }

  const pendingUsers = userRoles.filter(u => !u.is_approved)
  const approvedUsers = userRoles.filter(u => u.is_approved)
  const sectionKeys = Object.keys(SECTIONS)

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h2>Администрирование</h2>
        <div className="admin-tabs">
          <button className={`admin-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
            Пользователи
            {pendingUsers.length > 0 && <span className="tab-badge">{pendingUsers.length}</span>}
          </button>
          <button className={`admin-tab ${activeTab === 'permissions' ? 'active' : ''}`} onClick={() => setActiveTab('permissions')}>
            Права доступа
          </button>
          <button className={`admin-tab ${activeTab === 'roles' ? 'active' : ''}`} onClick={() => setActiveTab('roles')}>
            Роли
          </button>
        </div>
      </div>

      {/* ===== Пользователи ===== */}
      {activeTab === 'users' && (
        <div className="admin-content">
          {loadingUsers ? (
            <div className="admin-loading">Загрузка...</div>
          ) : (
            <>
              {/* Заявки и заблокированные */}
              {pendingUsers.length > 0 && (
                <div className="admin-section">
                  <h3 className="section-title pending-title">
                    Заявки и заблокированные
                    <span className="pending-count">{pendingUsers.length}</span>
                  </h3>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>ФИО</th>
                        <th>Состояние</th>
                        <th>Роль</th>
                        <th>Дата регистрации</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingUsers.map(ur => {
                        const isBlocked = ur.has_role
                        return (
                          <tr key={ur.user_id} className="pending-row">
                            <td className="email-cell">{ur.email || '—'}</td>
                            <td className="name-cell">{ur.full_name || <span className="empty-cell">—</span>}</td>
                            <td>
                              <span className={isBlocked ? 'state-badge blocked' : 'state-badge new'}>
                                {isBlocked ? 'Заблокирован' : 'Новая заявка'}
                              </span>
                            </td>
                            <td>
                              <select
                                className="role-select"
                                value={ur.role || 'engineer'}
                                onChange={(e) => handleRoleChange(ur.user_id, e.target.value, ur.email)}
                              >
                                {employeeRoleKeys.map(r => (
                                  <option key={r} value={r}>{roleLabels[r]}</option>
                                ))}
                              </select>
                            </td>
                            <td className="date-cell">
                              {new Date(ur.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td>
                              <div className="action-btns">
                                <button className="btn-approve" onClick={() => handleApprove(ur)} title={isBlocked ? 'Разблокировать' : 'Подтвердить'}>
                                  {isBlocked ? 'Разблок.' : 'Подтвердить'}
                                </button>
                                <button className="btn-delete-user" onClick={() => handleDeleteUser(ur.user_id, ur.email)} title="Удалить полностью">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Активные пользователи */}
              <div className="admin-section">
                <h3 className="section-title">Активные пользователи ({approvedUsers.length})</h3>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>УН</th>
                      <th>Email</th>
                      <th>ФИО</th>
                      <th>Телефон</th>
                      <th>Раб. почта</th>
                      <th>Роль</th>
                      <th>Объект</th>
                      <th>Регистрация</th>
                      <th>Последний вход</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvedUsers.length === 0 ? (
                      <tr><td colSpan="10" className="admin-empty">Нет активных пользователей</td></tr>
                    ) : (
                      approvedUsers.map((ur, idx) => (
                        <tr key={ur.user_id}>
                          <td className="un-cell">{idx + 1}</td>
                          <td className="email-cell">{ur.email || '—'}</td>
                          <td className="name-cell">{ur.full_name || <span className="empty-cell">—</span>}</td>
                          <td className="phone-cell">{ur.work_phone || <span className="empty-cell">—</span>}</td>
                          <td className="work-email-cell">{ur.work_email || <span className="empty-cell">—</span>}</td>
                          <td>
                            <select
                              className="role-select"
                              value={ur.role || 'engineer'}
                              onChange={(e) => handleRoleChange(ur.user_id, e.target.value, ur.email)}
                            >
                              {employeeRoleKeys.map(r => (
                                <option key={r} value={r}>{roleLabels[r]}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              className="role-select"
                              value={ur.object_id || ''}
                              onChange={(e) => handleObjectChange(ur.user_id, e.target.value)}
                              title="Объект, к которому привязан пользователь"
                            >
                              <option value="">Офис (все объекты)</option>
                              {objectsList.map(o => (
                                <option key={o.id} value={o.id}>{o.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="date-cell">
                            {new Date(ur.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </td>
                          <td className="date-cell">
                            {ur.last_login_at
                              ? new Date(ur.last_login_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                              : '—'}
                          </td>
                          <td>
                            <div className="action-btns">
                              <button className="btn-block" onClick={() => handleBlock(ur.id)} title="Заблокировать">
                                Заблок.
                              </button>
                              <button className="btn-delete-user" onClick={() => handleDeleteUser(ur.user_id, ur.email)} title="Удалить полностью">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== Права доступа ===== */}
      {activeTab === 'permissions' && (
        <div className="admin-content">
          {loadingPerms ? (
            <div className="admin-loading">Загрузка...</div>
          ) : (
            <div className="permissions-pane">
              <div className="perm-role-picker">
                <label htmlFor="perm-role-select">Роль:</label>
                <select
                  id="perm-role-select"
                  className="role-select"
                  value={selectedPermRole}
                  onChange={(e) => setSelectedPermRole(e.target.value)}
                >
                  {employeeRoleKeys.map(r => (
                    <option key={r} value={r}>{roleLabels[r]}</option>
                  ))}
                </select>
                {permFeedback && (
                  <span className={`perm-feedback ${permFeedback.kind}`}>
                    {permFeedback.text}
                  </span>
                )}
              </div>

              {selectedPermRole === 'admin' ? (
                <div className="perm-admin-notice">
                  Права администратора изменять нельзя — у роли «Администратор» полный доступ ко всем разделам.
                </div>
              ) : (
                <table className="admin-table permissions-list-table">
                  <thead>
                    <tr>
                      <th className="section-header">Раздел</th>
                      <th className="perm-col">Просмотр</th>
                      <th className="perm-col">Редактирование</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sectionKeys.map(section => {
                      const perm = permissions.find(p => p.role === selectedPermRole && p.section === section)
                      return (
                        <tr key={section}>
                          <td className="section-name">{SECTIONS[section]}</td>
                          <td className="perm-cell">
                            <input
                              type="checkbox"
                              checked={perm?.can_view ?? false}
                              onChange={() => handlePermissionToggle(selectedPermRole, section, 'can_view')}
                            />
                          </td>
                          <td className="perm-cell">
                            <input
                              type="checkbox"
                              checked={perm?.can_edit ?? false}
                              onChange={() => handlePermissionToggle(selectedPermRole, section, 'can_edit')}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}

              <div className="permissions-legend">
                <span>Просмотр — открывать раздел</span>
                <span>Редактирование — менять данные</span>
                <span>Изменения сохраняются автоматически</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== Роли ===== */}
      {activeTab === 'roles' && (
        <div className="admin-content">
          <div className="roles-pane">
            <form className="roles-add-form" onSubmit={handleAddRole}>
              <div className="form-row">
                <div className="form-col">
                  <label>Машинный ключ</label>
                  <input
                    type="text"
                    value={newRoleKey}
                    onChange={(e) => setNewRoleKey(e.target.value)}
                    placeholder="site_manager"
                  />
                  <small>Латиница, цифры, _ — например <code>site_manager</code></small>
                </div>
                <div className="form-col">
                  <label>Название</label>
                  <input
                    type="text"
                    value={newRoleLabel}
                    onChange={(e) => setNewRoleLabel(e.target.value)}
                    placeholder="Прораб"
                  />
                  <small>Отображается в селектах</small>
                </div>
                <div className="form-col-action">
                  <button type="submit" className="btn-primary">
                    Добавить роль
                  </button>
                </div>
              </div>
              {roleFeedback && (
                <div className={`perm-feedback ${roleFeedback.kind}`} style={{ marginTop: '0.5rem' }}>
                  {roleFeedback.text}
                </div>
              )}
            </form>

            <table className="admin-table roles-table">
              <thead>
                <tr>
                  <th>Ключ</th>
                  <th>Название</th>
                  <th>Тип</th>
                  <th style={{ width: '60px' }}></th>
                </tr>
              </thead>
              <tbody>
                {availableRoles.length === 0 ? (
                  <tr><td colSpan="4" className="admin-empty">Ролей пока нет. Примените миграцию <code>20260507_roles_table.sql</code>.</td></tr>
                ) : (
                  availableRoles.map(r => (
                    <tr key={r.key}>
                      <td><code>{r.key}</code></td>
                      <td>
                        <input
                          type="text"
                          defaultValue={r.label}
                          disabled={r.is_system}
                          onBlur={(e) => {
                            if (!r.is_system && e.target.value !== r.label) {
                              handleRenameRole(r.key, e.target.value)
                            }
                          }}
                          className="role-rename-input"
                        />
                      </td>
                      <td>
                        {r.is_system
                          ? <span className="state-badge new">Системная</span>
                          : <span className="state-badge blocked" style={{ background: 'rgba(8,145,178,0.1)', color: '#0e7490' }}>Пользовательская</span>}
                      </td>
                      <td>
                        {!r.is_system && (
                          <button
                            className="btn-delete-user"
                            onClick={() => handleDeleteRole(r.key, r.label)}
                            title="Удалить роль"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="permissions-legend">
              <span>Системные роли изменять и удалять нельзя</span>
              <span>Удаление пользовательской роли переводит её носителей в «Инженер ОСП»</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AdminPage
