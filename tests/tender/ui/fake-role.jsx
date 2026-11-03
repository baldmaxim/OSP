// Подмена RoleContext для стенда карточки тендера (стабильные ссылки, как в настоящем контексте).
// Константы — настоящие, чтобы подделка не отставала от кода.
export { ROLES, ROLE_LABELS, SECTIONS } from '../../../src/contexts/roleConstants.js'
import { ROLE_LABELS } from '../../../src/contexts/roleConstants.js'
// ?canEdit=0 — пользователь без права правки (только просмотр).
// ?asRole=<ключ> — вошедший с этой ролью вместо администратора (например udorojanie — «Отдел по удорожанию»),
// ?asUser=<id> — его id (по умолчанию user-1).
// ?noView=contracts,dc_requests — разделы без права просмотра.
// window.__fakeRole — своя роль стенда (кабинет подрядчика, tests/tender/ui/cabinet-seed.js).
const PARAMS = new URLSearchParams(window.location.search)
const READ_ONLY = PARAMS.get('canEdit') === '0'
const AS_ROLE = PARAMS.get('asRole')
const NO_VIEW = new Set((PARAMS.get('noView') || '').split(',').filter(Boolean))
const ROLE = window.__fakeRole || {
  role: AS_ROLE || (READ_ONLY ? 'engineer' : 'admin'),
  isAdmin: !AS_ROLE && !READ_ONLY,
  isSuperAdmin: false,
  isEmployee: true,
  isContractor: false,
  isLoggedIn: true,
  canEdit: () => !READ_ONLY,
  user: { id: PARAMS.get('asUser') || 'user-1', email: 'test@example.invalid' },
  canView: (section) => !NO_VIEW.has(section),
  scopedObjectIds: [],
  userProfile: { full_name: 'Тест' },
  // Запоминает, что ушло бы на сервер (стенд /stand/add-user).
  adminCreateUser: async (user) => {
    window.__createdUsers = [...(window.__createdUsers || []), user]
    return { user, temporaryPassword: 'temp' }
  },
  // Названия ролей из таблицы roles (как roleLabels настоящего контекста): заведённые администратором роли.
  roleLabels: { ...ROLE_LABELS, supply: 'Снабжение', smetno: 'Сметно-технический отдел', udorojanie: 'Отдел по удорожанию' },
  // Стенд /stand/access-rights: справочник — из window.__fakeDb.roles, просмотр от имени роли запоминается.
  availableRoles: [],
  refreshAvailableRoles: async () => { syncRoles() },
  canPreviewRoles: true,
  previewActive: false,
  previewInfo: null,
  startRolePreview: async (role, options) => {
    if (role === 'fails') throw new Error('Не удалось загрузить права роли')
    window.__rolePreview = { role, ...options }
  },
  stopRolePreview: () => {},
}

function syncRoles() {
  const rows = window.__fakeDb?.roles || []
  ROLE.availableRoles = rows
  ROLE.roleLabels = { ...ROLE.roleLabels, ...Object.fromEntries(rows.map(r => [r.key, r.label])) }
}

export function useRole() {
  if (window.__fakeDb?.roles && !ROLE.availableRoles.length) syncRoles()
  return ROLE
}

export function RoleProvider({ children }) {
  return children
}
