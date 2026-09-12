import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  // task 416: общие документы компании и полезные ссылки (Общая информация → Документы).
  general_documents: 'Документы',
  // task 433: задачи сотрудникам (канбан-доска + реестр).
  tasks: 'Задачи',
  tenders: 'Тендеры',
  contracts: 'Договоры',
  // task 333: реестр заявок на ДС — отдельный раздел с настраиваемыми правами.
  dc_requests: 'Заявка на ДС',
  // Канбан проверки договоров и допсоглашений (раньше велась перепиской по почте).
  doc_check_requests: 'Заявки на проверку ДП/ДС',
  analysis_kp: 'Анализ КП',
  // task 356: реестр расценок — общий список расценок из всех источников (КП, ДП/ДС, снабжение).
  rates_registry: 'Реестр расценок',
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

  // ── Режим «посмотреть глазами роли» (только для администратора) ──────────
  // Администратору нужно проверять, что видит инженер, юрист или подрядчик, не
  // заводя себе отдельные учётки. Храним в sessionStorage: режим переживает
  // перезагрузку страницы (иначе не посмотреть, что при входе видит роль), но
  // не тянется в другие вкладки и не остаётся навсегда.
  //
  // ВАЖНО: это предпросмотр ИНТЕРФЕЙСА. Запросы по-прежнему идут под реальным
  // пользователем, поэтому ограничения самой базы (RLS) остаются администраторскими:
  // режим показывает меню, разделы и кнопки роли, а не её доступ к строкам БД.
  const [preview, setPreview] = useState(() => {
    try {
      const saved = sessionStorage.getItem('rolePreview')
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })

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
  // Привязанные объекты сотрудника: массив object_ids, с откатом на одиночный
  // object_id (если миграция ещё не применена). Пустой массив = офис (видит всё).
  const resolveObjectIds = (row) => {
    if (Array.isArray(row?.object_ids) && row.object_ids.length) return row.object_ids
    if (row?.object_id) return [row.object_id]
    return []
  }

  const fetchUserRole = useCallback(async (userId, userEmail) => {
    const isSuperAdmin = SUPER_ADMINS.includes(userEmail?.toLowerCase())
    setRoleError(null)

    try {
      // select('*') — устойчиво к порядку миграций: колонка object_ids появляется
      // только после миграции 20260730; если её ещё нет, просто отсутствует в data,
      // а resolveObjectIds() откатывается на одиночный object_id. Так вход не ломается.
      const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .eq('user_id', userId)
        .single()

      if (error && error.code !== 'PGRST116') throw error // PGRST116 = not found

      if (data) {
        if (isSuperAdmin) {
          // Суперадмин всегда admin. Чиним дрейф роли/is_approved в БД, если он есть
          // (суперадмина пропускает RLS через is_admin() по email), и автоподтверждаем.
          // При RLS-блокировке update упадёт в catch → fail-closed, а не admin.
          if (data.role !== ROLES.ADMIN || !data.is_approved) {
            await supabase
              .from('user_roles')
              .update({ is_approved: true, role: 'admin' })
              .eq('user_id', userId)
          }
          await fetchPermissions(ROLES.ADMIN)
          setUserProfile({ full_name: data.full_name || '', work_phone: data.work_phone || '', work_email: data.work_email || '', created_at: data.created_at || '', object_ids: resolveObjectIds(data) })
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
        setUserProfile({ full_name: data.full_name || '', work_phone: data.work_phone || '', work_email: data.work_email || '', created_at: data.created_at || '', object_ids: resolveObjectIds(data) })
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

  // Организация подрядчика берётся ТОЛЬКО из базы: user_roles.counterparty_id —
  // это та же привязка, по которой работает RLS согласования договоров
  // (миграция 20260815). Раньше кабинет доверял выбору из списка на странице
  // входа и подсказке localStorage, то есть любой подрядчик мог открыть чужие
  // тендеры, выбрав другую организацию.
  const resolveContractorCounterparty = useCallback(async (userId) => {
    const { data, error } = await supabase
      .from('user_roles')
      .select('is_approved, counterparty_id')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    if (!data) return { row: null, counterparty: null }
    if (!data.counterparty_id) return { row: data, counterparty: null }
    const { data: cp } = await supabase
      .from('counterparties')
      .select('id, name')
      .eq('id', data.counterparty_id)
      .maybeSingle()
    return {
      row: data,
      counterparty: cp ? { id: cp.id, name: cp.name } : { id: data.counterparty_id, name: 'Организация' },
    }
  }, [])

  // Инициализация Supabase Auth
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) {
        // Восстановление вида подрядчика — по подсказке из localStorage (захвачена в ref
        // до того, как persist-эффект мог её перезаписать). Подрядчик — минимальные права.
        if (initialSavedRole.current === ROLES.CONTRACTOR) {
          // Подсказка localStorage говорит только «это был кабинет подрядчика».
          // Кто именно — спрашиваем у базы: значение в localStorage правится руками.
          try {
            const { row, counterparty } = await resolveContractorCounterparty(u.id)
            if (row && row.is_approved && counterparty) {
              setRole(ROLES.CONTRACTOR)
              setContractorInfo(counterparty)
            } else if (row && !row.counterparty_id) {
              // Логин оказался сотрудником — восстанавливаем как сотрудника.
              await fetchUserRole(u.id, u.email)
            } else {
              denyAccess(null)
              setContractorInfo(null)
            }
          } catch (err) {
            console.error('Не удалось восстановить кабинет подрядчика:', err.message)
            denyAccess(ROLE_LOAD_ERROR)
            setContractorInfo(null)
          }
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
  }, [fetchUserRole, denyAccess, resolveContractorCounterparty])

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

  // Вход подрядчика. Организацию НЕ принимаем от клиента — берём привязку логина
  // из user_roles.counterparty_id: иначе достаточно было выбрать в списке чужую
  // компанию, чтобы увидеть её тендеры и сметы.
  const loginAsContractor = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error

    const { row, counterparty } = await resolveContractorCounterparty(data.user.id)

    if (!row) {
      // Создаём заявку
      await supabase
        .from('user_roles')
        .insert([{ user_id: data.user.id, email, role: 'engineer', is_approved: false }])
      await supabase.auth.signOut()
      throw new Error('PENDING_APPROVAL')
    }
    if (!row.is_approved) {
      await supabase.auth.signOut()
      throw new Error('PENDING_APPROVAL')
    }
    if (!counterparty) {
      // Логин подтверждён, но не привязан к организации — кабинет показывать не от
      // чьего имени. Привязку ставит администратор в карточке пользователя.
      await supabase.auth.signOut()
      throw new Error('NO_COUNTERPARTY')
    }

    setUser(data.user)
    setRole(ROLES.CONTRACTOR)
    setContractorInfo(counterparty)
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
    // Предпросмотр роли — состояние сессии администратора, при выходе снимаем.
    setPreview(null)
    setRole(null)
    setContractorInfo(null)
    setUser(null)
    setPermissions({})
    setRoleError(null)
    setUserProfile({ full_name: '', work_phone: '', work_email: '', created_at: '' })
  }

  // ── Предпросмотр роли ────────────────────────────────────────────────────
  // Реальные права (по ним решаем, можно ли вообще включать режим и кто может
  // из него выйти) — считаются ДО подмены.
  const realIsAdmin = role === ROLES.ADMIN
  const realIsSuperAdmin = !!(user?.email && SUPER_ADMINS.includes(user.email.toLowerCase()))
  const canPreviewRoles = realIsAdmin || realIsSuperAdmin
  // Режим считается активным, только если его включил тот, кому это разрешено:
  // подложенный в sessionStorage ключ сам по себе прав не меняет (он их только
  // сужает, но проверка всё равно нужна — иначе режим «залипнет» у обычного
  // сотрудника, открывшего вкладку после админа).
  const previewActive = !!preview && canPreviewRoles

  useEffect(() => {
    try {
      if (previewActive) sessionStorage.setItem('rolePreview', JSON.stringify(preview))
      else sessionStorage.removeItem('rolePreview')
    } catch { /* приватный режим браузера — не критично */ }
  }, [preview, previewActive])

  // Включить предпросмотр: грузим права выбранной роли из той же таблицы, что и
  // при обычном входе, — иначе «как видит роль» расходилось бы с реальностью.
  const startRolePreview = useCallback(async (previewRoleKey, options = {}) => {
    if (!canPreviewRoles) throw new Error('Режим доступен только администратору')
    if (!previewRoleKey) throw new Error('Не выбрана роль')
    let perms = {}
    if (previewRoleKey !== ROLES.CONTRACTOR && previewRoleKey !== ROLES.ADMIN) {
      const { data, error } = await supabase
        .from('role_permissions')
        .select('section, can_view, can_edit')
        .eq('role', previewRoleKey)
      if (error) throw error
      ;(data || []).forEach(pRow => {
        perms[pRow.section] = { can_view: pRow.can_view, can_edit: pRow.can_edit }
      })
    }
    setPreview({
      role: previewRoleKey,
      permissions: perms,
      // Привязка к объектам: у руководителя строительства от неё зависит половина
      // интерфейса, поэтому её тоже можно смоделировать.
      objectIds: Array.isArray(options.objectIds) ? options.objectIds : [],
      // Для подрядчика нужна организация — под неё фильтруется весь кабинет.
      counterparty: options.counterparty || null,
      startedAt: new Date().toISOString(),
    })
  }, [canPreviewRoles])

  const stopRolePreview = useCallback(() => setPreview(null), [])

  // Проверки. Всё, что ниже, работает с ЭФФЕКТИВНОЙ ролью: в режиме
  // предпросмотра интерфейс должен вести себя ровно как у выбранной роли.
  const effectiveRole = previewActive ? preview.role : role
  const effectivePermissions = previewActive ? preview.permissions : permissions
  const isAdmin = effectiveRole === ROLES.ADMIN
  // Суперадмин всегда имеет доступ к админ-функциям — но не в режиме
  // предпросмотра: иначе «Администрирование» осталось бы видно у любой роли и
  // проверить меню было бы нельзя.
  const isSuperAdmin = realIsSuperAdmin && !previewActive
  const isEmployee = effectiveRole !== null && effectiveRole !== ROLES.CONTRACTOR
  const isContractor = effectiveRole === ROLES.CONTRACTOR
  const isLoggedIn = effectiveRole !== null && user !== null

  // Scope доступа по объектам:
  // []            → видит все объекты (админ или офисный сотрудник без привязки)
  // [uuid, ...]   → видит только перечисленные объекты
  // Мемоизируем: массив кладётся в зависимости useEffect потребителей, а новая
  // ссылка каждый рендер вызвала бы циклы перезапросов.
  const scopedObjectIds = useMemo(
    () => {
      if (previewActive) return preview.role === ROLES.ADMIN ? [] : (preview.objectIds || [])
      return isAdmin ? [] : (userProfile?.object_ids || [])
    },
    [previewActive, preview, isAdmin, userProfile?.object_ids]
  )

  // Проверка прав по разделу
  // Суперадмину доступ к разделу admin предоставляется всегда, даже если он переключился на другую роль.
  const canView = (section) => {
    if (effectiveRole === ROLES.ADMIN) return true
    if (section === 'admin' && isSuperAdmin) return true
    return effectivePermissions[section]?.can_view ?? false
  }

  const canEdit = (section) => {
    if (effectiveRole === ROLES.ADMIN) return true
    if (section === 'admin' && isSuperAdmin) return true
    return effectivePermissions[section]?.can_edit ?? false
  }

  // Обновить права (после изменения в админке)
  const refreshPermissions = () => {
    if (role && role !== ROLES.CONTRACTOR) {
      fetchPermissions(role)
    }
  }

  return (
    <RoleContext.Provider value={{
      role: effectiveRole,
      user,
      // В предпросмотре подрядчика кабинет фильтруется по выбранной организации.
      contractorInfo: previewActive && preview.role === ROLES.CONTRACTOR
        ? preview.counterparty
        : contractorInfo,
      permissions: effectivePermissions,
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
      scopedObjectIds,
      // Режим «посмотреть глазами роли»
      realRole: role,
      canPreviewRoles,
      previewActive,
      previewRole: previewActive ? preview.role : null,
      previewInfo: previewActive ? preview : null,
      startRolePreview,
      stopRolePreview
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
