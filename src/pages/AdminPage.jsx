import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRole, ROLE_LABELS, SECTIONS } from '../contexts/RoleContext'
import './AdminPage.css'

const EMPLOYEE_ROLES = ['admin', 'engineer', 'economist', 'lawyer']

function AdminPage() {
  const { isAdmin } = useRole()
  const [activeTab, setActiveTab] = useState('users')

  // --- Users ---
  const [userRoles, setUserRoles] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)

  // --- Permissions ---
  const [permissions, setPermissions] = useState([])
  const [loadingPerms, setLoadingPerms] = useState(true)

  useEffect(() => {
    if (activeTab === 'users') fetchUsers()
    else fetchPermissions()
  }, [activeTab])

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
          has_role: !!roleRecord,
          created_at: au.created_at,
          last_sign_in_at: au.last_sign_in_at
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

  // Отклонить (удалить заявку)
  const handleReject = async (id, email) => {
    if (!window.confirm(`Отклонить и удалить заявку ${email || 'пользователя'}?`)) return
    try {
      const { error } = await supabase.from('user_roles').delete().eq('id', id)
      if (error) throw error
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

  const handleDeleteUser = async (id, email) => {
    if (!window.confirm(`Удалить пользователя ${email || ''}?`)) return
    try {
      const { error } = await supabase.from('user_roles').delete().eq('id', id)
      if (error) throw error
      fetchUsers()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    }
  }

  const handlePermissionToggle = async (permId, field) => {
    const perm = permissions.find(p => p.id === permId)
    if (!perm) return

    const newValue = !perm[field]
    const updates = { [field]: newValue }
    if (field === 'can_view' && !newValue) updates.can_edit = false
    if (field === 'can_edit' && newValue) updates.can_view = true

    try {
      const { error } = await supabase
        .from('role_permissions')
        .update(updates)
        .eq('id', permId)
      if (error) throw error
      setPermissions(prev => prev.map(p => p.id === permId ? { ...p, ...updates } : p))
    } catch (err) {
      alert('Ошибка: ' + err.message)
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
        </div>
      </div>

      {/* ===== Пользователи ===== */}
      {activeTab === 'users' && (
        <div className="admin-content">
          {loadingUsers ? (
            <div className="admin-loading">Загрузка...</div>
          ) : (
            <>
              {/* Заявки на подтверждение */}
              {pendingUsers.length > 0 && (
                <div className="admin-section">
                  <h3 className="section-title pending-title">
                    Ожидают подтверждения
                    <span className="pending-count">{pendingUsers.length}</span>
                  </h3>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>ФИО</th>
                        <th>Роль</th>
                        <th>Дата регистрации</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingUsers.map(ur => (
                        <tr key={ur.user_id} className="pending-row">
                          <td className="email-cell">{ur.email || '—'}</td>
                          <td className="name-cell">{ur.full_name || <span className="empty-cell">—</span>}</td>
                          <td>
                            <select
                              className="role-select"
                              value={ur.role || 'engineer'}
                              onChange={(e) => handleRoleChange(ur.user_id, e.target.value, ur.email)}
                            >
                              {EMPLOYEE_ROLES.map(r => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                          </td>
                          <td className="date-cell">
                            {new Date(ur.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td>
                            <div className="action-btns">
                              <button className="btn-approve" onClick={() => handleApprove(ur)} title="Подтвердить">
                                Подтвердить
                              </button>
                              {ur.has_role && (
                                <button className="btn-reject" onClick={() => handleReject(ur.id, ur.email)} title="Отклонить">
                                  Отклонить
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
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
                      <th>Регистрация</th>
                      <th>Последний вход</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvedUsers.length === 0 ? (
                      <tr><td colSpan="9" className="admin-empty">Нет активных пользователей</td></tr>
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
                              {EMPLOYEE_ROLES.map(r => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                          </td>
                          <td className="date-cell">
                            {new Date(ur.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </td>
                          <td className="date-cell">
                            {ur.last_sign_in_at
                              ? new Date(ur.last_sign_in_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                              : '—'}
                          </td>
                          <td>
                            <div className="action-btns">
                              <button className="btn-block" onClick={() => handleBlock(ur.id)} title="Заблокировать">
                                Заблок.
                              </button>
                              <button className="btn-delete-user" onClick={() => handleDeleteUser(ur.id, ur.email)} title="Удалить">
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
            <div className="permissions-grid">
              <table className="admin-table permissions-table">
                <thead>
                  <tr>
                    <th className="section-header">Раздел</th>
                    {EMPLOYEE_ROLES.map(r => (
                      <th key={r} colSpan="2" className="role-header">{ROLE_LABELS[r]}</th>
                    ))}
                  </tr>
                  <tr className="sub-header">
                    <th></th>
                    {EMPLOYEE_ROLES.map(r => (
                      <th key={r + '-sub'} colSpan="1" className="perm-sub">
                        <span className="perm-sub-group">
                          <span>Вид.</span>
                          <span>Ред.</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sectionKeys.map(section => (
                    <tr key={section}>
                      <td className="section-name">{SECTIONS[section]}</td>
                      {EMPLOYEE_ROLES.map(r => {
                        const perm = permissions.find(p => p.role === r && p.section === section)
                        const isAdminRow = r === 'admin'
                        return (
                          <td key={r} className="perm-cell">
                            <div className="perm-checkboxes">
                              <input
                                type="checkbox"
                                checked={perm?.can_view ?? false}
                                onChange={() => perm && handlePermissionToggle(perm.id, 'can_view')}
                                disabled={isAdminRow}
                                title="Просмотр"
                              />
                              <input
                                type="checkbox"
                                checked={perm?.can_edit ?? false}
                                onChange={() => perm && handlePermissionToggle(perm.id, 'can_edit')}
                                disabled={isAdminRow}
                                title="Редактирование"
                              />
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="permissions-legend">
                <span>Вид. = просмотр раздела</span>
                <span>Ред. = редактирование данных</span>
                <span>Права администратора изменить нельзя</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default AdminPage
