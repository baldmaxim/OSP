// Фейковый RoleContext стенда: без Supabase Auth и без загрузки прав.
//
// Подменяется esbuild-плагином (build.mjs), поэтому все компоненты, которые
// зовут useRole(), получают это значение. По умолчанию — администратор со всеми
// правами; роль и объекты меняются параметрами адреса:
//   ?role=engineer      — эффективная роль (права всё равно полные, кроме admin);
//   ?readonly=1         — всё только на просмотр (canEdit → false);
//   ?scoped=obj-1,obj-2 — руководитель строительства со своими объектами.
import { createContext, useContext, useMemo } from 'react'

export const ROLES = {
  ADMIN: 'admin',
  ENGINEER: 'engineer',
  ECONOMIST: 'economist',
  LAWYER: 'lawyer',
  CONSTRUCTION_MANAGER: 'construction_manager',
  CONTRACTOR: 'contractor',
}

export const ROLE_LABELS = {
  admin: 'Администратор',
  engineer: 'Инженер ОСП',
  economist: 'Экономист ОСП',
  lawyer: 'Юрист ОСП',
  construction_manager: 'Руководитель строительства',
  contractor: 'Подрядчик',
}

export const SECTIONS = {
  objects: 'Объекты',
  contacts: 'Контакты',
  counterparties: 'Контрагенты',
  general_documents: 'Документы',
  tasks: 'Задачи',
  tenders: 'Тендеры',
  vors: 'ВОРы и РД',
  tenders_materials: 'Тендеры на материалы',
  contracts: 'Договоры',
  dc_requests: 'Заявка на ДС',
  doc_check_requests: 'Заявки на проверку ДП/ДС',
  analysis_kp: 'Анализ КП',
  rates_registry: 'Реестр расценок',
  reports: 'Отчёты',
  reports_full: 'Отчёты: все вкладки',
  admin: 'Администрирование',
}

const RoleContext = createContext(null)

function readParams() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  const role = p.get('role') || ROLES.ADMIN
  const readonly = p.get('readonly') === '1'
  const scoped = (p.get('scoped') || '').split(',').map((s) => s.trim()).filter(Boolean)
  return { role, readonly, scoped }
}

export function RoleProvider({ children }) {
  const value = useMemo(() => {
    const { role, readonly, scoped } = readParams()
    const isAdmin = role === ROLES.ADMIN
    return {
      role,
      realRole: role,
      user: { id: 'u-stand', email: 'stand@su10.ru' },
      contractorInfo: null,
      permissions: Object.fromEntries(Object.keys(SECTIONS).map((s) => [s, { view: true, edit: !readonly }])),
      isAdmin,
      isSuperAdmin: isAdmin,
      isEmployee: role !== ROLES.CONTRACTOR,
      isContractor: role === ROLES.CONTRACTOR,
      isLoggedIn: true,
      authLoading: false,
      roleError: null,
      loginWithPassword: async () => ({ error: null }),
      loginAsContractor: async () => ({ error: null }),
      signUp: async () => ({ error: null }),
      resendConfirmation: async () => ({ error: null }),
      logout: () => {},
      canView: () => true,
      canEdit: () => !readonly,
      userProfile: {
        id: 'u-stand',
        full_name: 'Крюкова Юлия Денисовна',
        position: 'Инженер ОСП',
        email: 'stand@su10.ru',
        phone: '+7 (495) 120-10-10, доб. 118',
      },
      updateProfile: async () => ({ error: null }),
      refreshPermissions: async () => {},
      ROLES,
      ROLE_LABELS,
      SECTIONS,
      availableRoles: Object.keys(ROLE_LABELS),
      roleLabels: ROLE_LABELS,
      refreshAvailableRoles: async () => {},
      scopedObjectIds: scoped,
      canPreviewRoles: isAdmin,
      previewActive: false,
      previewRole: null,
      previewInfo: null,
      startRolePreview: () => {},
      stopRolePreview: () => {},
    }
  }, [])

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole() {
  const ctx = useContext(RoleContext)
  if (!ctx) throw new Error('useRole must be used within a RoleProvider')
  return ctx
}
