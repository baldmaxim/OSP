import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { useRole, SECTIONS } from '../contexts/RoleContext'
import FilterDropdown from '../components/FilterDropdown'
import RoleBadge from '../components/admin/RoleBadge'
import StatusBadge, { userStatus } from '../components/admin/StatusBadge'
import UserAvatar from '../components/admin/UserAvatar'
import UserActionsMenu from '../components/admin/UserActionsMenu'
import UserEditDrawer from '../components/admin/UserEditDrawer'
import './AdminPage.css'

const PAGE_SIZES = [10, 25, 50, 100]
const STATUS_FILTER_OPTIONS = [
  { value: 'active', label: 'Активен' },
  { value: 'pending', label: 'Приглашён' },
  { value: 'blocked', label: 'Заблокирован' },
]
const STATUS_RANK = { pending: 0, active: 1, blocked: 2 }

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function AdminPage() {
  const { isAdmin, isSuperAdmin, availableRoles, roleLabels, refreshAvailableRoles } = useRole()
  const [activeTab, setActiveTab] = useState('users')

  const employeeRoleKeys = availableRoles.filter(r => r.key !== 'contractor').map(r => r.key)
  const roleOptionsForForm = availableRoles.filter(r => r.key !== 'contractor').map(r => ({ key: r.key, label: r.label }))

  // --- Users ---
  const [userRoles, setUserRoles] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [usersError, setUsersError] = useState(false)
  const [objectsList, setObjectsList] = useState([])
  const [editUser, setEditUser] = useState(null)
  const [toast, setToast] = useState(null) // { kind:'ok'|'err', text }

  // Фильтры / поиск / пагинация / выбор
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [filterRoles, setFilterRoles] = useState([])
  const [filterStatuses, setFilterStatuses] = useState([])
  const [filterObjects, setFilterObjects] = useState([])
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState(() => new Set())

  // --- Permissions ---
  const [permissions, setPermissions] = useState([])
  const [loadingPerms, setLoadingPerms] = useState(true)
  const [selectedPermRole, setSelectedPermRole] = useState('engineer')
  const [permFeedback, setPermFeedback] = useState(null)

  // --- Roles ---
  const [newRoleKey, setNewRoleKey] = useState('')
  const [newRoleLabel, setNewRoleLabel] = useState('')
  const [roleFeedback, setRoleFeedback] = useState(null)

  useEffect(() => {
    if (activeTab === 'users') { fetchUsers(); fetchObjectsList() }
    else if (activeTab === 'permissions') fetchPermissions()
  }, [activeTab])

  // Debounce поиска (данные пользователей клиентские, но набор не дёргается на каждый символ).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // Любое изменение фильтров → на первую страницу.
  useEffect(() => { setPage(0) }, [debouncedSearch, filterRoles, filterStatuses, filterObjects, pageSize])

  const notify = (kind, text) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), kind === 'ok' ? 2500 : 5000)
  }

  const fetchObjectsList = async () => {
    try {
      const { data, error } = await supabase.from('objects').select('id, name').order('name', { ascending: true })
      if (error) throw error
      setObjectsList(data || [])
    } catch (err) {
      console.warn('Не удалось загрузить список объектов:', err.message)
    }
  }

  const fetchUsers = async () => {
    setLoadingUsers(true)
    setUsersError(false)
    try {
      const { data: roles, error: rolesError } = await supabase
        .from('user_roles').select('*')
        .order('is_approved', { ascending: true })
        .order('created_at', { ascending: true })
      if (rolesError) throw rolesError

      const { data: authUsers, error: authError } = await supabase.rpc('get_auth_users')
      if (authError) {
        console.warn('Не удалось загрузить auth.users:', authError.message)
        setUserRoles(roles || [])
        setLoadingUsers(false)
        return
      }

      const rolesMap = new Map((roles || []).map(r => [r.user_id, r]))
      const merged = (authUsers || []).map(au => {
        const r = rolesMap.get(au.id)
        return {
          id: r?.id || null,
          user_id: au.id,
          email: au.email,
          role: r?.role || null,
          is_approved: r?.is_approved ?? false,
          full_name: r?.full_name || '',
          work_phone: r?.work_phone || '',
          work_email: r?.work_email || '',
          object_id: r?.object_id || null,
          has_role: !!r,
          created_at: au.created_at,
          last_sign_in_at: au.last_sign_in_at,
          last_login_at: r?.last_login_at || null,
        }
      })
      setUserRoles(merged)
    } catch (err) {
      console.error('Ошибка загрузки пользователей:', err.message)
      setUsersError(true)
    } finally {
      setLoadingUsers(false)
    }
  }

  const fetchPermissions = async () => {
    setLoadingPerms(true)
    try {
      const { data, error } = await supabase.from('role_permissions').select('*').order('role')
      if (error) throw error
      setPermissions(data || [])
    } catch (err) {
      console.error('Ошибка загрузки прав:', err.message)
    } finally {
      setLoadingPerms(false)
    }
  }

  // ── Мутации пользователя ────────────────────────────────────────────────
  const setApproved = async (u, approved) => {
    try {
      if (!u.has_role) {
        const { error } = await supabase.from('user_roles')
          .insert([{ user_id: u.user_id, email: u.email, role: u.role || 'engineer', is_approved: approved }])
        if (error) throw error
      } else {
        const { error } = await supabase.from('user_roles').update({ is_approved: approved }).eq('id', u.id)
        if (error) throw error
      }
      await fetchUsers()
      notify('ok', approved ? 'Пользователь разблокирован' : 'Пользователь заблокирован')
    } catch (err) {
      notify('err', 'Ошибка: ' + err.message)
    }
  }

  const handleDeleteUser = async (u) => {
    if (!u.user_id) return
    if (!window.confirm(`Полностью удалить пользователя ${u.email || ''}? Это действие необратимо: пользователь будет удалён из системы и больше не сможет войти.`)) return
    try {
      const { error } = await supabase.rpc('admin_delete_user', { target_user_id: u.user_id })
      if (error) {
        if (/function .* does not exist/i.test(error.message)) {
          alert('RPC admin_delete_user не найдена в БД. Применяю частичное удаление: убирается роль (запись в user_roles), но запись в auth.users останется. Чтобы удалять полностью — примените миграцию 20260507_admin_delete_user_function.sql.')
          const { error: delError } = await supabase.from('user_roles').delete().eq('user_id', u.user_id)
          if (delError) throw delError
        } else { throw error }
      }
      await fetchUsers()
      notify('ok', 'Пользователь удалён')
    } catch (err) {
      notify('err', 'Ошибка удаления: ' + err.message)
    }
  }

  // Единое сохранение из drawer (контакты + роль + объект + статус).
  const saveUserFromDrawer = async (form) => {
    const u = editUser
    const payload = {
      full_name: form.full_name,
      work_phone: form.work_phone,
      work_email: form.work_email,
      role: form.role,
      object_id: form.object_id,
      is_approved: form.is_approved,
    }
    if (u.has_role) {
      const { error } = await supabase.from('user_roles').update(payload).eq('user_id', u.user_id)
      if (error) throw error
    } else {
      const { error } = await supabase.from('user_roles').insert([{ user_id: u.user_id, email: u.email, ...payload }])
      if (error) throw error
    }
    await fetchUsers()
    setEditUser(null)
    notify('ok', 'Изменения сохранены')
  }

  // ── Массовые операции (по выбранным строкам) ────────────────────────────
  const bulkUpdate = async (patch, successText) => {
    const ids = [...selected]
    if (ids.length === 0) return
    try {
      // Обновляем только тех, у кого есть запись в user_roles (по user_id).
      const CHUNK = 100
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { error } = await supabase.from('user_roles').update(patch).in('user_id', ids.slice(i, i + CHUNK))
        if (error) throw error
      }
      await fetchUsers()
      setSelected(new Set())
      notify('ok', successText)
    } catch (err) {
      notify('err', 'Ошибка массовой операции: ' + err.message)
    }
  }

  // ── Роли (справочник) ───────────────────────────────────────────────────
  const showRoleFeedback = (kind, text) => { setRoleFeedback({ kind, text }); setTimeout(() => setRoleFeedback(null), kind === 'ok' ? 1800 : 5000) }
  const handleAddRole = async (e) => {
    e.preventDefault()
    const key = newRoleKey.trim().toLowerCase()
    const label = newRoleLabel.trim()
    if (!key || !label) { showRoleFeedback('err', 'Заполните машинный ключ и название роли'); return }
    if (!/^[a-z][a-z0-9_]*$/.test(key)) { showRoleFeedback('err', 'Ключ должен начинаться с латинской буквы и содержать только латиницу, цифры и нижнее подчёркивание'); return }
    try {
      const { error } = await supabase.from('roles').insert([{ key, label, is_system: false }])
      if (error) throw error
      setNewRoleKey(''); setNewRoleLabel('')
      await refreshAvailableRoles()
      showRoleFeedback('ok', 'Роль добавлена')
    } catch (err) {
      if (err.code === '23505') showRoleFeedback('err', 'Роль с таким ключом уже существует')
      else if (/relation .* does not exist/i.test(err.message)) showRoleFeedback('err', 'Таблица roles не создана. Примените миграцию 20260507_roles_table.sql.')
      else showRoleFeedback('err', 'Ошибка: ' + err.message)
    }
  }
  const handleRenameRole = async (key, newLabel) => {
    const label = (newLabel || '').trim()
    if (!label) return
    try {
      const { error } = await supabase.from('roles').update({ label }).eq('key', key)
      if (error) throw error
      await refreshAvailableRoles()
      showRoleFeedback('ok', 'Сохранено')
    } catch (err) { showRoleFeedback('err', 'Ошибка: ' + err.message) }
  }
  const handleDeleteRole = async (key, label) => {
    if (!window.confirm(`Удалить роль «${label}»? Пользователи с этой ролью потеряют её, права в role_permissions останутся как сироты.`)) return
    try {
      await supabase.from('role_permissions').delete().eq('role', key)
      await supabase.from('user_roles').update({ role: 'engineer' }).eq('role', key)
      const { error } = await supabase.from('roles').delete().eq('key', key).eq('is_system', false)
      if (error) throw error
      await refreshAvailableRoles()
      showRoleFeedback('ok', 'Роль удалена')
    } catch (err) { showRoleFeedback('err', 'Ошибка: ' + err.message) }
  }

  // ── Права доступа ───────────────────────────────────────────────────────
  const showPermFeedback = (kind, text) => { setPermFeedback({ kind, text }); setTimeout(() => setPermFeedback(null), kind === 'ok' ? 1800 : 5000) }
  const handlePermissionToggle = async (role, section, field) => {
    const existing = permissions.find(p => p.role === role && p.section === section)
    const currentView = existing?.can_view ?? false
    const currentEdit = existing?.can_edit ?? false
    const next = { can_view: currentView, can_edit: currentEdit }
    if (field === 'can_view') { next.can_view = !currentView; if (!next.can_view) next.can_edit = false }
    else { next.can_edit = !currentEdit; if (next.can_edit) next.can_view = true }
    try {
      if (existing) {
        const { error } = await supabase.from('role_permissions').update(next).eq('id', existing.id)
        if (error) throw error
        setPermissions(prev => prev.map(p => p.id === existing.id ? { ...p, ...next } : p))
      } else {
        const { data, error } = await supabase.from('role_permissions').insert([{ role, section, ...next }]).select().single()
        if (error) throw error
        if (data) setPermissions(prev => [...prev, data])
      }
      showPermFeedback('ok', 'Сохранено')
    } catch (err) {
      if (/valid_perm_role|check constraint/i.test(err.message)) showPermFeedback('err', `Ошибка: роль «${roleLabels[role] || role}» отсутствует в CHECK-constraint таблицы role_permissions. Примените миграцию для этой роли.`)
      else showPermFeedback('err', 'Ошибка: ' + err.message)
    }
  }

  // ── Производные данные (статистика, опции фильтров, фильтрация) ──────────
  const sectionKeys = Object.keys(SECTIONS)
  const objectNameById = useMemo(() => {
    const m = new Map(objectsList.map(o => [o.id, o.name]))
    return (id) => (id ? (m.get(id) || 'Объект') : 'Офис (все объекты)')
  }, [objectsList])

  const stats = useMemo(() => {
    const total = userRoles.length
    const active = userRoles.filter(u => u.is_approved).length
    const admins = userRoles.filter(u => u.role === 'admin').length
    return { total, active, activePct: total ? Math.round((active / total) * 100) : 0, admins }
  }, [userRoles])

  const roleFilterOptions = useMemo(() => {
    const seen = new Set()
    const opts = []
    userRoles.forEach(u => {
      if (!u.role || seen.has(u.role)) return
      seen.add(u.role)
      opts.push({ value: u.role, label: roleLabels[u.role] || u.role })
    })
    return opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  }, [userRoles, roleLabels])

  const objectFilterOptions = useMemo(() => {
    const used = new Set(userRoles.map(u => u.object_id || '__office__'))
    const opts = [{ value: '__office__', label: 'Офис (все объекты)' }]
    objectsList.forEach(o => { if (used.has(o.id)) opts.push({ value: o.id, label: o.name }) })
    return opts
  }, [userRoles, objectsList])

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return userRoles
      .filter(u => filterRoles.length === 0 || filterRoles.includes(u.role))
      .filter(u => filterStatuses.length === 0 || filterStatuses.includes(userStatus(u)))
      .filter(u => filterObjects.length === 0 || filterObjects.includes(u.object_id || '__office__'))
      .filter(u => {
        if (!q) return true
        return [u.full_name, u.email, u.work_email, u.work_phone].filter(Boolean).join(' ').toLowerCase().includes(q)
      })
      .sort((a, b) => {
        const r = (STATUS_RANK[userStatus(a)] ?? 3) - (STATUS_RANK[userStatus(b)] ?? 3)
        if (r !== 0) return r
        return (a.full_name || a.email || '').localeCompare(b.full_name || b.email || '', 'ru')
      })
  }, [userRoles, filterRoles, filterStatuses, filterObjects, debouncedSearch])

  const activeFilterCount = filterRoles.length + filterStatuses.length + filterObjects.length + (debouncedSearch.trim() ? 1 : 0)
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageClamped = Math.min(page, totalPages - 1)
  const pageRows = filtered.slice(pageClamped * pageSize, pageClamped * pageSize + pageSize)
  const fromRow = filtered.length === 0 ? 0 : pageClamped * pageSize + 1
  const toRow = Math.min(filtered.length, (pageClamped + 1) * pageSize)

  const resetFilters = () => { setSearch(''); setFilterRoles([]); setFilterStatuses([]); setFilterObjects([]) }

  // Выбор строк (в пределах отфильтрованного набора).
  const allPageSelected = pageRows.length > 0 && pageRows.every(u => selected.has(u.user_id))
  const someSelected = selected.size > 0
  const headerCbRef = useRef(null)
  useEffect(() => {
    if (headerCbRef.current) headerCbRef.current.indeterminate = someSelected && !allPageSelected
  })
  const toggleSelectAllFiltered = (checked) => {
    setSelected(checked ? new Set(filtered.map(u => u.user_id)) : new Set())
  }
  const toggleRow = (id) => setSelected(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  if (!isAdmin && !isSuperAdmin) {
    return <div className="admin-page"><div className="admin-denied">Доступ запрещён. Только для администраторов.</div></div>
  }

  const showTable = !loadingUsers && !usersError && filtered.length > 0
  const colCount = 7

  return (
    <div className="admin-page">
      {/* Заголовок */}
      <div className="admin-topbar">
        <div className="admin-topbar-heading">
          <h2>Администрирование</h2>
          <p className="admin-subtitle">Управление пользователями, ролями и доступом к системе</p>
        </div>
        <div className="admin-topbar-actions">
          <a className="btn-ghost" href="/public/tenders" target="_blank" rel="noopener noreferrer"
            title="Открыть публичную страницу тендеров в новой вкладке">
            Открытые тендеры
          </a>
        </div>
      </div>

      {/* Статистика */}
      <div className="admin-stats">
        <StatCard tone="blue" value={stats.total} title="Пользователей" hint="Всего в системе"
          icon={<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeWidth="2" />} extra={<circle cx="9" cy="7" r="4" strokeWidth="2" />} />
        <StatCard tone="green" value={`${stats.active}`} title="Активных" hint={`${stats.activePct}% от всех`}
          icon={<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" strokeWidth="2" />} extra={<polyline points="22 4 12 14.01 9 11.01" strokeWidth="2" />} />
        <StatCard tone="violet" value={employeeRoleKeys.length} title="Ролей" hint="Настроено в системе"
          icon={<path d="M20 21v-2a4 4 0 0 0-3-3.87M4 21v-2a4 4 0 0 1 3-3.87" strokeWidth="2" />} extra={<circle cx="12" cy="7" r="4" strokeWidth="2" />} />
        <StatCard tone="cyan" value={sectionKeys.length} title="Групп доступа" hint="Разделов с настройкой прав"
          icon={<rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="2" />} extra={<rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="2" />} />
        <StatCard tone="amber" value={stats.admins} title="Администраторов" hint="С полным доступом"
          icon={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeWidth="2" />} />
      </div>

      {/* Вкладки */}
      <div className="admin-panel">
        <div className="admin-tabs">
          <button className={`admin-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>Пользователи</button>
          <button className={`admin-tab ${activeTab === 'roles' ? 'active' : ''}`} onClick={() => setActiveTab('roles')}>Роли</button>
          <button className={`admin-tab ${activeTab === 'permissions' ? 'active' : ''}`} onClick={() => setActiveTab('permissions')}>Права доступа</button>
        </div>

        {/* ===== Пользователи ===== */}
        {activeTab === 'users' && (
          <div className="admin-tabpane">
            {/* Панель фильтров */}
            <div className="user-filters">
              <div className="user-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
                <input type="search" placeholder="Поиск по ФИО, email, телефону…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <FilterDropdown label="" multiple searchable allLabel="Роль: все" searchPlaceholder="Поиск роли…"
                value={filterRoles} onChange={setFilterRoles} options={roleFilterOptions} />
              <FilterDropdown label="" multiple allLabel="Статус: все"
                value={filterStatuses} onChange={setFilterStatuses} options={STATUS_FILTER_OPTIONS} />
              <FilterDropdown label="" multiple searchable allLabel="Объект: все" searchPlaceholder="Поиск объекта…"
                value={filterObjects} onChange={setFilterObjects} options={objectFilterOptions} />
              {activeFilterCount > 0 && (
                <button type="button" className="filters-reset" onClick={resetFilters}>
                  Сбросить <span className="filters-reset-count">{activeFilterCount}</span>
                </button>
              )}
            </div>

            {/* Панель массовых операций */}
            {someSelected && (
              <div className="bulk-bar">
                <span className="bulk-count">Выбрано: {selected.size}</span>
                <select className="bulk-select" defaultValue="" onChange={(e) => { if (e.target.value) { bulkUpdate({ role: e.target.value }, 'Роль назначена'); e.target.value = '' } }}>
                  <option value="">Назначить роль…</option>
                  {roleOptionsForForm.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
                <select className="bulk-select" defaultValue="" onChange={(e) => { const v = e.target.value; if (v) { bulkUpdate({ object_id: v === '__office__' ? null : v }, 'Объект изменён'); e.target.value = '' } }}>
                  <option value="">Изменить объект…</option>
                  <option value="__office__">Офис (все объекты)</option>
                  {objectsList.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <button type="button" className="btn-soft" onClick={() => bulkUpdate({ is_approved: false }, 'Пользователи заблокированы')}>Заблокировать</button>
                <button type="button" className="btn-soft" onClick={() => bulkUpdate({ is_approved: true }, 'Пользователи разблокированы')}>Разблокировать</button>
                <button type="button" className="bulk-clear" onClick={() => setSelected(new Set())}>Снять выделение</button>
              </div>
            )}

            {/* Таблица / состояния */}
            <div className="users-table-wrap">
              <table className="users-table">
                <thead>
                  <tr>
                    <th className="col-cb">
                      <input ref={headerCbRef} type="checkbox" checked={allPageSelected}
                        onChange={(e) => toggleSelectAllFiltered(e.target.checked)} aria-label="Выбрать всех" />
                    </th>
                    <th>Пользователь</th>
                    <th className="col-role">Роль</th>
                    <th className="col-obj">Подразделение</th>
                    <th className="col-status">Статус</th>
                    <th className="col-login">Последний вход</th>
                    <th className="col-actions" aria-label="Действия"></th>
                  </tr>
                </thead>
                <tbody>
                  {loadingUsers ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={`sk-${i}`} className="skeleton-row">
                        <td className="col-cb"><span className="sk sk-cb" /></td>
                        <td><div className="sk-user"><span className="sk sk-avatar" /><div className="sk-lines"><span className="sk sk-line" /><span className="sk sk-line sk-line-sm" /></div></div></td>
                        <td><span className="sk sk-pill" /></td>
                        <td><span className="sk sk-line" /></td>
                        <td><span className="sk sk-pill" /></td>
                        <td><span className="sk sk-line sk-line-sm" /></td>
                        <td><span className="sk sk-pill sk-pill-sm" /></td>
                      </tr>
                    ))
                  ) : usersError ? (
                    <tr><td colSpan={colCount}><div className="table-state">
                      <p className="table-state-title">Не удалось загрузить пользователей</p>
                      <button type="button" className="btn-secondary" onClick={fetchUsers}>Повторить</button>
                    </div></td></tr>
                  ) : userRoles.length === 0 ? (
                    <tr><td colSpan={colCount}><div className="table-state">
                      <p className="table-state-title">Пользователей пока нет</p>
                      <p className="table-state-hint">Они появятся здесь после регистрации.</p>
                    </div></td></tr>
                  ) : filtered.length === 0 ? (
                    <tr><td colSpan={colCount}><div className="table-state">
                      <p className="table-state-title">По вашему запросу ничего не найдено</p>
                      <button type="button" className="btn-secondary" onClick={resetFilters}>Сбросить фильтры</button>
                    </div></td></tr>
                  ) : (
                    pageRows.map(u => {
                      const st = userStatus(u)
                      const isSel = selected.has(u.user_id)
                      return (
                        <tr key={u.user_id} className={isSel ? 'is-selected' : ''}>
                          <td className="col-cb">
                            <input type="checkbox" checked={isSel} onChange={() => toggleRow(u.user_id)} aria-label="Выбрать пользователя" />
                          </td>
                          <td>
                            <div className="user-cell">
                              <UserAvatar name={u.full_name} email={u.email} />
                              <div className="user-cell-main">
                                <span className="user-cell-name">{u.full_name || <span className="muted">Без имени</span>}</span>
                                <span className="user-cell-contact">{u.email || '—'}</span>
                                {u.work_phone && <span className="user-cell-contact">{u.work_phone}</span>}
                              </div>
                            </div>
                          </td>
                          <td className="col-role"><RoleBadge roleKey={u.role} label={roleLabels[u.role]} /></td>
                          <td className="col-obj">{objectNameById(u.object_id)}</td>
                          <td className="col-status"><StatusBadge status={st} /></td>
                          <td className="col-login">{formatDateTime(u.last_login_at || u.last_sign_in_at)}</td>
                          <td className="col-actions">
                            <div className="row-actions">
                              <button type="button" className="adm-iconbtn" onClick={() => setEditUser(u)} title="Редактировать" aria-label="Редактировать">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                              </button>
                              <UserActionsMenu
                                status={st}
                                onEdit={() => setEditUser(u)}
                                onToggleBlock={() => setApproved(u, st !== 'active')}
                                onDelete={() => handleDeleteUser(u)}
                              />
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Пагинация */}
            {showTable && (
              <div className="users-pagination">
                <div className="pg-left">
                  <span>Строк:</span>
                  <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                    {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="pg-right">
                  <span className="pg-range">{fromRow}–{toRow} из {filtered.length}</span>
                  <div className="pg-buttons">
                    <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={pageClamped === 0} aria-label="Назад">‹</button>
                    {pageNumbers(pageClamped, totalPages).map((p, i) => p === '…'
                      ? <span key={`e${i}`} className="pg-ellipsis">…</span>
                      : <button key={p} type="button" className={p - 1 === pageClamped ? 'active' : ''} onClick={() => setPage(p - 1)}>{p}</button>)}
                    <button type="button" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={pageClamped >= totalPages - 1} aria-label="Вперёд">›</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== Роли ===== */}
        {activeTab === 'roles' && (
          <div className="admin-tabpane">
            <div className="roles-pane">
              <form className="roles-add-form" onSubmit={handleAddRole}>
                <div className="form-row">
                  <div className="form-col">
                    <label>Машинный ключ</label>
                    <input type="text" value={newRoleKey} onChange={(e) => setNewRoleKey(e.target.value)} placeholder="site_manager" />
                    <small>Латиница, цифры, _ — например <code>site_manager</code></small>
                  </div>
                  <div className="form-col">
                    <label>Название</label>
                    <input type="text" value={newRoleLabel} onChange={(e) => setNewRoleLabel(e.target.value)} placeholder="Прораб" />
                    <small>Отображается в селектах</small>
                  </div>
                  <div className="form-col-action">
                    <button type="submit" className="btn-primary">Добавить роль</button>
                  </div>
                </div>
                {roleFeedback && <div className={`perm-feedback ${roleFeedback.kind}`} style={{ marginTop: '0.5rem' }}>{roleFeedback.text}</div>}
              </form>

              <table className="admin-table roles-table">
                <thead><tr><th>Ключ</th><th>Название</th><th>Тип</th><th style={{ width: '60px' }}></th></tr></thead>
                <tbody>
                  {availableRoles.length === 0 ? (
                    <tr><td colSpan="4" className="admin-empty">Ролей пока нет. Примените миграцию <code>20260507_roles_table.sql</code>.</td></tr>
                  ) : availableRoles.map(r => (
                    <tr key={r.key}>
                      <td><code>{r.key}</code></td>
                      <td>
                        <input type="text" defaultValue={r.label} disabled={r.is_system} className="role-rename-input"
                          onBlur={(e) => { if (!r.is_system && e.target.value !== r.label) handleRenameRole(r.key, e.target.value) }} />
                      </td>
                      <td>{r.is_system ? <span className="tag-neutral">Системная</span> : <span className="tag-info">Пользовательская</span>}</td>
                      <td>
                        {!r.is_system && (
                          <button className="adm-iconbtn adm-iconbtn-danger" onClick={() => handleDeleteRole(r.key, r.label)} title="Удалить роль" aria-label="Удалить роль">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="permissions-legend">
                <span>Системные роли изменять и удалять нельзя</span>
                <span>Удаление пользовательской роли переводит её носителей в «Инженер ОСП»</span>
              </div>
            </div>
          </div>
        )}

        {/* ===== Права доступа ===== */}
        {activeTab === 'permissions' && (
          <div className="admin-tabpane">
            {loadingPerms ? (
              <div className="admin-loading">Загрузка...</div>
            ) : (
              <div className="permissions-pane">
                <div className="perm-role-picker">
                  <label htmlFor="perm-role-select">Роль:</label>
                  <select id="perm-role-select" value={selectedPermRole} onChange={(e) => setSelectedPermRole(e.target.value)}>
                    {employeeRoleKeys.map(r => <option key={r} value={r}>{roleLabels[r]}</option>)}
                  </select>
                  {permFeedback && <span className={`perm-feedback ${permFeedback.kind}`}>{permFeedback.text}</span>}
                </div>

                {selectedPermRole === 'admin' ? (
                  <div className="perm-admin-notice">Права администратора изменять нельзя — у роли «Администратор» полный доступ ко всем разделам.</div>
                ) : (
                  <table className="admin-table permissions-list-table">
                    <thead><tr><th className="section-header">Раздел</th><th className="perm-col">Просмотр</th><th className="perm-col">Редактирование</th></tr></thead>
                    <tbody>
                      {sectionKeys.map(section => {
                        const perm = permissions.find(p => p.role === selectedPermRole && p.section === section)
                        return (
                          <tr key={section}>
                            <td className="section-name">{SECTIONS[section]}</td>
                            <td className="perm-cell"><input type="checkbox" checked={perm?.can_view ?? false} onChange={() => handlePermissionToggle(selectedPermRole, section, 'can_view')} /></td>
                            <td className="perm-cell"><input type="checkbox" checked={perm?.can_edit ?? false} onChange={() => handlePermissionToggle(selectedPermRole, section, 'can_edit')} /></td>
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
      </div>

      {editUser && (
        <UserEditDrawer
          user={editUser}
          roleOptions={roleOptionsForForm}
          objectOptions={objectsList}
          onClose={() => setEditUser(null)}
          onSave={saveUserFromDrawer}
        />
      )}

      {toast && (
        <div className={`admin-toast ${toast.kind === 'ok' ? 'toast-ok' : 'toast-err'}`} role="status">{toast.text}</div>
      )}
    </div>
  )
}

// Карточка статистики. icon/extra — содержимое <svg> (пути), tone — цветовая тема.
function StatCard({ tone, value, title, hint, icon, extra }) {
  return (
    <div className="stat-card">
      <span className={`stat-icon stat-icon-${tone}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">{icon}{extra}</svg>
      </span>
      <div className="stat-body">
        <div className="stat-value">{value}</div>
        <div className="stat-title">{title}</div>
        <div className="stat-hint">{hint}</div>
      </div>
    </div>
  )
}

// Номера страниц с многоточием (1 … n).
function pageNumbers(current, total) {
  const cur = current + 1
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out = [1]
  const start = Math.max(2, cur - 1)
  const end = Math.min(total - 1, cur + 1)
  if (start > 2) out.push('…')
  for (let p = start; p <= end; p++) out.push(p)
  if (end < total - 1) out.push('…')
  out.push(total)
  return out
}

export default AdminPage
