import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { db, identityAdmin } from '../api'
import { useRole, SECTIONS } from '../contexts/RoleContext'
import FilterDropdown from '../components/FilterDropdown'
import RoleBadge from '../components/admin/RoleBadge'
import StatusBadge, { userStatus, statusPatch, isBlockColumnMissing, BLOCK_MIGRATION_HINT } from '../components/admin/StatusBadge'
import UserAvatar from '../components/admin/UserAvatar'
import UserActionsMenu from '../components/admin/UserActionsMenu'
import { AddUserDrawer, TemporaryPasswordDialog } from '../components/admin/AccountModals'
import UserEditDrawer from '../components/admin/UserEditDrawer'
import ApiKeysTab from '../components/admin/ApiKeysTab'
import AccessRightsTab from '../components/admin/AccessRightsTab'
import ContractorSignupsTab from '../components/admin/ContractorSignupsTab'
import IdentityRequestsTab from '../components/admin/IdentityRequestsTab'
import { fetchAllActiveCounterparties } from '../utils/fetchAllRows'
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
  const {
    isAdmin, isSuperAdmin, availableRoles, roleLabels,
    userProfile, ownAuth, ssoAuth, ssoLinks, adminResetPassword,
  } = useRole()
  // Свой вход (tender.su10.ru): учётки и временные пароли выдаёт администратор.
  const [addUserOpen, setAddUserOpen] = useState(false)
  const [tempPassword, setTempPassword] = useState(null) // { email, password } — показывается один раз
  const [activeTab, setActiveTab] = useState('users')

  const employeeRoleKeys = availableRoles.filter(r => r.key !== 'contractor').map(r => r.key)
  // Роль «Администратор» выдаёт только суперадминистратор (решение 10.11.2026; так же проверяют сервер и база — триггер
  // user_roles_admin_guard). Обычному администратору её нет в выборе; у пользователя, который уже администратор, она остаётся.
  const roleOptionsForForm = availableRoles.filter(r => r.key !== 'contractor' && (isSuperAdmin || r.key !== 'admin')).map(r => ({ key: r.key, label: r.label }))
  const roleOptionsFor = (u) => (u?.role === 'admin' && !roleOptionsForForm.some(r => r.key === 'admin')
    ? [{ key: 'admin', label: roleLabels.admin || 'Администратор' }, ...roleOptionsForForm]
    : roleOptionsForForm)

  // Вход через СУ-10: связи пользователей с учётками СУ-10 (пометка в таблице, «Отвязать») и число заявок на вкладке.
  const [ssoLinked, setSsoLinked] = useState(() => new Set())
  const [pendingRequests, setPendingRequests] = useState(0)
  const loadSsoLinks = useCallback(async () => {
    if (!ssoAuth) return
    try {
      const { links } = await identityAdmin.links()
      setSsoLinked(new Set((links || []).map((l) => l.userId)))
    } catch { /* без пометок — таблица работает */ }
  }, [ssoAuth])
  useEffect(() => { loadSsoLinks() }, [loadSsoLinks])
  useEffect(() => {
    if (!ssoAuth) return
    identityAdmin.list('pending').then((d) => setPendingRequests(d.pending || 0)).catch(() => {})
  }, [ssoAuth])

  // --- Users ---
  const [userRoles, setUserRoles] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [usersError, setUsersError] = useState(false)
  const [objectsList, setObjectsList] = useState([])
  const [counterpartiesList, setCounterpartiesList] = useState([])
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

  // Справочники грузим по одному разу за визит на страницу, а не при каждом
  // переключении вкладок: раньше возврат на «Пользователей» заново тянул всех
  // пользователей, объекты и несколько тысяч контрагентов (постранично, по очереди).
  const loadedRef = useRef({ users: false, objects: false, counterparties: false })
  useEffect(() => {
    if (activeTab === 'users' && !loadedRef.current.users) fetchUsers()
    if ((activeTab === 'users' || activeTab === 'permissions') && !loadedRef.current.objects) fetchObjectsList()
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
      const { data, error } = await db.from('objects').select('id, name').order('name', { ascending: true })
      if (error) throw error
      loadedRef.current.objects = true
      setObjectsList(data || [])
    } catch (err) {
      console.warn('Не удалось загрузить список объектов:', err.message)
    }
  }

  // Контрагенты — для привязки логина к кабинету подрядчика (окно пользователя) и просмотра от имени подрядчика.
  // Грузятся один раз и только когда понадобились.
  const ensureCounterparties = useCallback(async () => {
    if (loadedRef.current.counterparties) return
    loadedRef.current.counterparties = true
    try {
      const data = await fetchAllActiveCounterparties('id, name')
      setCounterpartiesList(data || [])
    } catch (err) {
      loadedRef.current.counterparties = false // дать повторить при следующем открытии
      console.warn('Не удалось загрузить список контрагентов:', err.message)
    }
  }, [])

  useEffect(() => {
    if (editUser) ensureCounterparties()
  }, [editUser, ensureCounterparties])

  // silent — обновить после действия (блокировка, сохранение) без скелетона:
  // раньше таблица на каждое действие пропадала и рисовалась заново.
  const usersRequestRef = useRef(0)
  const fetchUsers = async ({ silent = false } = {}) => {
    const requestId = ++usersRequestRef.current
    if (!silent) setLoadingUsers(true)
    setUsersError(false)
    try {
      // Оба запроса независимы — параллельно, а не друг за другом.
      const [rolesRes, authRes] = await Promise.all([
        db.from('user_roles').select('*')
          .order('is_approved', { ascending: true })
          .order('created_at', { ascending: true }),
        db.rpc('get_auth_users'),
      ])
      // Ответ устарел (запущено новое обновление) — не перетираем свежие данные.
      if (requestId !== usersRequestRef.current) return
      const { data: roles, error: rolesError } = rolesRes
      if (rolesError) throw rolesError
      const { data: authUsers, error: authError } = authRes
      loadedRef.current.users = true
      if (authError) {
        // Без auth.users нет e-mail и дат входа тех, кто ещё без роли. Показываем
        // хотя бы пользователей с ролью — в том же виде, что и основной путь.
        console.warn('Не удалось загрузить auth.users:', authError.message)
        setUserRoles((roles || []).map(r => ({
          ...r,
          object_ids: (Array.isArray(r.object_ids) && r.object_ids.length) ? r.object_ids : (r.object_id ? [r.object_id] : []),
          has_role: true,
        })))
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
          // undefined — колонки нет (миграция 20260920 не применена): статус тогда
          // считается по прежнему правилу, см. userStatus.
          is_blocked: r ? r.is_blocked : false,
          full_name: r?.full_name || '',
          work_phone: r?.work_phone || '',
          work_email: r?.work_email || '',
          // Несколько объектов на пользователя. Откат на одиночный object_id,
          // если миграция 20260730 ещё не применена.
          object_ids: (Array.isArray(r?.object_ids) && r.object_ids.length)
            ? r.object_ids
            : (r?.object_id ? [r.object_id] : []),
          counterparty_id: r?.counterparty_id || null,
          // Организация, которую подрядчик указал при саморегистрации, — подсказка
          // администратору, с какой карточкой контрагента связывать логин.
          requested_company: r?.requested_company || '',
          has_role: !!r,
          created_at: au.created_at,
          last_sign_in_at: au.last_sign_in_at,
          // null — почта не подтверждена; undefined — функция старая (до 20261002),
          // статус неизвестен и не показывается.
          email_confirmed_at: au.email_confirmed_at,
          last_login_at: r?.last_login_at || null,
        }
      })
      setUserRoles(merged)
    } catch (err) {
      if (requestId !== usersRequestRef.current) return
      console.error('Ошибка загрузки пользователей:', err.message)
      setUsersError(true)
    } finally {
      if (requestId === usersRequestRef.current) setLoadingUsers(false)
    }
  }

  // ── Мутации пользователя ────────────────────────────────────────────────
  // Перевод пользователя в статус: 'active' | 'blocked' (| 'pending').
  const setUserStatus = async (u, status) => {
    const patch = statusPatch(status, userProfile?.full_name || null)
    try {
      if (!u.has_role) {
        const { error } = await db.from('user_roles')
          .insert([{ user_id: u.user_id, email: u.email, role: u.role || 'engineer', ...patch }])
        if (error) throw error
      } else {
        const { error } = await db.from('user_roles').update(patch).eq('user_id', u.user_id)
        if (error) throw error
      }
      await fetchUsers({ silent: true })
      notify('ok', status === 'blocked' ? 'Пользователь заблокирован'
        : userStatus(u) === 'blocked' ? 'Пользователь разблокирован' : 'Доступ подтверждён')
    } catch (err) {
      notify('err', isBlockColumnMissing(err) ? BLOCK_MIGRATION_HINT : 'Ошибка: ' + err.message)
    }
  }

  // Ссылка из письма не сработала (устарела, отменена новым письмом, её «прокликал»
  // почтовый фильтр) — администратор подтверждает почту сам.
  const handleConfirmEmail = async (u) => {
    if (!window.confirm(`Подтвердить почту ${u.email || ''} без ссылки из письма?`)) return
    try {
      const { error } = await db.rpc('admin_confirm_user_email', { target_user_id: u.user_id })
      if (error) {
        const missing = error.code === 'PGRST202' || /admin_confirm_user_email/.test(error.message || '')
        throw new Error(missing ? 'в базе не применена миграция 20261002_admin_email_confirmation' : error.message)
      }
      await fetchUsers({ silent: true })
      notify('ok', 'Почта подтверждена — пользователь может войти')
    } catch (err) {
      notify('err', 'Ошибка: ' + err.message)
    }
  }

  // Отвязать от СУ-10: связь снята, сессии СУ-10 закрыты сразу; следующий вход — снова заявка.
  const handleUnlinkSso = async (u) => {
    if (!window.confirm(`Отвязать ${u.full_name || u.email} от учётки СУ-10? Вход закроется, следующий вход придёт заявкой.`)) return
    try {
      await identityAdmin.unlink(u.user_id)
      notify('ok', 'Связь с СУ-10 снята')
      loadSsoLinks()
    } catch (err) {
      notify('err', err.message || 'Не удалось отвязать')
    }
  }

  const handleResetPassword = async (u) => {
    if (!window.confirm(`Выдать ${u.email || 'пользователю'} временный пароль? Прежний пароль перестанет действовать, все его сессии закроются.`)) return
    try {
      const { temporaryPassword } = await adminResetPassword(u.user_id)
      setTempPassword({ email: u.email || '', password: temporaryPassword })
    } catch (err) {
      notify('err', 'Ошибка: ' + err.message)
    }
  }

  const handleDeleteUser = async (u) => {
    if (!u.user_id) return
    if (!window.confirm(`Полностью удалить пользователя ${u.email || ''}? Это действие необратимо: пользователь будет удалён из системы и больше не сможет войти.`)) return
    try {
      const { error } = await db.rpc('admin_delete_user', { target_user_id: u.user_id })
      if (error) {
        if (/function .* does not exist/i.test(error.message)) {
          alert('RPC admin_delete_user не найдена в БД. Применяю частичное удаление: убирается роль (запись в user_roles), но запись в auth.users останется. Чтобы удалять полностью — примените миграцию 20260507_admin_delete_user_function.sql.')
          const { error: delError } = await db.from('user_roles').delete().eq('user_id', u.user_id)
          if (delError) throw delError
        } else { throw error }
      }
      await fetchUsers({ silent: true })
      notify('ok', 'Пользователь удалён')
    } catch (err) {
      notify('err', 'Ошибка удаления: ' + err.message)
    }
  }

  // Единое сохранение из drawer (контакты + роль + объект + статус).
  const saveUserFromDrawer = async (form) => {
    const u = editUser
    const objectIds = Array.isArray(form.object_ids) ? form.object_ids : []
    const payload = {
      full_name: form.full_name,
      work_phone: form.work_phone,
      work_email: form.work_email,
      role: form.role,
      object_ids: objectIds,
      // Держим старую одиночную колонку в синхроне (первый объект) — на случай отката.
      object_id: objectIds[0] || null,
      counterparty_id: form.counterparty_id || null,
      ...statusPatch(form.status, userProfile?.full_name || null),
    }
    // Статус не меняли — не перезаписываем, кто и когда заблокировал.
    if (form.status === userStatus(u)) {
      delete payload.blocked_at
      delete payload.blocked_by_name
    }
    // Запись с мягкой деградацией: если колонки object_ids ещё нет (миграция
    // 20260730 не применена, код ошибки 42703), повторяем без неё — чтобы правка
    // имени/роли/статуса не блокировалась. Тогда сохранится одиночный object_id.
    const run = (p) => u.has_role
      ? db.from('user_roles').update(p).eq('user_id', u.user_id)
      : db.from('user_roles').insert([{ user_id: u.user_id, email: u.email, ...p }])
    let { error } = await run(payload)
    if (isBlockColumnMissing(error)) {
      // Без колонок блокировки сохраняем остальное; «заблокировать» так не выйдет.
      const { is_blocked: _b, blocked_at: _ba, blocked_by_name: _bb, ...rest } = payload
      void _b; void _ba; void _bb
      ;({ error } = await run(rest))
      if (!error && form.status === 'blocked') throw new Error(BLOCK_MIGRATION_HINT)
    }
    if (error && error.code === '42703') {
      const { object_ids: _drop, ...rest } = payload
      void _drop
      ;({ error } = await run(rest))
      if (!error) notify('err', 'Сохранено, но несколько объектов не записаны — примените миграцию 20260730')
    }
    if (error) throw error
    await fetchUsers({ silent: true })
    setEditUser(null)
    notify('ok', 'Изменения сохранены')
  }

  // ── Массовые операции (по выбранным строкам) ────────────────────────────
  // patch — целевой статус ('active' | 'blocked'), поля собирает statusPatch.
  const bulkUpdate = async (patch, successText) => {
    const ids = [...selected]
    if (ids.length === 0) return
    // Статус ('active' / 'blocked') разворачивается в набор полей; роль и объект
    // приходят готовым набором полей и пишутся как есть. Раньше они тоже шли через
    // statusPatch и вместо назначения роли снимали подтверждение у выбранных.
    const fields = typeof patch === 'string' ? statusPatch(patch, userProfile?.full_name || null) : patch
    try {
      // Обновляем только тех, у кого есть запись в user_roles (по user_id).
      const CHUNK = 100
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { error } = await db.from('user_roles').update(fields).in('user_id', ids.slice(i, i + CHUNK))
        if (error) throw error
      }
      await fetchUsers({ silent: true })
      setSelected(new Set())
      notify('ok', successText)
    } catch (err) {
      notify('err', isBlockColumnMissing(err) ? BLOCK_MIGRATION_HINT : 'Ошибка массовой операции: ' + err.message)
    }
  }

  const sectionsCount = Object.keys(SECTIONS).length
  // Имена привязанных объектов пользователя (несколько). Пустой массив = офис.
  const objectNamesFor = useMemo(() => {
    const m = new Map(objectsList.map(o => [o.id, o.name]))
    return (ids) => {
      if (!ids || ids.length === 0) return 'Офис (все объекты)'
      return ids.map(id => m.get(id) || 'Объект').join(', ')
    }
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
    const used = new Set()
    userRoles.forEach(u => {
      if (!u.object_ids || u.object_ids.length === 0) used.add('__office__')
      else u.object_ids.forEach(id => used.add(id))
    })
    const opts = [{ value: '__office__', label: 'Офис (все объекты)' }]
    objectsList.forEach(o => { if (used.has(o.id)) opts.push({ value: o.id, label: o.name }) })
    return opts
  }, [userRoles, objectsList])

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return userRoles
      .filter(u => filterRoles.length === 0 || filterRoles.includes(u.role))
      .filter(u => filterStatuses.length === 0 || filterStatuses.includes(userStatus(u)))
      .filter(u => {
        if (filterObjects.length === 0) return true
        const uObjs = (!u.object_ids || u.object_ids.length === 0) ? ['__office__'] : u.object_ids
        return uObjs.some(id => filterObjects.includes(id))
      })
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
          {ownAuth && !ssoAuth && (
            <button type="button" className="btn-primary" onClick={() => setAddUserOpen(true)}>Добавить пользователя</button>
          )}
          {ssoAuth && (
            <span className="admin-sso-hint">
              Учётки и пароли — {ssoLinks?.manageUrl
                ? <a href={ssoLinks.manageUrl} target="_blank" rel="noopener noreferrer">auth.su10.ru/manage</a>
                : 'auth.su10.ru/manage'}
            </span>
          )}
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
        <StatCard tone="cyan" value={sectionsCount} title="Групп доступа" hint="Разделов с настройкой прав"
          icon={<rect x="3" y="3" width="7" height="7" rx="1" strokeWidth="2" />} extra={<rect x="14" y="14" width="7" height="7" rx="1" strokeWidth="2" />} />
        <StatCard tone="amber" value={stats.admins} title="Администраторов" hint="С полным доступом"
          icon={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeWidth="2" />} />
      </div>

      {/* Вкладки */}
      <div className="admin-panel">
        <div className="admin-tabs">
          <button className={`admin-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>Пользователи</button>
          <button className={`admin-tab ${activeTab === 'permissions' ? 'active' : ''}`} onClick={() => setActiveTab('permissions')}>Права доступа</button>
          {ssoAuth && (isAdmin || isSuperAdmin) && (
            <button className={`admin-tab ${activeTab === 'requests' ? 'active' : ''}`} onClick={() => setActiveTab('requests')}>
              Заявки на доступ{pendingRequests > 0 && <span className="admin-tab-count">{pendingRequests}</span>}
            </button>
          )}
          {/* Ключи выдаёт только администратор — так же проверяет сервер (server/osp-api/src/routes/apiKeys.js). */}
          {(isAdmin || isSuperAdmin) && (
            <button className={`admin-tab ${activeTab === 'api' ? 'active' : ''}`} onClick={() => setActiveTab('api')}>Доступ к API</button>
          )}
          {(isAdmin || isSuperAdmin) && !ssoAuth && (
            <button className={`admin-tab ${activeTab === 'signups' ? 'active' : ''}`} onClick={() => setActiveTab('signups')}>Регистрации подрядчиков</button>
          )}
        </div>

        {/* ===== Заявки на доступ (вход через СУ-10) ===== */}
        {activeTab === 'requests' && ssoAuth && (isAdmin || isSuperAdmin) && (
          <div className="admin-tabpane">
            <IdentityRequestsTab
              roleOptions={roleOptionsForForm} objectOptions={objectsList} counterpartyOptions={counterpartiesList}
              onNeedCounterparties={ensureCounterparties} users={userRoles} isSuperAdmin={isSuperAdmin} notify={notify}
              onChanged={() => { fetchUsers({ silent: true }); loadSsoLinks() }} onPendingCount={setPendingRequests}
            />
          </div>
        )}

        {/* ===== Доступ к API ===== */}
        {activeTab === 'api' && (isAdmin || isSuperAdmin) && (
          <div className="admin-tabpane">
            <ApiKeysTab notify={notify} />
          </div>
        )}

        {/* ===== Регистрации подрядчиков ===== */}
        {activeTab === 'signups' && (isAdmin || isSuperAdmin) && !ssoAuth && (
          <div className="admin-tabpane">
            <ContractorSignupsTab notify={notify} />
          </div>
        )}

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
                <select className="bulk-select" defaultValue="" onChange={(e) => { const v = e.target.value; if (v) { const ids = v === '__office__' ? [] : [v]; bulkUpdate({ object_ids: ids, object_id: ids[0] || null }, 'Объект изменён'); e.target.value = '' } }}>
                  <option value="">Задать объект…</option>
                  <option value="__office__">Офис (все объекты)</option>
                  {objectsList.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <button type="button" className="btn-soft" onClick={() => bulkUpdate('blocked', 'Пользователи заблокированы')}>Заблокировать</button>
                <button type="button" className="btn-soft" onClick={() => bulkUpdate('active', 'Пользователи разблокированы')}>Разблокировать</button>
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
                      <button type="button" className="btn-secondary" onClick={() => fetchUsers()}>Повторить</button>
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
                                {ssoAuth && (
                                  <span className={`user-cell-sso ${ssoLinked.has(u.user_id) ? 'is-linked' : ''}`}
                                    title={ssoLinked.has(u.user_id) ? 'Входит через СУ-10' : 'Не связан с учёткой СУ-10 — войти не сможет, пока заявку не привяжут'}>
                                    СУ-10: {ssoLinked.has(u.user_id) ? 'связан' : 'нет'}
                                  </span>
                                )}
                                {u.email_confirmed_at === null && (
                                  <span className="user-cell-unconfirmed" title="Пользователь не перешёл по ссылке из письма (или ссылка не сработала). Подтвердить можно в меню «Ещё».">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
                                    e-mail не подтверждён
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="col-role"><RoleBadge roleKey={u.role} label={roleLabels[u.role]} /></td>
                          <td className="col-obj" title={objectNamesFor(u.object_ids)}>{objectNamesFor(u.object_ids)}</td>
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
                                onSetStatus={(next) => setUserStatus(u, next)}
                                onConfirmEmail={u.email_confirmed_at === null ? () => handleConfirmEmail(u) : null}
                                onResetPassword={ownAuth && !ssoAuth ? () => handleResetPassword(u) : null}
                                onUnlinkSso={ssoAuth && ssoLinked.has(u.user_id) && (isSuperAdmin || u.role !== 'admin') ? () => handleUnlinkSso(u) : null}
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

        {/* ===== Права доступа: роли, права по разделам, просмотр от имени роли ===== */}
        {activeTab === 'permissions' && (
          <div className="admin-tabpane">
            <AccessRightsTab objects={objectsList} counterparties={counterpartiesList} onNeedCounterparties={ensureCounterparties} />
          </div>
        )}
      </div>

      {editUser && (
        <UserEditDrawer
          user={editUser}
          roleOptions={roleOptionsFor(editUser)}
          objectOptions={objectsList}
          counterpartyOptions={counterpartiesList}
          onClose={() => setEditUser(null)}
          onSave={saveUserFromDrawer}
        />
      )}

      {addUserOpen && (
        <AddUserDrawer
          roleOptions={roleOptionsForForm}
          onClose={() => setAddUserOpen(false)}
          onCreated={({ user, temporaryPassword }) => {
            setAddUserOpen(false)
            setTempPassword({ email: user.email, password: temporaryPassword })
            fetchUsers({ silent: true })
          }}
        />
      )}

      {tempPassword && (
        <TemporaryPasswordDialog email={tempPassword.email} password={tempPassword.password} onClose={() => setTempPassword(null)} />
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
