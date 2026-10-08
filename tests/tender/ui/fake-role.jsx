// Подмена RoleContext для стенда карточки тендера (стабильные ссылки, как в настоящем контексте).
// Константы — настоящие, чтобы подделка не отставала от кода.
export { ROLES, ROLE_LABELS, SECTIONS } from '../../../src/contexts/roleConstants.js'
const ROLE = {
  role: 'admin',
  isAdmin: true,
  isSuperAdmin: false,
  isEmployee: true,
  isContractor: false,
  isLoggedIn: true,
  canEdit: () => true,
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
