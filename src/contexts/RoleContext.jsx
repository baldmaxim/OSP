import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../supabase'

// security fix: понятное сообщение при невозможности загрузить права (fail-closed).
const ROLE_LOAD_ERROR = 'Не удалось загрузить права доступа. Обновите страницу или обратитесь к администратору.'

const RoleContext = createContext()

// Роли сотрудников
export const ROLES = {
  ADMIN: 'admin',
  ENGINEER: 'engineer',
  ECONOMIST: 'economist',
  LAWYER: 'lawyer',
  CONSTRUCTION_MANAGER: 'construction_manager',
  CONTRACTOR: 'contractor'
}

export const ROLE_LABELS = {
  admin: 'Администратор',
  engineer: 'Инженер ОСП',
  economist: 'Экономист ОСП',
  lawyer: 'Юрист ОСП',
  construction_manager: 'Руководитель строительства',
  contractor: 'Подрядчик'
}

// Email суперадминов — автоподтверждение и роль admin без ожидания.
const SUPER_ADMINS = ['sadovnikov.d.y@su10.ru']

// Разделы приложения
export const SECTIONS = {
  objects: 'Объекты',
  contacts: 'Контакты',
  counterparties: 'Контрагенты',
  tenders: 'Тендеры',
  contracts: 'Договоры',
  // task 333: реестр заявок на ДС — отдельный раздел с настраиваемыми правами.
  dc_requests: 'Заявка на ДС',
  bsm: 'БСМ',
  analysis_kp: 'Анализ КП',
  // task 356: реестр расценок — общий список расценок из всех источников (КП, ДП/ДС, снабжение).
  rates_registry: 'Реестр расценок',
  acceptance: 'Приёмка',
  reports: 'Отчёты',
  admin: 'Администрирование'
}

export function RoleProvider({ children }) {
  // security fix (fail-closed): роль НЕ берём из localStorage как источник истины —
  // только из Supabase после успешной проверки. Init = null, доступ закрыт, пока роль
  // не подтверждена БД. localStorage используется лишь как подсказка для восстановления
  // вида подрядчика (захватываем её в ref ДО того, как persist-эффект перезапишет ключ).
  const initialSavedRole = useRef(localStorage.getItem('userRole'))
  const [role, setRole] = useState(null)
  const [contractorInfo, setContractorInfo] = useState(() => {
    const saved = localStorage.getItem('contractorInfo')
    return saved ? JSON.parse(saved) : null
  })
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  // security fix: ошибка загрузки роли/прав → fail-closed (экран ошибки, НЕ admin).
  const [roleError, setRoleError] = useState(null)
  const [permissions, setPermissions] = useState({}) // { section: { can_view, can_edit } }
  const [userProfile, setUserProfile] = useState({ full_name: '' })
  // Динамический справочник ролей из БД (таблица roles)
  const [availableRoles, setAvailableRoles] = useState([])

  const fetchAvailableRoles = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('roles')
        .select('key, label, is_system')
        .order('is_system', { ascending: false })
        .order('label', { ascending: true })
      if (error) throw error
      setAvailableRoles(data || [])
    } catch (err) {
      console.warn('Не удалось загрузить справочник ролей (таблица roles?):', err.message)
      // Фоллбэк: используем встроенные ROLE_LABELS
      setAvailableRoles(Object.entries(ROLE_LABELS).map(([key, label]) => ({
        key, label, is_system: true
      })))
    }
  }, [])

  useEffect(() => {
    fetchAvailableRoles()
  }, [fetchAvailableRoles])

  // Сводный лейбл-маппинг: динамический из БД + статический фоллбэк
  const dynamicRoleLabels = availableRoles.reduce((acc, r) => {
    acc[r.key] = r.label
    return acc
  }, { ...ROLE_LABELS })

  // Загрузить права для роли. Возвращает true при успехе, false при ошибке —
  // вызывающий сам решает, что делать (fail-closed для не-админа).
  const fetchPermissions = useCallback(async (userRole) => {
    if (!userRole || userRole === ROLES.CONTRACTOR) {
      setPermissions({})
      return true
    }
    try {
      const { data, error } = await supabase
        .from('role_permissions')
        .select('section, can_view, can_edit')
        .eq('role', userRole)

      if (error) throw error

      const perms = {}
      ;(data || []).forEach(p => {
        perms[p.section] = { can_view: p.can_view, can_edit: p.can_edit }
      })
      setPermissions(perms)
      return true
    } catch (err) {
      console.error('Ошибка загрузки прав:', err.message)
      setPermissions({})
      return false
    }
  }, [])

  // Сбросить доступ в безопасное состояние (fail-closed). Никогда не выдаёт admin.
  const denyAccess = useCallback((message) => {
    setRole(null)
    setPermissions({})
    setUserProfile({ full_name: '' })
    if (message) setRoleError(message)
  }, [])

  // Загрузить роль пользователя из БД.
  // security fix: НИКОГДА не выдаём admin при ошибке/пустом ответе/недоступности БД.
  // admin назначается только если роль admin реально подтверждена данными из Supabase.
  const fetchUserRole = useCallback(async (userId, userEmail) => {
    const isSuperAdmin = SUPER_ADMINS.includes(userEmail?.toLowerCase())
    setRoleError(null)

    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('role, is_approved, full_name, work_phone, work_email, created_at, object_id')
        .eq('user_id', userId)
        .single()

      if (error && error.code !== 'PGRST116') throw error // PGRST116 = not found

      if (data) {
        if (!data.is_approved && isSuperAdmin) {
          // Суперадмин — автоподтверждение (требует прав записи; при RLS-блокировке
          // упадёт в catch → fail-closed, а не admin).
          await supabase
            .from('user_roles')
            .update({ is_approved: true, role: 'admin' })
            .eq('user_id', userId)
          await fetchPermissions(ROLES.ADMIN)
          setUserProfile({ full_name: data.full_name || '', work_phone: data.work_phone || '', work_email: data.work_email || '', created_at: data.created_at || '', object_id: data.object_id || null })
          setRole(ROLES.ADMIN)
          return
        }
        if (!data.is_approved) {
          await supabase.auth.signOut()
          throw new Error('PENDING_APPROVAL')
        }
        // Роль подтверждена БД. Грузим права; для НЕ-админа провал прав = fail-closed.
        const permsOk = await fetchPermissions(data.role)
        if (data.role !== ROLES.ADMIN && !permsOk) {
          denyAccess(ROLE_LOAD_ERROR)
          return
        }
        setUserProfile({ full_name: data.full_name || '', work_phone: data.work_phone || '', work_email: data.work_email || '', created_at: data.created_at || '', object_id: data.object_id || null })
        setRole(data.role)
      } else {
        if (isSuperAdmin) {
          // Суперадмин — создаём сразу подтверждённым (требует прав записи).
          await supabase
            .from('user_roles')
            .insert([{ user_id: userId, email: userEmail, role: 'admin', is_approved: true }])
          await fetchPermissions(ROLES.ADMIN)
          setRole(ROLES.ADMIN)
          return
        }
        // Обычный пользователь — заявка (pending), доступ закрыт до подтверждения админом.
        await supabase
          .from('user_roles')
          .insert([{ user_id: userId, email: userEmail, role: 'engineer', is_approved: false }])

        await supabase.auth.signOut()
        throw new Error('PENDING_APPROVAL')
      }
    } catch (err) {
      if (err.message === 'PENDING_APPROVAL') throw err
      // security fix (fail-closed): ошибка/недоступность БД/RLS → НЕ admin, а отказ.
      console.error('Ошибка загрузки роли:', err.message)
      denyAccess(ROLE_LOAD_ERROR)
    }
  }, [fetchPermissions, denyAccess])

  // Инициализация Supabase Auth
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) {
        // Восстановление вида подрядчика — по подсказке из localStorage (захвачена в ref
        // до того, как persist-эффект мог её перезаписать). Подрядчик — минимальные права.
        if (initialSavedRole.current === ROLES.CONTRACTOR) {
          setRole(ROLES.CONTRACTOR)
        } else {
          try {
            await fetchUserRole(u.id, u.email)
          } catch (err) {
            if (err.message === 'PENDING_APPROVAL') {
              setUser(null)
              denyAccess(null)
            }
          }
        }
      } else {
        denyAccess(null)
        setContractorInfo(null)
      }
      setAuthLoading(false)
    })

    // Реагируем только на ВЫХОД. Вход/обновление токена обрабатывают getSession (старт)
    // и функции входа — чтобы не сбросить authLoading в false до проверки роли (иначе
    // во время проверки могли бы отрендериться внутренние страницы с непроверенной ролью).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null
      if (!u) {
        setUser(null)
        denyAccess(null)
        setContractorInfo(null)
        setAuthLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [fetchUserRole, denyAccess])

  // Persist
  useEffect(() => {
    if (role) localStorage.setItem('userRole', role)
    else localStorage.removeItem('userRole')
  }, [role])

  useEffect(() => {
    if (contractorInfo) localStorage.setItem('contractorInfo', JSON.stringify(contractorInfo))
    else localStorage.removeItem('contractorInfo')
  }, [contractorInfo])

  // Вход сотрудника
  const loginWithPassword = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    setUser(data.user)
    await fetchUserRole(data.user.id, email)
    setContractorInfo(null)
    // Фиксируем момент входа через SECURITY DEFINER RPC — чтобы не выдавать
    // обычным пользователям прямой UPDATE на user_roles (RLS, security task).
    try {
      const { error: loginErr } = await supabase.rpc('touch_last_login')
      if (loginErr) console.error('Не удалось обновить last_login_at:', loginErr.message)
    } catch (err) {
      console.error('Не удалось обновить last_login_at:', err?.message || err)
    }
    return data
  }

  // Вход подрядчика
  const loginAsContractor = async (email, password, counterpartyId, counterpartyName) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // Для подрядчиков тоже проверяем подтверждение
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('is_approved')
      .eq('user_id', data.user.id)
      .single()

    if (roleData && !roleData.is_approved) {
      await supabase.auth.signOut()
      throw new Error('PENDING_APPROVAL')
    }
    if (!roleData) {
      // Создаём заявку
      await supabase
        .from('user_roles')
        .insert([{ user_id: data.user.id, email, role: 'engineer', is_approved: false }])
      await supabase.auth.signOut()
      throw new Error('PENDING_APPROVAL')
    }

    setUser(data.user)
    setRole(ROLES.CONTRACTOR)
    setContractorInfo({ id: counterpartyId, name: counterpartyName })
    setPermissions({})
    try {
      const { error: loginErr } = await supabase.rpc('touch_last_login')
      if (loginErr) console.error('Не удалось обновить last_login_at:', loginErr.message)
    } catch (err) {
      console.error('Не удалось обновить last_login_at:', err?.message || err)
    }
    return data
  }

  // Регистрация
  const signUp = async (email, password) => {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    return data
  }

  // Обновить профиль
  const updateProfile = async (profileData) => {
    if (!user) throw new Error('Не авторизован')
    const updates = {}
    if (profileData.full_name !== undefined) updates.full_name = profileData.full_name
    if (profileData.work_phone !== undefined) updates.work_phone = profileData.work_phone
    if (profileData.work_email !== undefined) updates.work_email = profileData.work_email

    const { error } = await supabase
      .from('user_roles')
      .update(updates)
      .eq('user_id', user.id)
    if (error) throw error
    setUserProfile(prev => ({ ...prev, ...updates }))
  }

  // Выход
  const logout = async () => {
    await supabase.auth.signOut()
    setRole(null)
    setContractorInfo(null)
    setUser(null)
    setPermissions({})
    setRoleError(null)
    setUserProfile({ full_name: '', work_phone: '', work_email: '', created_at: '' })
  }

  // Проверки
  const isAdmin = role === ROLES.ADMIN
  // Суперадмин всегда имеет доступ к админ-функциям, даже если выбрал/тестирует другую роль
  const isSuperAdmin = !!(user?.email && SUPER_ADMINS.includes(user.email.toLowerCase()))
  const isEmployee = role !== null && role !== ROLES.CONTRACTOR
  const isContractor = role === ROLES.CONTRACTOR
  const isLoggedIn = role !== null && user !== null

  // Scope доступа по объекту:
  // null  → видит все объекты (админ или офисный сотрудник без привязки)
  // uuid  → видит только этот объект
  const scopedObjectId = isAdmin ? null : (userProfile?.object_id || null)

  // Проверка прав по разделу
  // Суперадмину доступ к разделу admin предоставляется всегда, даже если он переключился на другую роль.
  const canView = (section) => {
    if (role === ROLES.ADMIN) return true
    if (section === 'admin' && user?.email && SUPER_ADMINS.includes(user.email.toLowerCase())) return true
    return permissions[section]?.can_view ?? false
  }

  const canEdit = (section) => {
    if (role === ROLES.ADMIN) return true
    if (section === 'admin' && user?.email && SUPER_ADMINS.includes(user.email.toLowerCase())) return true
    return permissions[section]?.can_edit ?? false
  }

  // Обновить права (после изменения в админке)
  const refreshPermissions = () => {
    if (role && role !== ROLES.CONTRACTOR) {
      fetchPermissions(role)
    }
  }

  return (
    <RoleContext.Provider value={{
      role,
      user,
      contractorInfo,
      permissions,
      isAdmin,
      isSuperAdmin,
      isEmployee,
      isContractor,
      isLoggedIn,
      authLoading,
      roleError,
      loginWithPassword,
      loginAsContractor,
      signUp,
      logout,
      canView,
      canEdit,
      userProfile,
      updateProfile,
      refreshPermissions,
      ROLES,
      ROLE_LABELS,
      SECTIONS,
      availableRoles,
      roleLabels: dynamicRoleLabels,
      refreshAvailableRoles: fetchAvailableRoles,
      scopedObjectId
    }}>
      {children}
    </RoleContext.Provider>
  )
}

export function useRole() {
  const context = useContext(RoleContext)
  if (!context) {
    throw new Error('useRole must be used within a RoleProvider')
  }
  return context
}
