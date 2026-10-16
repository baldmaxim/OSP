// Подмена RoleContext для стенда карточки тендера (стабильные ссылки, как в настоящем контексте).
// Константы — настоящие, чтобы подделка не отставала от кода.
export { ROLES, ROLE_LABELS, SECTIONS } from '../../../src/contexts/roleConstants.js'
// ?canEdit=0 — пользователь без права правки (только просмотр).
const READ_ONLY = new URLSearchParams(window.location.search).get('canEdit') === '0'
const ROLE = {
  role: READ_ONLY ? 'engineer' : 'admin',
  isAdmin: !READ_ONLY,
  isSuperAdmin: false,
  isEmployee: true,
  isContractor: false,
  isLoggedIn: true,
  canEdit: () => !READ_ONLY,
  user: { id: 'user-1', email: 'test@example.invalid' },
  canView: () => true,
  scopedObjectIds: [],
  userProfile: { full_name: 'Тест' },
}

export function useRole() {
  return ROLE
}

export function RoleProvider({ children }) {
  return children
}
