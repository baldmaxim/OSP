// Подмена RoleContext для стенда карточки тендера (стабильные ссылки, как в настоящем контексте).
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
